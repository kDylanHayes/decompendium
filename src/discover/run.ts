import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { normalizeRepo, readCatalog, type Config, type Project } from "../catalog.ts";
import type { GitHub } from "../ingest/http.ts";
import { StopRunError } from "../ingest/types.ts";
import { deepCheck, type DeepFindings } from "./deep.ts";
import { fetchFacts, type RepoFacts } from "./facts.ts";
import { MIN_PRIORITY, priority, searchCandidates, type Candidate } from "./search.ts";
import { assess, LOOKALIKE_WORDS, lookalikeText, TOOL_WORDS, toolText, type Assessment } from "./signals.ts";

/**
 * Where a repository stands. Only decisions that cost API calls are stored;
 * free decisions (triage on search data) are simply made again each run.
 *
 *   excluded  ruled out after inspection; revisited only after new pushes, and not often
 *   possible  some evidence, not enough: gets a deep check, then waits for a person if still unsure
 *   likely    strong evidence of a matching decomp: a suggestion for maintainers
 */
export type Status = "excluded" | "possible" | "likely";

export interface LedgerEntry {
  status: Status;
  reason: string;
  stage: 1 | 2; // 1: facts and score only; 2: also deep-checked (build and CI read)
  meta: string; // fingerprint of name, description, topics and fork flag
  pushed_at: string | null;
  checked_at: string;
  assessment: Assessment;
  deep?: DeepFindings;
}

export interface Ledger {
  schema: 2;
  updated_at: string | null;
  repos: Record<string, LedgerEntry>; // keyed by lowercased owner/name
}

export interface DiscoverOptions {
  root: string;
  github: GitHub;
  ledger?: Ledger;
  budget?: number; // most API calls to spend on inspection in one run (searches not counted)
  wide?: boolean; // also run the broad, low-precision searches
  now?: Date;
  log?: (line: string) => void;
  sleep?: (ms: number) => Promise<void>;
  search?: () => Promise<Map<string, Candidate>>; // injectable for tests
  facts?: (fullName: string) => Promise<RepoFacts | null>;
  deep?: (f: RepoFacts) => Promise<DeepFindings>;
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
  status: "likely" | "possible";
  why: string;
  /** Listed projects that already build one of this repo's versions. Duplicates are listed too (POLICY.md 3); this is for context. */
  overlaps: string[];
}

export interface DiscoverResult {
  ledger: Ledger;
  candidates: Map<string, Candidate>;
  /** Decisions made from search data alone this run (not stored): name → reason. */
  triaged: Record<string, string>;
  deferred: number; // weak candidates not inspected yet
  inspected: number; // repos given facts or a deep check this run
  suggestions: Suggestion[]; // likely first, then possible needing a person
  queued: number; // inspection work left for later runs
  stopped: string | null;
  requests: number; // API calls spent on inspection this run
}

const DAY_MS = 86_400_000;
/** How long before likely/possible repos that were pushed again are refreshed. */
const REFRESH_DAYS = 30;
/** How long before an excluded repo that was pushed again is looked at once more. */
const REVISIT_EXCLUDED_DAYS = 180;

export function emptyLedger(): Ledger {
  return { schema: 2, updated_at: null, repos: {} };
}

export function readLedger(path: string): Ledger {
  if (!existsSync(path)) return emptyLedger();
  const data = JSON.parse(readFileSync(path, "utf8"));
  return data.schema === 2 ? (data as Ledger) : emptyLedger(); // schema 1 was a plain cache
}

/** One repo per line, sorted, so daily changes make small diffs on the data branch. */
export function serializeLedger(ledger: Ledger): string {
  const keys = Object.keys(ledger.repos).sort();
  const body = keys.map((k) => `    ${JSON.stringify(k)}: ${JSON.stringify(ledger.repos[k])}`).join(",\n");
  return `{\n  "schema": 2,\n  "updated_at": ${JSON.stringify(ledger.updated_at)},\n  "repos": {\n${body}\n  }\n}\n`;
}

/** Changes to these are worth a fresh look even for an excluded repo. */
export function fingerprint(c: { fullName: string; description: string; topics: string[]; fork: boolean }): string {
  return createHash("sha1")
    .update([c.fullName.toLowerCase(), c.description, [...c.topics].sort().join(","), c.fork].join("\n"))
    .digest("hex")
    .slice(0, 10);
}

/**
 * Free triage on search data. Returns a reason to rule the repo out, or null to
 * keep it. Only high-confidence rules live here; anything uncertain is kept.
 */
export function triage(c: Candidate, listed: Set<string>, optedOut: Set<string>, excluded: Set<string>): string | null {
  const key = `https://github.com/${c.fullName}`.toLowerCase();
  if (listed.has(key)) return "already listed";
  if (optedOut.has(key)) return "opted out";
  if (excluded.has(key)) return "excluded by a maintainer";
  // Most forks are copies; keep the ones people have starred, which are often the active project.
  if (c.fork && (c.stars ?? 0) < 3) return "fork";
  if (c.sizeKb === 0) return "empty";
  const tool = TOOL_WORDS.exec(toolText(c.fullName, c.description, c.topics));
  if (tool) return `tool: ${tool[0]}`;
  const text = lookalikeText(c.fullName, c.description);
  const lookalike = LOOKALIKE_WORDS.exec(text);
  if (lookalike && !/decomp|disassembl/i.test(text)) return `look-alike: ${lookalike[0]}`;
  return null;
}

/** Decide a status from a stage-1 assessment and, if run, a deep check. */
export function decide(a: Assessment, deep?: DeepFindings): { status: Status; reason: string; needsDeep: boolean } {
  const has = (id: string) => a.signals.some((s) => s.id === id);
  // decomp.dev only tracks projects that publish objdiff reports, so its badge counts as reports.
  const strongProgress = a.reportArtifacts.length > 0 || has("decomp-toolkit") || has("decomp-dev-badge");
  // A repo that calls itself a decomp and has source gets a deep look before being ruled out.
  const borderline = a.score >= 3 && has("named-decomp") && has("has-source");
  if (a.verdict === "unlikely" && !borderline) return { status: "excluded", reason: `score ${a.score}`, needsDeep: false };
  // Listing requires a verified hash. Strong evidence on both counts needs no deeper look.
  if (a.verdict === "likely" && a.hashEvidence.length && strongProgress) {
    return { status: "likely", reason: "hash file and objdiff reports", needsDeep: false };
  }
  if (!deep) return { status: "possible", reason: `score ${a.score}; needs a deep check`, needsDeep: true };
  if (deep.hashCheck) return { status: "likely", reason: `build checks a hash (${deep.hashCheck})`, needsDeep: false };
  if (a.verdict === "unlikely") return { status: "excluded", reason: `score ${a.score}; no hash check found`, needsDeep: false };
  if (!a.hashEvidence.length && !deep.objdiffCI) {
    return { status: "excluded", reason: "no hash file and no hash check in build or CI", needsDeep: false };
  }
  return { status: "possible", reason: "some evidence; a person should look", needsDeep: false };
}

/**
 * Find repositories that look like matching decomps and are not in the catalog.
 * Nothing is added anywhere: the result is a list for a maintainer to review.
 */
export async function runDiscover(opts: DiscoverOptions): Promise<DiscoverResult> {
  const now = opts.now ?? new Date();
  const log = opts.log ?? (() => {});
  const ledger = opts.ledger ?? emptyLedger();
  const budget = opts.budget ?? 900;

  const raw = readCatalog(opts.root);
  const config = raw.config!.data as Config;
  const listed = new Set(raw.projects.map((p) => normalizeRepo((p.data as Project).repo)));
  const optedOut = new Set(config.opted_out.map(normalizeRepo));
  const excluded = new Set((config.excluded ?? []).map((e) => normalizeRepo(e.repo)));
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

  const candidates = await (opts.search ?? (() => searchCandidates(opts.github, { log, sleep: opts.sleep, now, wide: opts.wide })))();
  const startRequests = opts.github.requests;

  // Sort every kept candidate into one queue, most valuable work first.
  const triaged: Record<string, string> = {};
  type Job = { c: Candidate; rank: number; why: string };
  const jobs: Job[] = [];
  let deferred = 0;
  for (const [key, c] of candidates) {
    const reason = triage(c, listed, optedOut, excluded);
    if (reason) {
      triaged[key] = reason;
      continue;
    }
    const entry = ledger.repos[key];
    const p = priority(c, now);
    const age = (iso: string) => now.getTime() - Date.parse(iso);
    const pushed = entry && c.pushedAt !== null && entry.pushed_at !== c.pushedAt;
    if (!entry) {
      if (p >= MIN_PRIORITY) jobs.push({ c, rank: 3000 + p, why: "new" });
      else {
        jobs.push({ c, rank: p, why: "deferred" }); // weak: only with leftover budget
        deferred++;
      }
    } else if (entry.status === "possible" && entry.stage === 1) {
      jobs.push({ c, rank: 4000 + p, why: "deep check" });
    } else if (entry.meta !== fingerprint(c)) {
      jobs.push({ c, rank: 2000 + p, why: "name, description or topics changed" });
    } else if (entry.status !== "excluded" && pushed && age(entry.checked_at) > REFRESH_DAYS * DAY_MS) {
      jobs.push({ c, rank: 1000 + p, why: "refresh" });
    } else if (entry.status === "excluded" && pushed && age(entry.checked_at) > REVISIT_EXCLUDED_DAYS * DAY_MS) {
      jobs.push({ c, rank: 500 + p, why: "revisit" });
    }
  }
  jobs.sort((a, b) => b.rank - a.rank || (b.c.pushedAt ?? "").localeCompare(a.c.pushedAt ?? ""));

  const getFacts = opts.facts ?? ((name: string) => fetchFacts(opts.github, name));
  const getDeep = opts.deep ?? ((f: RepoFacts) => deepCheck(opts.github, f));
  const spent = () => opts.github.requests - startRequests;
  let stopped: string | null = null;
  let inspected = 0;
  let done = 0;
  for (const job of jobs) {
    if (spent() >= budget) break;
    const key = job.c.fullName.toLowerCase();
    try {
      const f = await getFacts(job.c.fullName);
      done++;
      if (!f) {
        delete ledger.repos[key];
        continue;
      }
      inspected++;
      const assessment = assess(f);
      let verdict = decide(assessment);
      let deep: DeepFindings | undefined;
      if (verdict.needsDeep && spent() < budget) {
        deep = await getDeep(f);
        verdict = decide(assessment, deep);
      }
      ledger.repos[key] = {
        status: verdict.status,
        reason: verdict.reason,
        stage: deep ? 2 : 1,
        meta: fingerprint(job.c),
        pushed_at: f.pushedAt,
        checked_at: now.toISOString(),
        assessment,
        ...(deep ? { deep } : {}),
      };
    } catch (err) {
      if (err instanceof StopRunError) {
        stopped = err.message;
        break;
      }
      log(`${job.c.fullName}: ${(err as Error).message}`);
    }
  }

  const suggestions: Suggestion[] = [];
  for (const c of candidates.values()) {
    const key = c.fullName.toLowerCase();
    const entry = ledger.repos[key];
    if (!entry || triaged[key] || entry.status === "excluded") continue;
    if (entry.status === "possible" && entry.stage === 1) continue; // not deep-checked yet
    suggestions.push({
      ...entry.assessment,
      status: entry.status,
      why: entry.reason,
      overlaps: [...new Set(versionCodes(entry.assessment).map((v) => listedCodes.get(v)).filter((p): p is string => !!p))],
    });
  }
  suggestions.sort(
    (a, b) => (a.status === b.status ? 0 : a.status === "likely" ? -1 : 1) || b.score - a.score || a.fullName.localeCompare(b.fullName),
  );

  ledger.updated_at = now.toISOString();
  return {
    ledger,
    candidates,
    triaged,
    deferred,
    inspected,
    suggestions,
    queued: jobs.length - done,
    stopped,
    requests: spent(),
  };
}

export interface Evaluation {
  total: number;
  found: number; // returned by search
  keptByTriage: number;
  likely: number;
  possible: number; // deep-checked or waiting for one
  excluded: number;
  notInspected: number;
  misses: { name: string; reason: string }[];
}

/**
 * Measure a run against a hand-checked list of matching projects: how many the
 * search finds, how many survive triage, and where inspection puts them.
 * Listed projects count as kept.
 */
export function evaluate(result: DiscoverResult, knownGood: string[]): Evaluation {
  const ev: Evaluation = {
    total: knownGood.length, found: 0, keptByTriage: 0, likely: 0, possible: 0, excluded: 0, notInspected: 0, misses: [],
  };
  for (const name of knownGood.map((n) => n.toLowerCase())) {
    if (!result.candidates.has(name)) {
      ev.misses.push({ name, reason: "not found by search" });
      continue;
    }
    ev.found++;
    const reason = result.triaged[name];
    if (reason && reason !== "already listed") {
      ev.misses.push({ name, reason: `triage: ${reason}` });
      continue;
    }
    ev.keptByTriage++;
    if (reason) continue;
    const entry = result.ledger.repos[name];
    if (!entry) {
      ev.notInspected++;
      continue;
    }
    ev[entry.status]++;
    if (entry.status === "excluded") ev.misses.push({ name, reason: `excluded: ${entry.reason}` });
  }
  return ev;
}
