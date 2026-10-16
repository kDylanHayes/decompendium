import type { RepoFacts } from "../discover/facts.ts";
import type { GitHub } from "../ingest/http.ts";
import type { Evidence } from "./identify.ts";

const HEX = /\b([0-9a-fA-F]{40}|[0-9a-fA-F]{32})\b/g;

/** Hash files worth reading: ROM checksums, not decomp-toolkit's per-file build.sha1 or tool downloads. */
const ROM_HASH_FILE = /(^|\/)[^/]+\.(sha1|md5)$|(^|\/)checksum[^/]*$/i;
const SKIP = /(^|\/)build\.sha1$|\.(tar|tgz|gz|zip|7z|exe|bin|xz)\.(sha1|md5|sha256)$|^(bin|tools|ext|external|third_party|lib|libs)\//i;

/** Version codes from config folders and objdiff report artifact names. */
export function codesFromFacts(f: Pick<RepoFacts, "paths" | "reportArtifacts">): string[] {
  const codes = new Set<string>();
  for (const p of f.paths) {
    const m = /^configs?\/([^/]+)\//.exec(p);
    if (m && m[1] !== "GAMEID") codes.add(m[1]!); // decomp-toolkit's template placeholder
  }
  for (const a of f.reportArtifacts) {
    const m = /^(.+)_report$/.exec(a);
    if (m) codes.add(m[1]!);
  }
  return [...codes];
}

export function hexDigests(text: string): string[] {
  return [...new Set([...text.matchAll(HEX)].map((m) => m[1]!.toLowerCase()))];
}

/**
 * Evidence for identification from a repo: its version codes, the digests in
 * up to `maxFiles` ROM hash files, and any digests in its README.
 */
export async function repoEvidence(github: GitHub, f: RepoFacts, maxFiles = 6): Promise<Evidence> {
  const hashes = new Set(hexDigests(f.readme));
  const files = f.paths.filter((p) => ROM_HASH_FILE.test(p) && !SKIP.test(p)).slice(0, maxFiles);
  for (const path of files) {
    const text = await github.getText(
      `/repos/${f.fullName}/contents/${path.split("/").map(encodeURIComponent).join("/")}?ref=${encodeURIComponent(f.defaultBranch)}`,
      "application/vnd.github.raw+json",
      20_000,
    );
    for (const h of hexDigests(text ?? "")) hashes.add(h);
  }
  return { hashes: [...hashes], codes: codesFromFacts(f), description: f.description };
}
