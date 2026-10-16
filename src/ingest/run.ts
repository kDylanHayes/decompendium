import { readCatalog, type Config, type Project, type Target } from "../catalog.ts";
import { validateCatalog } from "../validate.ts";
import { GitHub, type Fetch } from "./http.ts";
import { parseDecompendium, parseObjdiff, sanityErrors } from "./parsers.ts";
import { fetchSource, githubRepo } from "./sources.ts";
import { DataStore, type Health, type ProjectHealth, type TargetHealth } from "./store.ts";
import { IngestError, StopRunError, type Parsed, type Snapshot } from "./types.ts";

export interface IngestOptions {
  root: string; // catalog repo checkout
  dataDir: string; // data branch checkout
  token?: string;
  fetch?: Fetch;
  now?: () => Date;
  only?: string[]; // "<project>/<target>" or "<project>"
  newOnly?: boolean; // after a catalog merge: targets never fetched, and failing ones (the merge may fix them)
  concurrency?: number;
  deadlineMs?: number;
  log?: (line: string) => void;
}

export type Outcome = "new-snapshot" | "unchanged" | "not-modified" | "failed" | "skipped";

export interface IngestSummary {
  results: { target: string; outcome: Outcome; detail?: string }[];
  newlyFailing: string[]; // targets that reached the failure threshold in this run
  pruned: string[];
  stopped: string | null; // why the run stopped early, if it did
  requests: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** A total_code change bigger than this fraction is stored but flagged. */
const ANOMALY_RATIO = 0.5;

export async function runIngest(opts: IngestOptions): Promise<IngestSummary> {
  const now = opts.now ?? (() => new Date());
  const log = opts.log ?? (() => {});
  const fetch = opts.fetch ?? globalThis.fetch;
  const deadline = Date.now() + (opts.deadlineMs ?? 45 * 60 * 1000);

  const validation = validateCatalog(opts.root);
  if (validation.problems.length) {
    throw new Error(`catalog is invalid (${validation.problems.length} problems); run pnpm validate`);
  }
  const raw = readCatalog(opts.root);
  const config = raw.config!.data as Config;
  const projects = raw.projects.map((p) => p.data as Project);

  const store = new DataStore(opts.dataDir);
  const health = store.readHealth();
  const github = new GitHub(fetch, opts.token, config.limits.fetch_timeout_seconds * 1000);

  // Every catalog target, for pruning; only those with a progress source get fetched.
  const keep = new Map(projects.map((p) => [p.id, new Set(p.targets.map((t) => t.id))]));
  let work = projects.flatMap((project) =>
    project.targets
      .filter((t) => t.progress && t.progress.kind !== "none")
      .map((target) => ({ project, target, key: `${project.id}/${target.id}` })),
  );
  if (opts.only?.length) work = work.filter((w) => opts.only!.some((o) => w.key === o || w.project.id === o));
  if (opts.newOnly) work = work.filter((w) => !health.targets[w.key] || health.targets[w.key]!.last_error !== null);
  // Oldest attempt first, so a run cut short by limits never starves the same targets.
  work.sort((a, b) =>
    (health.targets[a.key]?.last_attempt_at ?? "").localeCompare(health.targets[b.key]?.last_attempt_at ?? ""),
  );

  const summary: IngestSummary = { results: [], newlyFailing: [], pruned: [], stopped: null, requests: 0 };

  const projectHealth = (id: string): ProjectHealth => (health.projects[id] ??= {});
  const defaultBranches = new Map<string, Promise<string>>();
  const defaultBranch = (project: Project): Promise<string> => {
    let pending = defaultBranches.get(project.id);
    if (!pending) {
      pending = (async () => {
        const ph = projectHealth(project.id);
        if (ph.default_branch && age(ph.default_branch_checked_at, now()) < DAY_MS) return ph.default_branch;
        const { owner, name } = githubRepo(project.repo);
        const repo = await github.get<{ default_branch: string }>(`/repos/${owner}/${name}`);
        if (!repo) throw new IngestError(`repository ${owner}/${name} not found`);
        ph.default_branch = repo.default_branch;
        ph.default_branch_checked_at = now().toISOString();
        return repo.default_branch;
      })();
      defaultBranches.set(project.id, pending);
    }
    return pending;
  };

  const ingestOne = async ({ project, target, key }: (typeof work)[number]) => {
    if (summary.stopped || Date.now() > deadline) {
      summary.stopped ??= "time limit reached";
      summary.results.push({ target: key, outcome: "skipped" });
      return;
    }
    const previous = health.targets[key];
    const attemptAt = now().toISOString();
    try {
      const outcome = await ingestTarget(project, target, previous, {
        store,
        github,
        fetch,
        config,
        defaultBranch: () => defaultBranch(project),
        now,
      });
      health.targets[key] = {
        ...previous,
        ...outcome.state,
        last_attempt_at: attemptAt,
        last_success_at: attemptAt,
        consecutive_failures: 0,
        last_error: null,
        anomaly: outcome.anomaly !== undefined ? outcome.anomaly : (previous?.anomaly ?? null),
      };
      summary.results.push({ target: key, outcome: outcome.outcome, detail: outcome.detail });
      log(`${key}: ${outcome.outcome}${outcome.detail ? ` (${outcome.detail})` : ""}`);
    } catch (err) {
      if (err instanceof StopRunError) {
        summary.stopped = err.message;
        summary.results.push({ target: key, outcome: "skipped" });
        return;
      }
      const message = err instanceof IngestError ? err.message : `unexpected error: ${(err as Error).message}`;
      const failures = (previous?.consecutive_failures ?? 0) + 1;
      health.targets[key] = {
        ...previous,
        anomaly: previous?.anomaly ?? null,
        last_attempt_at: attemptAt,
        last_success_at: previous?.last_success_at ?? null,
        consecutive_failures: failures,
        last_error: message,
      };
      if (failures === config.thresholds.failing_after_attempts) summary.newlyFailing.push(key);
      summary.results.push({ target: key, outcome: "failed", detail: message });
      log(`${key}: failed (${message})`);
    }
  };

  await pool(work, opts.concurrency ?? 8, ingestOne);

  // Newest commit on each GitHub repo's default branch, once a day, for the Quiet marker.
  if (!summary.stopped && !opts.only?.length && !opts.newOnly) {
    for (const project of projects) {
      const ph = projectHealth(project.id);
      if (age(ph.commits_checked_at, now()) < DAY_MS || Date.now() > deadline) continue;
      if (new URL(project.repo).hostname !== "github.com") continue;
      try {
        const { owner, name } = githubRepo(project.repo);
        const branch = await defaultBranch(project);
        const commits = await github.get<{ commit: { committer?: { date?: string } } }[]>(
          `/repos/${owner}/${name}/commits?sha=${encodeURIComponent(branch)}&per_page=1`,
        );
        ph.last_commit_at = commits?.[0]?.commit.committer?.date ?? null;
        ph.commits_checked_at = now().toISOString();
      } catch (err) {
        if (err instanceof StopRunError) {
          summary.stopped = err.message;
          break;
        }
        log(`${project.id}: commit check failed (${(err as Error).message})`);
      }
    }
  }

  summary.pruned = store.prune(keep, health);
  health.updated_at = now().toISOString();
  store.writeHealth(health);
  summary.requests = github.requests;
  return summary;
}

interface TargetContext {
  store: DataStore;
  github: GitHub;
  fetch: Fetch;
  config: Config;
  defaultBranch: () => Promise<string>;
  now: () => Date;
}

interface TargetOutcome {
  outcome: Outcome;
  detail?: string;
  state: Partial<TargetHealth>;
  anomaly?: string | null; // undefined: keep the previous flag
}

async function ingestTarget(
  project: Project,
  target: Target,
  previous: TargetHealth | undefined,
  ctx: TargetContext,
): Promise<TargetOutcome> {
  const progress = target.progress as Exclude<Target["progress"], undefined | { kind: "none" }>;
  const fetched = await fetchSource(progress.source, {
    fetch: ctx.fetch,
    github: ctx.github,
    limits: ctx.config.limits,
    repo: project.repo,
    defaultBranch: ctx.defaultBranch,
    previous: previous ?? {},
  });
  if (fetched.status === "not-modified") return { outcome: "not-modified", state: {} };

  const parsed: Parsed = progress.kind === "objdiff" ? parseObjdiff(fetched.bytes) : parseDecompendium(fetched.bytes);
  const problems = sanityErrors(parsed.measures);
  if (problems.length) throw new IngestError(`report rejected: ${problems.join("; ")}`);

  const snapshot: Snapshot = {
    taken_at: ctx.now().toISOString(),
    commit: parsed.commit ?? fetched.commit ?? null,
    commit_at: parsed.commit_at ?? fetched.commit_at ?? null,
    run_id: fetched.run_id ?? null,
    kind: progress.kind,
    ...parsed.measures,
    categories: parsed.categories,
  };

  ctx.store.writeReport(
    project.id,
    target.id,
    fetched.bytes,
    parsed.format === "protobuf" ? "binpb" : "json",
    ctx.config.limits.report_store_bytes,
  );

  const last = ctx.store.lastSnapshot(project.id, target.id);
  if (last && sameProgress(last, snapshot)) return { outcome: "unchanged", state: fetched.state };

  let anomaly: string | null = null;
  if (last && last.code.total > 0) {
    const change = Math.abs(snapshot.code.total - last.code.total) / last.code.total;
    if (change > ANOMALY_RATIO) {
      anomaly = `code total changed from ${last.code.total} to ${snapshot.code.total} bytes`;
    }
  }
  ctx.store.appendSnapshot(project.id, target.id, snapshot);
  return {
    outcome: "new-snapshot",
    detail: `${pct(snapshot.code)} code${snapshot.commit ? ` at ${snapshot.commit.slice(0, 7)}` : ""}`,
    state: fetched.state,
    anomaly,
  };
}

/** Same commit and same numbers: no new history line. */
function sameProgress(a: Snapshot, b: Snapshot): boolean {
  const strip = ({ taken_at: _t, run_id: _r, commit_at: _c, ...rest }: Snapshot) => rest;
  return JSON.stringify(strip(a)) === JSON.stringify(strip(b));
}

function pct(c: { matched: number; total: number }): string {
  return `${((c.matched / c.total) * 100).toFixed(2)}%`;
}

function age(iso: string | undefined, now: Date): number {
  return iso ? now.getTime() - Date.parse(iso) : Infinity;
}

/** Run `fn` over `items` with at most `size` in flight. */
async function pool<T>(items: T[], size: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) await fn(items[next++]!);
  };
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, worker));
}
