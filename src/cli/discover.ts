// Find repositories that look like matching decomps and are not in the catalog yet.
// Nothing is added to the catalog: the output is a list for a maintainer to review.
//
// Usage: node src/cli/discover.ts [--ledger data/discover.json] [--budget 900] [--wide]
//                                 [--out report.md] [--evaluate known-good.txt]
// --budget   API calls to spend inspecting repos this run (searches are extra)
// --wide     also run broad searches; triage discards most of their results for free
// --evaluate measure the run against a local list of known matching projects (one
//            GitHub URL per line). The list is only read, never stored.
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { canonicalName, repoFromUrl } from "../discover/facts.ts";
import { evaluate, readLedger, runDiscover, serializeLedger } from "../discover/run.ts";
import { GitHub } from "../ingest/http.ts";

const { values } = parseArgs({
  options: {
    root: { type: "string", default: "." },
    ledger: { type: "string", default: "data/discover.json" },
    budget: { type: "string", default: "900" },
    wide: { type: "boolean", default: false },
    out: { type: "string" },
    evaluate: { type: "string" },
  },
});

const ledgerPath = resolve(values.ledger!);
const github = new GitHub(fetch, process.env.GITHUB_TOKEN || undefined, 60_000);
const result = await runDiscover({
  root: resolve(values.root!),
  github,
  ledger: readLedger(ledgerPath),
  budget: Number(values.budget),
  wide: values.wide,
  log: (line) => console.log(line),
});
mkdirSync(dirname(ledgerPath), { recursive: true });
writeFileSync(ledgerPath, serializeLedger(result.ledger));

const tally = (reasons: string[]) => {
  const counts: Record<string, number> = {};
  for (const r of reasons) {
    const key = r.replace(/:.*$/, "");
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${v} ${k}`).join(", ") || "none";
};
const statuses = Object.values(result.ledger.repos).map((e) => e.status);
const count = (s: string) => statuses.filter((x) => x === s).length;
const row = (s: (typeof result.suggestions)[number]) =>
  `| ${s.score} | [${s.fullName}](https://github.com/${s.fullName}) | ${s.why} | ${s.hashEvidence[0] ?? "—"} | ${s.reportArtifacts.slice(0, 2).join(", ") || "—"} | ${s.overlaps.length ? `same version as listed ${s.overlaps.join(", ")}` : ""} |`;
const table = ["| Score | Repository | Why | Hash evidence | Reports | Note |", "| ---: | --- | --- | --- | --- | --- |"];
const likely = result.suggestions.filter((s) => s.status === "likely");
const possible = result.suggestions.filter((s) => s.status === "possible");

const lines = [
  "### Discovery",
  "",
  `Search found ${result.candidates.size} repos${values.wide ? " (wide)" : ""}. Ruled out for free: ${tally(Object.values(result.triaged))}.`,
  `Inspected this run: ${result.inspected} (${result.requests} API calls). Waiting: ${result.queued}, of which ${result.deferred} are weak candidates looked at only with spare budget.`,
  `Ledger: ${count("likely")} likely, ${count("possible")} possible, ${count("excluded")} excluded.`,
  ...(result.stopped ? [`Stopped early: ${result.stopped}`] : []),
  "",
  `#### Likely matching decomps (${likely.length})`,
  "",
  ...(likely.length ? [...table, ...likely.map(row)] : ["None yet."]),
  "",
  `#### Possible: needs a person (${possible.length})`,
  "",
  ...(possible.length ? [...table, ...possible.map(row)] : ["None."]),
  "",
  "To stop a repo being suggested, add it to `excluded` in config.yaml with a short reason.",
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
    `Found by search: ${ev.found}/${ev.total}. Kept by triage: ${ev.keptByTriage}. ` +
      `Inspected so far: likely ${ev.likely}, possible ${ev.possible}, excluded ${ev.excluded}; not inspected yet ${ev.notInspected}.`,
    "",
    ...ev.misses.map((m) => `- ${m.name}: ${m.reason}`),
  );
}

const report = lines.join("\n") + "\n";
console.log("\n" + report);
if (values.out) writeFileSync(values.out, report);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, report);
