import { unzipSync } from "fflate";
import type { Config, Source } from "../catalog.ts";
import { readLimited, USER_AGENT, type Fetch, type GitHub } from "./http.ts";
import { IngestError } from "./types.ts";

/** What a source remembers between runs, stored per target in health.json. */
export interface SourceState {
  etag?: string;
  last_modified?: string;
  run_id?: number;
}

export type Fetched =
  | { status: "not-modified" }
  | {
      status: "fetched";
      bytes: Uint8Array;
      commit?: string;
      commit_at?: string;
      run_id?: number;
      state: SourceState;
    };

export interface SourceContext {
  fetch: Fetch;
  github: GitHub;
  limits: Config["limits"];
  repo: string; // the project's repo URL
  defaultBranch: () => Promise<string>;
  previous: SourceState;
}

export function fetchSource(source: Source, ctx: SourceContext): Promise<Fetched> {
  switch (source.type) {
    case "url":
      return fetchUrl(source.url, ctx);
    case "github-artifact":
      return fetchArtifact(source, ctx);
  }
}

const MAX_REDIRECTS = 3;

/** An https URL, with conditional requests so unchanged files cost a 304. */
async function fetchUrl(url: string, ctx: SourceContext): Promise<Fetched> {
  const headers: Record<string, string> = { "user-agent": USER_AGENT, accept: "application/json, */*" };
  if (ctx.previous.etag) headers["if-none-match"] = ctx.previous.etag;
  if (ctx.previous.last_modified) headers["if-modified-since"] = ctx.previous.last_modified;

  let current = new URL(url);
  for (let hop = 0; ; hop++) {
    if (current.protocol !== "https:") throw new IngestError(`refusing non-https URL ${current}`);
    const res = await ctx.fetch(current, {
      headers,
      redirect: "manual",
      signal: AbortSignal.timeout(ctx.limits.fetch_timeout_seconds * 1000),
    });
    if (res.status >= 300 && res.status < 400 && res.status !== 304) {
      const location = res.headers.get("location");
      if (!location) throw new IngestError(`HTTP ${res.status} without a Location header`);
      if (hop >= MAX_REDIRECTS) throw new IngestError(`more than ${MAX_REDIRECTS} redirects`);
      current = new URL(location, current);
      continue;
    }
    if (res.status === 304) return { status: "not-modified" };
    if (!res.ok) throw new IngestError(`HTTP ${res.status} from ${current}`);
    const bytes = await readLimited(res, ctx.limits.report_read_bytes, "report");
    const state: SourceState = {};
    const etag = res.headers.get("etag");
    const lastModified = res.headers.get("last-modified");
    if (etag) state.etag = etag;
    if (lastModified) state.last_modified = lastModified;
    return { status: "fetched", bytes, state };
  }
}

interface WorkflowRun {
  id: number;
  head_sha: string;
  head_branch: string;
  event: string;
  head_commit?: { timestamp?: string } | null;
}

interface Artifact {
  id: number;
  name: string;
  size_in_bytes: number;
  expired: boolean;
}

/** Owner and name from https://github.com/<owner>/<name>. */
export function githubRepo(url: string): { owner: string; name: string } {
  const u = new URL(url);
  const [owner, name] = u.pathname.split("/").filter(Boolean);
  if (u.hostname.toLowerCase() !== "github.com" || !owner || !name) {
    throw new IngestError(`github-artifact sources need a github.com repo, got ${url}`);
  }
  return { owner, name: name.replace(/\.git$/, "") };
}

/** How many of the newest artifacts with the right name to consider. */
const ARTIFACT_LOOKBACK = 30;

interface NamedArtifact extends Artifact {
  workflow_run?: { id: number; head_branch: string; head_sha: string } | null;
}

/**
 * The newest unexpired artifact with the configured name that a successful
 * push run on the default branch produced. Artifacts are looked up by name,
 * so other workflows (lint, docs) running on every push don't hide the build's
 * report. Runs from pull requests, forks or other branches are never used:
 * anyone can make those produce arbitrary reports.
 */
async function fetchArtifact(
  source: Extract<Source, { type: "github-artifact" }>,
  ctx: SourceContext,
): Promise<Fetched> {
  const { owner, name } = githubRepo(ctx.repo);
  const branch = await ctx.defaultBranch();
  const base = `/repos/${owner}/${name}/actions`;
  const lastRun = ctx.previous.run_id ?? 0;

  const query = new URLSearchParams({ name: source.artifact, per_page: String(ARTIFACT_LOOKBACK) });
  const page = await ctx.github.get<{ artifacts: NamedArtifact[] }>(`${base}/artifacts?${query}`);
  if (!page) throw new IngestError("repository not found");
  const candidates = page.artifacts
    .filter((a) => a.name === source.artifact && !a.expired && a.workflow_run?.head_branch === branch)
    .sort((a, b) => (b.workflow_run!.id - a.workflow_run!.id) || b.id - a.id);
  if (candidates[0] && candidates[0].workflow_run!.id <= lastRun) return { status: "not-modified" };

  for (const artifact of candidates.filter((a) => a.workflow_run!.id > lastRun).slice(0, 5)) {
    // Confirm what produced it: a successful push to the default branch (and the configured workflow, if any).
    const run = await ctx.github.get<WorkflowRun & { conclusion: string | null; path?: string }>(`${base}/runs/${artifact.workflow_run!.id}`);
    if (!run || run.event !== "push" || run.head_branch !== branch || run.conclusion !== "success") continue;
    if (source.workflow && run.path && !run.path.endsWith(`/${source.workflow}`)) continue;
    if (artifact.size_in_bytes > ctx.limits.report_download_bytes) {
      throw new IngestError(`artifact is ${artifact.size_in_bytes} bytes, over the download limit`);
    }
    const zip = await ctx.github.download(`${base}/artifacts/${artifact.id}/zip`, ctx.limits.report_download_bytes);
    const bytes = extractOne(zip, source.path, ctx.limits.report_read_bytes);
    return {
      status: "fetched",
      bytes,
      commit: run.head_sha,
      commit_at: run.head_commit?.timestamp ?? undefined,
      run_id: run.id,
      state: { run_id: run.id },
    };
  }
  // Nothing newer that qualifies: once something has been ingested, the last snapshot stands.
  if (lastRun > 0) return { status: "not-modified" };
  throw new IngestError(
    candidates.length
      ? `no artifact "${source.artifact}" from a successful push run on ${branch}`
      : `no unexpired artifact "${source.artifact}" on ${branch} (GitHub keeps artifacts for 90 days at most)`,
  );
}

/** Pull one file out of a zip without extracting anything else. */
function extractOne(zip: Uint8Array, path: string, limit: number): Uint8Array {
  const names: string[] = [];
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(zip, {
      filter: (file) => {
        names.push(file.name);
        if (file.name !== path) return false;
        if (file.originalSize > limit) throw new IngestError(`${path} is ${file.originalSize} bytes, over the limit`);
        return true;
      },
    });
  } catch (err) {
    if (err instanceof IngestError) throw err;
    throw new IngestError(`artifact is not a valid zip: ${(err as Error).message}`);
  }
  const bytes = files[path];
  if (!bytes) {
    const shown = names.slice(0, 5).join(", ") + (names.length > 5 ? ", ..." : "");
    throw new IngestError(`${path} not found in artifact (contains: ${shown || "nothing"})`);
  }
  // The declared size can lie; check what actually came out.
  if (bytes.byteLength > limit) throw new IngestError(`${path} exceeds the ${limit}-byte limit`);
  return bytes;
}
