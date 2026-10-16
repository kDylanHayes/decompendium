import { existsSync, readFileSync } from "node:fs";
import { normalizeRepo, readCatalog, type Config, type Project } from "../catalog.ts";
import type { GitHub } from "../ingest/http.ts";
import { StopRunError } from "../ingest/types.ts";
import { fetchFacts, type RepoFacts } from "./facts.ts";
import { MIN_PRIORITY, priority, searchCandidates, type Candidate } from "./search.ts";
import { assess, TOOL_WORDS, toolText, type Assessment } from "./signals.ts";

export interface DiscoverState {
  schema: 1;
  updated_at: string | null;
  repos: Record<string, { pushed_at: string | null; checked_at: string; assessment: Assessment }>;
}

export interface DiscoverOptions {
  root: string;
  github: GitHub;
  state?: DiscoverState;
  limit?: number; // most repos to fetch facts for in one run
  recheckDays?: number;
  now?: Date;
  log?: (line: string) => void;
  sleep?: (ms: number) => Promise<void>;
  search?: () => Promise<Map<string, Candidate>>; // injectable for tests
  facts?: (fullName: string) => Promise<RepoFacts | null>;
}

/**
 * Version codes a repo builds: decomp-toolkit config dirs and objdiff report
 * artifact names (config/GALE01/build.sha1, GALE01_report → "gale01").
 */
export function versionCodes(a: { hashEvidence: string[]; reportArtifacts: string[] }): string[] {
  const codes = new Set<string>();
  for (const p of a.hashEvidence) {
    const m = /^config\/([^/]+)\/build\.sha1$/.exec(p);
    if (m) codes.add(m[1]!.toLowerCase());
  }
  for (const r of a.reportArtifacts) {
    const m = /^(.+)_report$/.exec(r);
    if (m && !/^(us|jp|eu|usa|eur|pal|ntsc)$/i.test(m[1]!)) codes.add(m[1]!.toLowerCase());
  }
  return [...codes];
}

export interface Suggestion extends Assessment {
  /** Listed projects that already build one of this repo's versions (the fork rule, POLICY.md 3). */
  overlaps: string[];
}

export interface DiscoverResult {
  state: DiscoverState;
  candidates: Map<string, Candidate>;
  skipped: Record<string, string>; // lowercased name → reason
  assessed: Map<string, Assessment>; // this run and cached, for every candidate that got that far
  suggestions: Suggestion[]; // likely or possible, not listed yet, best first
  pending: number; // candidates left for a later run (limit or rate limit)
  stopped: string | null;
}

const DAY_MS = 86_400_000;

/** Cheap checks on search results, before spending API calls on facts. */
export function prefilter(c: Candidate, listed: Set<string>, optedOut: Set<string>): string | null {
  const key = `https://github.com/${c.fullName}`.toLowerCase();
  if (listed.has(key)) return "already listed";
  if (optedOut.has(key)) return "opted out";
  // Most forks are copies; keep the ones people have starred, which are often the active project.
  if (c.fork && (c.stars ?? 0) < 3) return "fork";
  if (c.sizeKb === 0) return "empty";
  const tool = TOOL_WORDS.exec(toolText(c.fullName, c.description, c.topics));
  if (tool) return `tool: ${tool[0]}`;
  return null;
}

export function emptyState(): DiscoverState {
  return { schema: 1, updated_at: null, repos: {} };
}

export function readState(path: string): DiscoverState {
  return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as DiscoverState) : emptyState();
}

/**
 * Find repositories that look like matching decomps and are not in the catalog.
 * Nothing is added anywhere: the result is a list for a maintainer to review.
 */
export async function runDiscover(opts: DiscoverOptions): Promise<DiscoverResult> {
  const now = opts.now ?? new Date();
  const log = opts.log ?? (() => {});
  const state = opts.state ?? emptyState();
  const recheck = (opts.recheckDays ?? 30) * DAY_MS;

  const raw = readCatalog(opts.root);
  const config = raw.config!.data as Config;
  const listed = new Set(raw.projects.map((p) => normalizeRepo((p.data as Project).repo)));
  // Version codes of listed objdiff targets, e.g. "gale01" → "melee".
  const listedCodes = new Map<string, string>();
  for (const { data } of raw.projects) {
    const project = data as Project;
    for (const t of project.targets) {
      const source = t.progress && t.progress.kind !== "none" ? t.progress.source : null;
      if (source?.type === "github-artifact") {
        for (const code of versionCodes({ hashEvidence: [], reportArtifacts: [source.artifact] })) listedCodes.set(code, project.id);
      }
    }
  }
  const optedOut = new Set(config.opted_out.map(normalizeRepo));

  const candidates = await (opts.search ?? (() => searchCandidates(opts.github, { log, sleep: opts.sleep, now })))();
  const skipped: Record<string, string> = {};
  const queue: Candidate[] = [];
  for (const [key, c] of candidates) {
    const reason = prefilter(c, listed, optedOut) ?? (priority(c, now) < MIN_PRIORITY ? "low priority" : null);
    if (reason) skipped[key] = reason;
    else queue.push(c);
  }

  // Cached assessments stay valid until the repo is pushed again or they age out.
  const fresh = (c: Candidate) => {
    const cached = state.repos[c.fullName.toLowerCase()];
    return cached && cached.pushed_at === c.pushedAt && now.getTime() - Date.parse(cached.checked_at) < recheck;
  };
  const todo = queue.filter((c) => !fresh(c));
  // Strongest evidence first, then most recently pushed.
  todo.sort((a, b) => priority(b, now) - priority(a, now) || (b.pushedAt ?? "").localeCompare(a.pushedAt ?? ""));
  const budget = todo.slice(0, opts.limit ?? 400);

  const facts = opts.facts ?? ((name: string) => fetchFacts(opts.github, name));
  let stopped: string | null = null;
  let done = 0;
  for (const c of budget) {
    try {
      const f = await facts(c.fullName);
      done++;
      if (!f) {
        skipped[c.fullName.toLowerCase()] = "not found";
        continue;
      }
      state.repos[c.fullName.toLowerCase()] = {
        pushed_at: f.pushedAt,
        checked_at: now.toISOString(),
        assessment: assess(f),
      };
    } catch (err) {
      if (err instanceof StopRunError) {
        stopped = err.message;
        break;
      }
      log(`${c.fullName}: ${(err as Error).message}`);
    }
  }

  const assessed = new Map<string, Assessment>();
  for (const c of queue) {
    const cached = state.repos[c.fullName.toLowerCase()];
    if (cached) assessed.set(c.fullName.toLowerCase(), cached.assessment);
  }
  const suggestions: Suggestion[] = [...assessed.values()]
    .filter((a) => a.verdict !== "unlikely")
    .map((a) => ({
      ...a,
      overlaps: [...new Set(versionCodes(a).map((c) => listedCodes.get(c)).filter((p): p is string => !!p))],
    }))
    .sort((a, b) => b.score - a.score || a.fullName.localeCompare(b.fullName));
  state.updated_at = now.toISOString();
  return {
    state,
    candidates,
    skipped,
    assessed,
    suggestions,
    pending: todo.length - done,
    stopped,
  };
}

export interface Evaluation {
  total: number;
  found: number; // returned by search
  passedPrefilter: number;
  likely: number;
  possible: number;
  unlikely: number;
  notAssessed: number;
  misses: { name: string; reason: string }[];
}

/**
 * Measure a run against a hand-checked list of matching projects: how many the
 * search finds, how many survive the prefilter, and how the scorer rates them.
 * Already-listed projects count as passing the prefilter.
 */
export function evaluate(result: DiscoverResult, knownGood: string[], listedReason = "already listed"): Evaluation {
  const ev: Evaluation = {
    total: knownGood.length, found: 0, passedPrefilter: 0, likely: 0, possible: 0, unlikely: 0, notAssessed: 0, misses: [],
  };
  for (const name of knownGood.map((n) => n.toLowerCase())) {
    if (!result.candidates.has(name)) {
      ev.misses.push({ name, reason: "not found by search" });
      continue;
    }
    ev.found++;
    const skip = result.skipped[name];
    if (skip && skip !== listedReason) {
      ev.misses.push({ name, reason: `prefilter: ${skip}` });
      continue;
    }
    ev.passedPrefilter++;
    if (skip === listedReason) continue;
    const a = result.assessed.get(name);
    if (!a) {
      ev.notAssessed++;
      continue;
    }
    ev[a.verdict]++;
    if (a.verdict === "unlikely") ev.misses.push({ name, reason: `scored ${a.score}` });
  }
  return ev;
}
