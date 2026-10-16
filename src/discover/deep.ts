import type { GitHub } from "../ingest/http.ts";
import type { RepoFacts } from "./facts.ts";

/**
 * A closer look at a "possible" repo: does its build actually compare the
 * output against a hash of the original, and does CI produce objdiff reports?
 * Reads CI workflows and top-level build scripts (a few API calls).
 */
export interface DeepFindings {
  hashCheck: string | null; // where the build verifies a hash, e.g. "Makefile: sha1sum -c"
  objdiffCI: string | null; // workflow that generates objdiff reports
  checked: string[]; // files read
}

// Commands and code that compare build output with a known hash.
const HASH_CHECK =
  /\b(sha1sum|md5sum|sha256sum|shasum)\b[^\n]*(-c|--check)|--check[^\n]*\.(sha1|md5|sha256)|hashlib\.(sha1|md5|sha256)|\bcheck_?(sum|hash|sha1|md5)\b|verify[_-]?(rom|hash|checksum)|\bcompare\b[^\n]*\b(rom|binary|baserom|original)\b|build\.sha1|\.sha1\b[^\n]*(compare|verify|check)/i;
// Comparing the build to the original byte for byte is as good as a hash check:
// `diff $(TARGET) $(BASEROM)`, `cmp build/x.z64 baserom.z64`, compare_bytes.py, COMPARE ?= 1.
const BYTE_COMPARE =
  /\b(diff|cmp)\b[^\n]*\b(baserom|base_rom|orig(inal)?(_rom)?|\$\(BASEROM\)|\$\{BASEROM\})|\bcompare_bytes\b|^\s*COMPARE\s*\??:?=\s*1\b/im;
const OBJDIFF_CI = /objdiff(-cli)?[^\n]*report[^\n]*generate|_report\b|report\.json/i;

// Top-level files that usually hold the build's final comparison step.
const BUILD_FILES = /^(Makefile|GNUmakefile|configure\.py|CMakeLists\.txt|build\.(sh|py|ninja)|justfile|Taskfile\.ya?ml|tools\/(check|verify)[^/]*\.(py|sh))$/i;

const MAX_FILE = 200_000;

export async function deepCheck(github: GitHub, f: RepoFacts): Promise<DeepFindings> {
  const findings: DeepFindings = { hashCheck: null, objdiffCI: null, checked: [] };
  const workflows = f.paths.filter((p) => /^\.github\/workflows\/[^/]+\.ya?ml$/.test(p)).slice(0, 6);
  const builds = f.paths.filter((p) => BUILD_FILES.test(p)).slice(0, 4);
  for (const path of [...builds, ...workflows]) { // build files first: that is where the checks usually live
    if (findings.hashCheck && findings.objdiffCI) break;
    const text = await github.getText(
      `/repos/${f.fullName}/contents/${path.split("/").map(encodeURIComponent).join("/")}?ref=${encodeURIComponent(f.defaultBranch)}`,
      "application/vnd.github.raw+json",
      MAX_FILE,
    );
    findings.checked.push(path);
    if (!text) continue;
    const hash = HASH_CHECK.exec(text) ?? BYTE_COMPARE.exec(text);
    if (hash && !findings.hashCheck) findings.hashCheck = `${path}: ${hash[0].trim().slice(0, 60)}`;
    if (path.startsWith(".github/") && OBJDIFF_CI.test(text) && !findings.objdiffCI) findings.objdiffCI = path;
  }
  // A README that tells you how to confirm the match ("make ... prints OK") counts too.
  if (!findings.hashCheck) {
    const m = /(sha1sum|md5sum|sha256sum)[^\n]{0,80}|should (print|output|show)[^\n]{0,40}\bok\b|: ok\b/.exec(f.readme);
    if (m) findings.hashCheck = `README: ${m[0].trim().slice(0, 60)}`;
  }
  return findings;
}
