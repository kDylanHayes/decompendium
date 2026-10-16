// Batch-onboard finder candidates into the catalog, with the same checks and
// drafts as the submission bot. Clear cases are written into catalog/; the
// rest are held with a reason for a maintainer.
//
// Usage: node src/cli/onboard.ts --ledger data/discover.json [--status likely] [--limit 400]
//                                [--state onboard-state.json] [--report onboard.md] [--write]
// Without --write nothing is written to catalog/. Resumable: decisions are kept
// in --state, so a run stopped by the API rate limit continues where it left off.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { normalizeRepo, readCatalog, type Project } from "../catalog.ts";
import { titleFromDescription } from "../identify/identify.ts";
import { readIndex } from "../identify/index.ts";
import { GitHub } from "../ingest/http.ts";
import { StopRunError } from "../ingest/types.ts";
import { readLedger } from "../discover/run.ts";
import { checkSubmission } from "../submit/check.ts";
import { gameYaml, projectYaml } from "../submit/draft.ts";
import type { Submission } from "../submit/form.ts";

const { values } = parseArgs({
  options: {
    root: { type: "string", default: "." },
    ledger: { type: "string", default: "data/discover.json" },
    status: { type: "string", default: "likely" },
    limit: { type: "string", default: "400" },
    state: { type: "string", default: ".cache/onboard-state.json" },
    report: { type: "string" },
    index: { type: "string", default: ".cache/game-index.json" },
    write: { type: "boolean", default: false },
  },
});

interface Decision {
  repo: string;
  action: "add" | "hold";
  reason: string;
  project?: string;
  game?: string;
  newGame?: boolean;
  platform?: string;
  targets?: number;
}
const root = resolve(values.root!);
const statePath = resolve(values.state!);
const state: Record<string, Decision> = existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : {};
const save = () => {
  mkdirSync(dirname(statePath), { recursive: true });
  writeFileSync(statePath, JSON.stringify(state, null, 1));
};

const index = readIndex(resolve(values.index!));
if (!index) {
  console.error("No game index; run `pnpm identify --build` first.");
  process.exit(2);
}
const github = new GitHub(fetch, process.env.GITHUB_TOKEN || undefined, 60_000);
const ledger = readLedger(resolve(values.ledger!));
const wanted = new Set(values.status!.split(","));
const candidates = Object.entries(ledger.repos)
  .filter(([, e]) => wanted.has(e.status))
  .sort((a, b) => b[1].assessment.score - a[1].assessment.score)
  .map(([, e]) => e.assessment.fullName);

let processed = 0;
let stopped: string | null = null;
for (const fullName of candidates) {
  if (processed >= Number(values.limit)) break;
  const key = fullName.toLowerCase();
  if (state[key]) continue;

  // Re-read the catalog each time: earlier additions in this run count (shared games, ids).
  const raw = readCatalog(root);

  const url = `https://github.com/${fullName}`;
  const listed = raw.projects.some((p) => normalizeRepo((p.data as Project).repo) === normalizeRepo(url));
  if (listed) {
    state[key] = { repo: fullName, action: "hold", reason: "already listed" };
    continue;
  }
  processed++;
  const submission: Submission = {
    repo: url,
    game: "",
    platform: null,
    targets: "",
    progress: "",
    report: "",
    aiPolicy: "unspecified",
    isGame: true,
    verifiesHash: true,
    isMaintainer: false,
    notes: "",
  };
  try {
    const result = await checkSubmission(submission, {
      github,
      root,
      index,
      author: "decompendium-onboard",
      today: new Date().toISOString().slice(0, 10),
      skipProgress: true,
    });
    const f = result.facts;
    const a = result.assessment;
    const id = result.identification;
    const fails = result.items.filter((i) => i.status === "fail").map((i) => i.text);
    let reason: string | null = null;
    if (!f || !a) reason = fails[0] ?? "repository not available";
    else if (result.blocked) reason = fails.join(" ");
    else if (a.verdict !== "likely") reason = `rated ${a.verdict} (score ${a.score}) under the current rules`;
    else if (!a.hashEvidence.length && !result.hashCheck) reason = "no hash evidence found";
    else if (!id || id.status !== "identified") {
      const guess = titleFromDescription(f.description);
      reason = `game not confirmed${guess ? ` (description says "${guess}")` : ""}`;
    } else if (!result.draft || !result.draft.project.targets.length) reason = "no versions to list";
    if (reason || !result.draft) {
      state[key] = { repo: fullName, action: "hold", reason: reason ?? "no draft" };
      console.log(`hold ${fullName}: ${state[key]!.reason}`);
      continue;
    }
    const { game, gameExists, project } = result.draft;
    if (f!.archived) project.status = "archived";
    if (values.write) {
      const gamePath = join(root, "catalog/games", `${game.id}.yaml`);
      if (!gameExists && !existsSync(gamePath)) writeFileSync(gamePath, gameYaml(game));
      writeFileSync(join(root, "catalog/projects", `${project.id}.yaml`), projectYaml(project));
    }
    state[key] = {
      repo: fullName,
      action: "add",
      reason: result.hashCheck ? `build checks a hash` : `hash file ${a!.hashEvidence[0]}`,
      project: project.id,
      game: game.name,
      newGame: !gameExists,
      platform: game.platform,
      targets: project.targets.length,
    };
    console.log(`add  ${fullName} -> ${project.id} (${game.name}, ${game.platform}, ${project.targets.length} targets)`);
  } catch (err) {
    if (err instanceof StopRunError) {
      stopped = err.message;
      break;
    }
    state[key] = { repo: fullName, action: "hold", reason: `error: ${(err as Error).message}` };
    console.log(`hold ${fullName}: error ${(err as Error).message}`);
  } finally {
    save();
  }
}
save();

const decisions = Object.values(state);
const added = decisions.filter((d) => d.action === "add");
const held = decisions.filter((d) => d.action === "hold" && d.reason !== "already listed");
const report = [
  `### Onboarding: ${added.length} added, ${held.length} held`,
  "",
  ...(stopped ? [`Stopped early: ${stopped}. Run again to continue.`, ""] : []),
  `Candidates: ${candidates.length} (${[...wanted].join(", ")}). API requests this run: ${github.requests}.`,
  "",
  "#### Added",
  "",
  "| Project | Game | Platform | Targets | Repo | Evidence |",
  "| --- | --- | --- | ---: | --- | --- |",
  ...added
    .sort((x, y) => (x.platform ?? "").localeCompare(y.platform ?? "") || (x.game ?? "").localeCompare(y.game ?? ""))
    .map((d) => `| ${d.project} | ${d.game}${d.newGame ? "" : " (existing game)"} | ${d.platform} | ${d.targets} | [${d.repo}](https://github.com/${d.repo}) | ${d.reason} |`),
  "",
  "#### Held for a maintainer",
  "",
  "| Repo | Why |",
  "| --- | --- |",
  ...held.sort((x, y) => x.reason.localeCompare(y.reason)).map((d) => `| [${d.repo}](https://github.com/${d.repo}) | ${d.reason.replace(/\|/g, "\\|")} |`),
].join("\n");
if (values.report) writeFileSync(values.report, report + "\n");
console.log(`\n${added.length} added, ${held.length} held${stopped ? ` (stopped: ${stopped})` : ""}`);
