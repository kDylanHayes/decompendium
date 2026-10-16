import type { GitHub } from "../ingest/http.ts";

/** What the finder knows about one repository, all from the GitHub API. */
export interface RepoFacts {
  fullName: string; // owner/name as GitHub spells it
  url: string;
  description: string;
  topics: string[];
  fork: boolean;
  archived: boolean;
  stars: number;
  pushedAt: string;
  createdAt: string;
  defaultBranch: string;
  language: string | null;
  sizeKb: number;
  paths: string[]; // files in the default branch tree (may be truncated for huge repos)
  treeTruncated: boolean;
  readme: string; // first 20 KB of the README, lowercased
  reportArtifacts: string[]; // *_report artifact names on the newest default-branch push run
  reportFiles: Record<string, string>; // artifact name → the report's file name inside it, from the workflow's upload step
}

interface RepoResponse {
  full_name: string;
  html_url: string;
  description: string | null;
  topics?: string[];
  fork: boolean;
  archived: boolean;
  stargazers_count: number;
  pushed_at: string;
  created_at: string;
  default_branch: string;
  language: string | null;
  size: number;
}

/** Fetch facts for owner/name. Returns null when the repo does not exist or is private. */
export async function fetchFacts(github: GitHub, fullName: string): Promise<RepoFacts | null> {
  const repo = await github.get<RepoResponse>(`/repos/${fullName}`);
  if (!repo) return null;
  const branch = encodeURIComponent(repo.default_branch);
  const [tree, readme, runs] = await Promise.all([
    github.get<{ tree: { path: string; type: string }[]; truncated: boolean }>(
      `/repos/${repo.full_name}/git/trees/${branch}?recursive=1`,
    ),
    github.getText(`/repos/${repo.full_name}/readme`, "application/vnd.github.raw+json", 20_000),
    github.get<{ workflow_runs: { id: number; workflow_id: number; path?: string }[] }>(
      `/repos/${repo.full_name}/actions/runs?branch=${branch}&event=push&status=success&per_page=10`,
    ),
  ]);
  // The newest run is often a docs or lint workflow; look at up to three
  // different workflows' latest runs for report artifacts.
  let reportArtifacts: string[] = [];
  let reportFiles: Record<string, string> = {};
  const seenWorkflows = new Set<number>();
  for (const run of runs?.workflow_runs ?? []) {
    if (seenWorkflows.has(run.workflow_id)) continue;
    seenWorkflows.add(run.workflow_id);
    const artifacts = await github.get<{ artifacts: { name: string }[] }>(
      `/repos/${repo.full_name}/actions/runs/${run.id}/artifacts?per_page=100`,
    );
    reportArtifacts = (artifacts?.artifacts ?? []).map((a) => a.name).filter((n) => /report/i.test(n));
    if (reportArtifacts.length && run.path) {
      // One read of the workflow file says which file each report artifact holds (report.json, progress.json, ...).
      const workflow = await github.getText(
        `/repos/${repo.full_name}/contents/${run.path.split("/").map(encodeURIComponent).join("/")}?ref=${branch}`,
        "application/vnd.github.raw+json",
        200_000,
      );
      reportFiles = uploadedReportFiles(workflow ?? "", reportArtifacts);
    }
    if (reportArtifacts.length || seenWorkflows.size >= 3) break;
  }
  return {
    fullName: repo.full_name,
    url: repo.html_url,
    description: repo.description ?? "",
    topics: repo.topics ?? [],
    fork: repo.fork,
    archived: repo.archived,
    stars: repo.stargazers_count,
    pushedAt: repo.pushed_at,
    createdAt: repo.created_at,
    defaultBranch: repo.default_branch,
    language: repo.language,
    sizeKb: repo.size,
    paths: (tree?.tree ?? []).filter((e) => e.type === "blob").map((e) => e.path),
    treeTruncated: tree?.truncated ?? false,
    readme: (readme ?? "").toLowerCase(),
    reportArtifacts,
    reportFiles,
  };
}

/**
 * Which file each artifact holds, from a workflow's actions/upload-artifact steps:
 * `name: ${{ matrix.id }}_report` with `path: ./build/progress.json` → { SLUS_010.13_report: "progress.json" }.
 * A single uploaded file lands at the artifact's root under its own name. Steps that
 * upload a folder, a glob or several paths are skipped.
 */
export function uploadedReportFiles(workflow: string, artifacts: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  const lines = workflow.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (!/uses:\s*["']?actions\/upload-artifact@/.test(lines[i]!)) continue;
    // Look backwards to the step's `- ` and forwards to its end for `name:` and `path:` under `with:`.
    let name: string | null = null;
    let path: string | null = null;
    let start = i;
    while (start > 0 && !/^\s*-\s/.test(lines[start]!)) start--;
    const stepIndent = indentOf(lines[start]!);
    let end = i + 1;
    while (end < lines.length && (lines[end]!.trim() === "" || indentOf(lines[end]!) > stepIndent)) end++;
    let withIndent = -1;
    for (let j = start; j < end; j++) {
      const line = lines[j]!;
      if (line.trim() === "") continue;
      if (withIndent >= 0 && indentOf(line) <= withIndent) withIndent = -1;
      if (/^\s*(-\s*)?with:\s*$/.test(line)) withIndent = indentOf(line);
      else if (withIndent >= 0) {
        const m = /^\s*(name|path):\s*(.*?)\s*$/.exec(line);
        if (m?.[1] === "name") name = unquote(m[2]!);
        if (m?.[1] === "path") path = unquote(m[2]!);
      }
    }
    if (!name || !path || /^[|>]/.test(path) || /[*?\n]/.test(path)) continue;
    const file = path.replace(/\/+$/, "").split("/").pop()!;
    if (!/\.json$/i.test(file)) continue;
    const pattern = new RegExp(`^${name.split(/\$\{\{[^}]*\}\}/).map(escapeRe).join(".+")}$`);
    for (const a of artifacts) if (pattern.test(a) && !(a in out)) out[a] = file;
  }
  return out;
}

const indentOf = (line: string) => /^(\s*)/.exec(line)![1]!.length;
const unquote = (s: string) => s.replace(/\s+#.*$/, "").replace(/^(["'])(.*)\1$/, "$2");
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** owner/name from a GitHub URL, or null for anything else. */
export function repoFromUrl(url: string): string | null {
  const m = /^https?:\/\/github\.com\/([^/\s]+)\/([^/\s#?]+?)(?:\.git)?\/?$/i.exec(url.trim());
  return m ? `${m[1]}/${m[2]}` : null;
}

/** The current owner/name for a repo, following renames and transfers. Null if gone. */
export async function canonicalName(github: GitHub, fullName: string): Promise<string | null> {
  const repo = await github.get<{ full_name: string }>(`/repos/${fullName}`);
  return repo?.full_name ?? null;
}
