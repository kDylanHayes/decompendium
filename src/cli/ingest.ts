// Fetch progress for every catalog target and update the data branch checkout.
// Usage: node src/cli/ingest.ts [--data <dir>] [--root <dir>] [--only <project[/target]>]... [--new-only]
// Reads a GitHub token from GITHUB_TOKEN (needed for artifact downloads).
import { appendFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { runIngest } from "../ingest/run.ts";

const { values } = parseArgs({
  options: {
    data: { type: "string", default: "data" },
    root: { type: "string", default: "." },
    only: { type: "string", multiple: true },
    "new-only": { type: "boolean", default: false },
  },
});

const summary = await runIngest({
  root: resolve(values.root!),
  dataDir: resolve(values.data!),
  token: process.env.GITHUB_TOKEN || undefined,
  only: values.only,
  newOnly: values["new-only"],
  log: (line) => console.log(line),
});

const counts = new Map<string, number>();
for (const r of summary.results) counts.set(r.outcome, (counts.get(r.outcome) ?? 0) + 1);
const lines = [
  "### Ingestion",
  "",
  `Targets: ${summary.results.length} (${[...counts].map(([k, v]) => `${v} ${k}`).join(", ") || "none"}). API requests: ${summary.requests}.`,
  ...(summary.stopped ? ["", `Stopped early: ${summary.stopped}`] : []),
  ...(summary.newlyFailing.length ? ["", "Newly failing:", ...summary.newlyFailing.map((t) => `- ${t}`)] : []),
  ...summary.results.filter((r) => r.outcome === "failed").map((r) => `- \`${r.target}\`: ${r.detail}`),
  ...(summary.pruned.length ? ["", "Removed data for:", ...summary.pruned.map((p) => `- ${p}`)] : []),
];
console.log("\n" + lines.join("\n"));
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, lines.join("\n") + "\n");
