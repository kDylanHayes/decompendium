// Fail if any Lighthouse JSON report scores below the minimum for accessibility
// (the spec's target); other categories are reported only.
// Usage: node scripts/lighthouse-check.mjs <min 0-1> report.json...
import { appendFileSync, readFileSync } from "node:fs";

const [min, ...files] = process.argv.slice(2);
const rows = [];
let failed = false;
for (const file of files) {
  const report = JSON.parse(readFileSync(file, "utf8"));
  const scores = Object.values(report.categories).map((c) => `${c.title} ${Math.round(c.score * 100)}`);
  if (report.categories.accessibility.score < Number(min)) failed = true;
  const failing = Object.values(report.audits)
    .filter((a) => a.score === 0 && a.scoreDisplayMode === "binary")
    .map((a) => a.id);
  rows.push(`| ${report.finalDisplayedUrl} | ${scores.join(", ")} | ${failing.join(", ") || "—"} |`);
}
const summary = ["### Lighthouse", "", "| Page | Scores | Failing audits |", "| --- | --- | --- |", ...rows].join("\n") + "\n";
console.log(summary);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
if (failed) {
  console.error(`Accessibility scored below ${Math.round(Number(min) * 100)} on at least one page.`);
  process.exit(1);
}
