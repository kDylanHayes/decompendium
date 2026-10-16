// Other sites that track matching decomps, read as extra finder candidates.
// Being listed there is a hint, not a verdict: the usual triage, deep check and
// onboarding rules still decide.

/**
 * ByteMatch (bytematch.dev, GPL-3.0) tracks objdiff progress for projects that
 * upload reports from CI. Its JSON API sits under /api/, which its robots.txt
 * asks automated clients to stay out of, so the project list comes from the
 * sitemap it offers instead: one request a run.
 */
export const BYTEMATCH_SITEMAP = "https://bytematch.dev/sitemap.xml";

// First path segments that are site pages, not GitHub owners.
const NOT_OWNERS = new Set(["games", "franchises", "docs", "manage", "api", "auth", "activity", "theme", "healthz"]);

/** owner/repo for each project in a ByteMatch sitemap. */
export function parseBytematchSitemap(xml: string): string[] {
  const repos = new Set<string>();
  for (const m of xml.matchAll(/<loc>\s*https:\/\/bytematch\.dev\/([^<\s]+?)\s*<\/loc>/g)) {
    const parts = m[1]!.split("/");
    if (parts.length !== 2 || NOT_OWNERS.has(parts[0]!.toLowerCase())) continue;
    const [owner, repo] = parts as [string, string];
    // GitHub's own rules for names: keeps anything else out of API paths.
    if (!/^[A-Za-z0-9-]{1,39}$/.test(owner) || !/^[A-Za-z0-9._-]{1,100}$/.test(repo)) continue;
    repos.add(`${owner}/${repo}`);
  }
  return [...repos];
}

export async function bytematchRepos(fetch: typeof globalThis.fetch = globalThis.fetch): Promise<string[]> {
  const res = await fetch(BYTEMATCH_SITEMAP, {
    headers: { "User-Agent": "Decompendium finder (+https://decompendium.com/about/)" },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`ByteMatch sitemap: HTTP ${res.status}`);
  return parseBytematchSitemap(await res.text());
}
