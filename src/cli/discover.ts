// Find repositories that look like matching decomps and are not in the catalog yet.
// Nothing is added to the catalog: the output is a list for a maintainer to review.
//
// Usage: node src/cli/discover.ts [--state data/discover.json] [--limit 400] [--out report.md]
//                                 [--evaluate known-good.txt]
// --evaluate scores the run against a local list of known matching projects (one
// GitHub URL per line) to measure search recall and scorer accuracy. The list is
// only read, never stored.
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { GitHub } from "../ingest/http.ts";
import { canonicalName, repoFromUrl } from "../discover/facts.ts";
import { evaluate, readState, runDiscover } from "../discover/run.ts";

const { values } = parseArgs({
  options: {
    root: { type: "string", default: "." },
    state: { type: "string", default: "data/discover.json" },
    limit: { type: "string", default: "400" },
    out: { type: "string" },
    evaluate: { type: "string" },
  },
});

const statePath = resolve(values.state!);
const github = new GitHub(fetch, process.env.GITHUB_TOKEN || undefined, 60_000);
const result = await runDiscover({
  root: resolve(values.root!),
  github,
  state: readState(statePath),
  limit: Number(values.limit),
  log: (line) => console.log(line),
});
mkdirSync(dirname(statePath), { recursive: true });
writeFileSync(statePath, JSON.stringify(result.state, null, 1) + "\n");

const skippedCounts: Record<string, number> = {};
for (const reason of Object.values(result.skipped)) {
  const key = reason.startsWith("tool:") ? "tool" : reason;
  skippedCounts[key] = (skippedCounts[key] ?? 0) + 1;
}

const lines = [
  "### Discovery",
  "",
  `Candidates found: ${result.candidates.size}. Skipped: ${Object.entries(skippedCounts).map(([k, v]) => `${v} ${k}`).join(", ") || "none"}.`,
  `Assessed: ${result.assessed.size}. Still to check: ${result.pending}. API requests: ${github.requests}.`,
  ...(result.stopped ? [`Stopped early: ${result.stopped}`] : []),
  "",
  "| Score | Verdict | Repository | Hash evidence | Reports | Note |",
  "| ---: | --- | --- | --- | --- | --- |",
  ...result.suggestions.map(
    (a) =>
      `| ${a.score} | ${a.verdict} | [${a.fullName}](https://github.com/${a.fullName}) | ${a.hashEvidence[0] ?? "none found"} | ${a.reportArtifacts.slice(0, 2).join(", ") || "—"} | ${a.overlaps.length ? `same version as listed ${a.overlaps.join(", ")} (fork rule)` : ""} |`,
  ),
];

if (values.evaluate) {
  const listed = readFileSync(values.evaluate, "utf8").split("\n").map(repoFromUrl).filter((n): n is string => !!n);
  // Compare by current name: repos on the list may have been renamed or moved.
  const known: string[] = [];
  for (const name of listed) known.push((await canonicalName(github, name)) ?? name);
  const ev = evaluate(result, known);
  lines.push(
    "",
    "### Evaluation against the known-good list",
    "",
    `Found by search: ${ev.found}/${ev.total}. Passed prefilter: ${ev.passedPrefilter}. ` +
      `Scored likely ${ev.likely}, possible ${ev.possible}, unlikely ${ev.unlikely}; not assessed yet ${ev.notAssessed}.`,
    "",
    ...ev.misses.map((m) => `- ${m.name}: ${m.reason}`),
  );
}

const report = lines.join("\n") + "\n";
console.log("\n" + report);
if (values.out) writeFileSync(values.out, report);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, report);
