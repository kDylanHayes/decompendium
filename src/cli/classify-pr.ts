// Classify a pull request's catalog changes for review.
// Usage: PR_AUTHOR=<login> node src/cli/classify-pr.ts <base-ref>
// Compares HEAD against its merge base with <base-ref>. Exits 1 when the PR
// makes changes its author is not allowed to make.
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { parseYaml, type Config } from "../catalog.ts";
import { classifyChanges, type Change } from "../review.ts";

const baseRef = process.argv[2];
const outIndex = process.argv.indexOf("--out");
const outFile = outIndex > 0 ? process.argv[outIndex + 1] : undefined;
const author = process.env.PR_AUTHOR;
if (!baseRef || !author) {
  console.error("usage: PR_AUTHOR=<login> node src/cli/classify-pr.ts <base-ref>");
  process.exit(2);
}

const git = (...args: string[]) => execFileSync("git", args, { encoding: "utf8", maxBuffer: 64 << 20 });
const base = git("merge-base", baseRef, "HEAD").trim();

const changes: Change[] = git("diff", "--name-only", "--no-renames", base, "HEAD")
  .split("\n")
  .filter(Boolean)
  .map((path) => {
    let before: string | undefined;
    try {
      before = git("show", `${base}:${path}`);
    } catch {
      before = undefined; // added in this PR
    }
    const after = existsSync(path) ? readFileSync(path, "utf8") : undefined;
    return { path, before, after };
  });

// Read the maintainer list from the base branch so a PR cannot add its own author.
let configText: string;
try {
  configText = git("show", `${base}:config.yaml`);
} catch {
  configText = readFileSync("config.yaml", "utf8"); // first PR: no config on the base branch yet
}
const config = parseYaml(configText) as Config;

const result = classifyChanges(changes, author, config);
const lines = [
  `### Review classification: \`${result.verdict}\``,
  "",
  ...result.notes.map((n) => `- ${n}`),
  ...(result.violations.length ? ["", "**Not allowed:**", ...result.violations.map((v) => `- ${v}`)] : []),
];
console.log(lines.join("\n"));
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, lines.join("\n") + "\n");
if (outFile) writeFileSync(outFile, JSON.stringify(result));
if (result.violations.length) process.exit(1);
