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

/** How many runs back to look when the newest run has no usable artifact. */
const RUN_FALLBACK = 5;

/**
 * The newest successful push run on the default branch that has the named
 * artifact. Runs from pull requests, forks or other branches are never used:
 * anyone can make those produce arbitrary reports.
 */
async function fetchArtifact(
  source: Extract<Source, { type: "github-artifact" }>,
  ctx: SourceContext,
): Promise<Fetched> {
  const { owner, name } = githubRepo(ctx.repo);
  const branch = await ctx.defaultBranch();
  const base = `/repos/${owner}/${name}/actions`;
  const runsPath = source.workflow ? `${base}/workflows/${encodeURIComponent(source.workflow)}/runs` : `${base}/runs`;
  const query = new URLSearchParams({ branch, event: "push", status: "success", per_page: "20" });
  const page = await ctx.github.get<{ workflow_runs: WorkflowRun[] }>(`${runsPath}?${query}`);
  if (!page) throw new IngestError(source.workflow ? `workflow ${source.workflow} not found` : "repository not found");

  const lastRun = ctx.previous.run_id ?? 0;
  const runs = page.workflow_runs
    // The API already filters these; checking again keeps the guarantee local.
    .filter((r) => r.event === "push" && r.head_branch === branch && r.id > lastRun)
    .sort((a, b) => b.id - a.id)
    .slice(0, RUN_FALLBACK);
  if (runs.length === 0) return { status: "not-modified" };

  for (const run of runs) {
    const list = await ctx.github.get<{ artifacts: Artifact[] }>(
      `${base}/runs/${run.id}/artifacts?name=${encodeURIComponent(source.artifact)}`,
    );
    const artifact = list?.artifacts.find((a) => a.name === source.artifact && !a.expired);
    if (!artifact) continue;
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
  // Newer runs that skipped the report (docs-only pushes, expired artifacts) are
  // not a failure once something has been ingested: the last snapshot stands.
  if (lastRun > 0) return { status: "not-modified" };
  throw new IngestError(
    `no unexpired artifact "${source.artifact}" in the last ${runs.length} successful push run(s) on ${branch}`,
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
