import type { RepoFacts } from "./facts.ts";

/**
 * Signals that a repository is a matching decompilation, with weights tuned
 * against a hand-checked list of known matching projects (most of which
 * publish objdiff reports) and a list of look-alikes (recomps, ports, tools).
 */
export interface Signal {
  id: string;
  weight: number;
  detail?: string;
}

export type Verdict = "likely" | "possible" | "unlikely";

export interface Assessment {
  fullName: string;
  score: number;
  verdict: Verdict;
  signals: Signal[];
  /** Evidence of a hash the build verifies against, which listing requires (POLICY.md 1). */
  hashEvidence: string[];
  /** objdiff report artifacts on the default branch, if any: a ready progress source. */
  reportArtifacts: string[];
}

export const LIKELY_AT = 8;
export const POSSIBLE_AT = 4;

// Hash files the build checks against. Tool downloads (bin/*.tar.gz.sha256 and
// the like) are excluded: they verify compilers, not the game.
const HASH_FILE = /(^|\/)[^/]*\.(sha1|md5|sha256|sha)$|(^|\/)checksum[^/]*\.(txt|sha1|md5|sha)$/i;
const TOOL_HASH = /\.(tar|tgz|gz|zip|7z|exe|bin|xz)\.(sha1|md5|sha256)$|^(bin|tools|ext|external|third_party)\//i;
const DTK_HASH = /^config\/[^/]+\/build\.sha1$/;

const TOOLING: [RegExp, string][] = [
  [/^configure\.py$/, "configure.py"],
  [/^objdiff\.json$/, "objdiff.json"],
  [/(^|\/)diff_settings\.py$/, "asm-differ"],
  [/(^|\/)permuter_settings\.toml$/, "decomp-permuter"],
  [/^tools\/splat(\/|$)|(^|\/)splat\.ya?ml$/, "splat"],
  [/(^|\/)nonmatchings?\//, "nonmatching asm split"],
  [/^tools\/m2c(\/|$)/, "m2c"],
];

// Words that mean the repo is a tool, template, library or list rather than a
// game decomp. Checked in the name, description and topics; always penalized.
export const TOOL_WORDS =
  /\b(decompiler|disassembler|recompiler|recompile|toolkit|template|converter|awesome|binary splitting|porting games)\b|\btool\b|\btools (for|to)\b/i;

/** Name, description and topics for the tool-word check. Naming the tools a project is built with doesn't make it one. */
export function toolText(fullName: string, description: string, topics: string[]): string {
  return `${fullName.split("/")[1]} ${description} ${topics.join(" ")}`.replace(/decomp-toolkit|\bdtk\b|objdiff|splat|m2c/gi, "");
}

// Words that usually mean "not a matching decomp" (recomps, ports, mods), but
// that real decomps also use ("decompilation, modding and map editing for X").
// Penalized hard only when the name and description never mention decomp.
const LOOKALIKE_WORDS =
  /\b(recomp(iled|ilation)?|static recomp\w*|port of|pc[- ]port|native port|source port|ports? for modern|fork of|remake|remaster(ed)?|randomi[sz]er|modding|mod loader|reimplementation|re-implementation|engine recreation|community edition|custom version|librar(y|ies)|sdk)\b|-port\b/i;

const MATCHING_CLAIM =
  /byte[- ]for[- ]byte|bit[- ]for[- ]bit|byte[- ]identical|bit[- ]identical|matching decomp|identical (rom|binary|executable|copy)|rebuilds? (an? )?(identical|matching)|\bmatching\b/;

/** Score a repository from its facts. Pure: no network. */
export function assess(f: RepoFacts): Assessment {
  const signals: Signal[] = [];
  const add = (id: string, weight: number, detail?: string) => signals.push({ id, weight, detail });

  const hashFiles = f.paths.filter((p) => (HASH_FILE.test(p) || DTK_HASH.test(p)) && !TOOL_HASH.test(p));
  const dtk = f.paths.filter((p) => DTK_HASH.test(p));
  const readmeHash = /\b[0-9a-f]{40}\b|\b[0-9a-f]{32}\b/.exec(f.readme)?.[0];
  const hashEvidence = [...hashFiles.slice(0, 5), ...(readmeHash ? [`README: ${readmeHash}`] : [])];

  if (f.reportArtifacts.length) add("objdiff-report", 5, f.reportArtifacts.slice(0, 3).join(", "));
  // decomp.dev only tracks projects that publish objdiff reports.
  if (/decomp\.dev\//.test(f.readme)) add("decomp-dev-badge", 3);
  if (dtk.length) add("decomp-toolkit", 4, `${dtk.length} build.sha1`);
  else if (hashFiles.length) add("hash-file", 3, hashFiles.slice(0, 2).join(", "));
  if (readmeHash) add("readme-hash", 2);

  const tools = new Set<string>();
  for (const p of f.paths) for (const [re, name] of TOOLING) if (re.test(p)) tools.add(name);
  if (tools.size) add("decomp-tooling", Math.min(3, tools.size + 1), [...tools].join(", "));
  if (f.paths.some((p) => /(^|\/)macros?\.inc$/.test(p))) add("asm-macros", 1);

  const text = `${f.fullName} ${f.description} ${f.topics.join(" ")}`.toLowerCase();
  if (/decomp|disassembl/.test(text)) add("named-decomp", 2);
  else if (f.readme.includes("decomp")) add("readme-decomp", 1);
  if (MATCHING_CLAIM.test(f.readme) || /\bmatching\b/.test(text)) add("matching-claim", 2);
  if (/checksum|sha-?1|md5|sha256/.test(f.readme)) add("readme-mentions-hash", 1);
  if (f.paths.some((p) => /\.(c|cc|cpp|cxx)$/i.test(p))) add("has-source", 1);

  // URLs don't count: "a port of github.com/n64decomp/sm64" is not a decomp.
  const blurb = `${f.fullName.split("/")[1]} ${f.description}`.replace(/\S+:\/\/\S+|\S+\.(com|org|io)\/\S*/g, "");
  const tool = TOOL_WORDS.exec(toolText(f.fullName, f.description, f.topics));
  if (tool) add("tool-words", -6, tool[0]);
  const lookalike = LOOKALIKE_WORDS.exec(blurb);
  if (lookalike) add("lookalike-words", /decomp|disassembl/i.test(blurb) ? -1 : -6, lookalike[0]);
  if (f.fork) add("fork", -3);
  if (f.archived) add("archived", -1);
  if (f.paths.length < 25 && !f.treeTruncated && !f.reportArtifacts.length) add("tiny-repo", -3, `${f.paths.length} files`);

  const score = signals.reduce((s, x) => s + x.weight, 0);
  // Words alone are not enough: a candidate needs something buildable.
  const structural = signals.some((s) =>
    ["objdiff-report", "decomp-toolkit", "hash-file", "decomp-tooling", "has-source"].includes(s.id),
  );
  const verdict: Verdict =
    !structural ? "unlikely" : score >= LIKELY_AT ? "likely" : score >= POSSIBLE_AT ? "possible" : "unlikely";
  return { fullName: f.fullName, score, verdict, signals, hashEvidence, reportArtifacts: f.reportArtifacts };
}
