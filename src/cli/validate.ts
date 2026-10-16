// Validate config.yaml and the catalog. Usage: node src/cli/validate.ts [root]
import { resolve } from "node:path";
import { validateCatalog } from "../validate.ts";

const root = resolve(process.argv[2] ?? ".");
const { problems, games, projects, targets } = validateCatalog(root);
const inActions = process.env.GITHUB_ACTIONS === "true";

for (const { file, message } of problems) {
  // Workflow commands put the error on the file in the PR's diff view.
  if (inActions) console.log(`::error file=${file}::${message.replace(/\r?\n/g, " ")}`);
  else console.error(`${file}: ${message}`);
}

const summary = `${games} games, ${projects} projects, ${targets} targets`;
if (problems.length) {
  console.error(`\n${problems.length} problem(s) found (${summary}).`);
  process.exit(1);
}
console.log(`Catalog OK: ${summary}.`);
