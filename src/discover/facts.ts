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
    github.get<{ workflow_runs: { id: number }[] }>(
      `/repos/${repo.full_name}/actions/runs?branch=${branch}&event=push&status=success&per_page=1`,
    ),
  ]);
  let reportArtifacts: string[] = [];
  const runId = runs?.workflow_runs[0]?.id;
  if (runId) {
    const artifacts = await github.get<{ artifacts: { name: string }[] }>(
      `/repos/${repo.full_name}/actions/runs/${runId}/artifacts?per_page=100`,
    );
    reportArtifacts = (artifacts?.artifacts ?? []).map((a) => a.name).filter((n) => /report/i.test(n));
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
  };
}

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
