// Identify the game a repo builds, or build the identification index.
// Usage: node src/cli/identify.ts --build [--index .cache/game-index.json]
//        node src/cli/identify.ts owner/name [owner/name...] [--index ...]
// The index is derived from libretro-database (CC BY-SA 4.0) and stays local;
// it is never committed or published.
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { fetchFacts } from "../discover/facts.ts";
import { repoEvidence } from "../identify/evidence.ts";
import { identify } from "../identify/identify.ts";
import { buildIndex, readIndex, writeIndex } from "../identify/index.ts";
import { GitHub } from "../ingest/http.ts";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    index: { type: "string", default: ".cache/game-index.json" },
    build: { type: "boolean", default: false },
  },
});
const indexPath = resolve(values.index!);

if (values.build) {
  const index = await buildIndex(fetch, (line) => console.log(line));
  writeIndex(indexPath, index);
  console.log(`Index: ${Object.keys(index.codes).length} product codes, ${Object.keys(index.hashes).length} ROM hashes -> ${indexPath}`);
}

if (positionals.length) {
  const index = readIndex(indexPath);
  if (!index) {
    console.error(`No index at ${indexPath}; run with --build first.`);
    process.exit(2);
  }
  const github = new GitHub(fetch, process.env.GITHUB_TOKEN || undefined, 60_000);
  for (const name of positionals) {
    const facts = await fetchFacts(github, name);
    if (!facts) {
      console.log(`${name}: not found`);
      continue;
    }
    const result = identify(await repoEvidence(github, facts), index);
    console.log(
      `${facts.fullName}: ${result.status}` +
        (result.title ? ` -> ${result.title} [${result.platform}]` : "") +
        (result.nonGame ? ` NOT A GAME: ${result.nonGame}` : "") +
        (result.releases.length ? `\n  ${result.releases.slice(0, 4).map((r) => `${r.name} (${r.via})`).join("\n  ")}` : ""),
    );
  }
}
