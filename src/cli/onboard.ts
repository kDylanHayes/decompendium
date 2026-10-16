// Batch-onboard finder candidates into the catalog, with the same checks and
// drafts as the submission bot. Clear cases are written into catalog/; repos
// whose game couldn't be confirmed go to review as submission issues; the rest
// are held with a reason for a maintainer.
//
// Usage: node src/cli/onboard.ts --ledger data/discover.json [--status likely] [--limit 400]
//                                [--state onboard-state.json] [--report onboard.md] [--write]
//                                [--submit --repo owner/catalog [--pace 240] [--max-issues 15]]
// Without --write nothing is written to catalog/; without --submit no issues
// are opened. Resumable: decisions are kept in --state, so a run stopped by the
// API rate limit continues where it left off.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { normalizeRepo, readCatalog, type Project } from "../catalog.ts";
import { setTimeout as sleep } from "node:timers/promises";
import { titleFromDescription } from "../identify/identify.ts";
import { readIndex } from "../identify/index.ts";
import { GitHub } from "../ingest/http.ts";
import { StopRunError } from "../ingest/types.ts";
import { readLedger } from "../discover/run.ts";
import { checkSubmission } from "../submit/check.ts";
import { gameYaml, projectYaml } from "../submit/draft.ts";
import { issueBody, readSubmission, type Submission } from "../submit/form.ts";

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
    submit: { type: "boolean", default: false },
    repo: { type: "string", default: "kDylanHayes/decompendium" },
    // The check bot runs on the catalog repo's GITHUB_TOKEN (1,000 requests an
    // hour), so issues are opened a few minutes apart.
    pace: { type: "string", default: "240" },
    "max-issues": { type: "string", default: "15" },
  },
});

interface Decision {
  repo: string;
  action: "add" | "hold" | "review";
  reason: string;
  guess?: string; // title from the description, for review issues
  issue?: number;
  project?: string;
  game?: string;
  newGame?: boolean;
  platform?: string;
  targets?: number;
}
// Platform words in repo names. A name naming another platform than the game's
// own ("sf64-dc", "oot-PSP") is a port, not a decomp of that release.
const PLATFORM_WORDS: Record<string, string> = {
  dc: "dc", dreamcast: "dc", psp: "psp", "3ds": "3ds", n3ds: "3ds", pc: "win32", windows: "win32", win: "win32",
  win32: "win32", linux: "win32", switch: "switch", nx: "switch", vita: "vita", android: "android", anbernic: "android",
  wiiu: "wiiu", ps2: "ps2", ps3: "ps3", ps1: "ps1", psx: "ps1", gc: "gc", gcn: "gc", ngc: "gc", gamecube: "gc",
  wii: "wii", n64: "n64", nds: "nds", gba: "gba", xbox: "xbox", x360: "x360",
};
function portHint(fullName: string, platform: string): string | null {
  const name = fullName.split("/")[1]!;
  if (/^Open[A-Z]/.test(name)) return `named like a reimplementation ("${name}")`;
  const words = name.replace(/([a-z0-9])([A-Z])/g, "$1 $2").split(/[^A-Za-z0-9]+/).map((w) => w.toLowerCase());
  for (const w of words) {
    const other = PLATFORM_WORDS[w];
    if (other && other !== platform) return `named like a port to ${w} (the game is on ${platform})`;
  }
  return null;
}
const COPY_NAME = /(^|[-_ ])(test(ing)?|copy|backup|mirror|old|archive|fork)$|[-_ ]?20\d\d$/i;

const root = resolve(values.root!);
const statePath = resolve(values.state!);
const state: Record<string, Decision> = existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : {};
// States from before the review route held unconfirmed games.
for (const d of Object.values(state)) if (d.action === "hold" && d.reason.startsWith("game not confirmed")) d.action = "review";
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
    let review = false;
    if (!f || !a) reason = fails[0] ?? "repository not available";
    else if (result.blocked) reason = fails.join(" ");
    else if (a.verdict !== "likely") reason = `rated ${a.verdict} (score ${a.score}) under the current rules`;
    else if (!a.hashEvidence.length && !result.hashCheck) reason = "no hash evidence found";
    else if (!id || id.status !== "identified") {
      const guess = titleFromDescription(f.description);
      reason = `game not confirmed${guess ? ` (description says "${guess}")` : ""}`;
      review = true;
    } else if (!result.draft || !result.draft.project.targets.length) reason = "no versions to list";
    else {
      const draft = result.draft;
      const others = raw.projects.filter((p) => (p.data as Project).game === draft.game.id);
      const port = portHint(f.fullName, draft.game.platform);
      if (port) reason = port;
      else if (COPY_NAME.test(f.fullName.split("/")[1]!)) reason = "named like a copy or test repo";
      // Duplicates are listed, but a low-star repo for an already-covered game is often a re-upload.
      else if (draft.gameExists && others.length && f.stars < 3) {
        reason = `${draft.game.name} is already covered by ${others.map((p) => (p.data as Project).id).join(", ")}; low-star duplicate (${f.stars} stars), check it isn't a copy`;
      }
    }
    if (review) {
      const guess = titleFromDescription(f!.description);
      state[key] = { repo: fullName, action: "review", reason: reason!, ...(guess ? { guess } : {}) };
      console.log(`review ${fullName}: ${reason}`);
      continue;
    }
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

// Open submission issues for the review decisions, paced, skipping repos that
// already have a submission issue (open or closed) or are listed.
let opened = 0;
if (values.submit && !stopped) {
  const existing = new Set<string>();
  for (let page = 1; ; page++) {
    const issues = await github.get<{ body: string | null; pull_request?: unknown }[]>(
      `/repos/${values.repo}/issues?labels=submission&state=all&per_page=100&page=${page}`,
    );
    if (!issues?.length) break;
    for (const i of issues) if (!i.pull_request && i.body) existing.add(normalizeRepo(readSubmission(i.body).repo));
  }
  const listed = new Set(readCatalog(root).projects.map((p) => normalizeRepo((p.data as Project).repo)));
  for (const d of Object.values(state)) {
    if (d.action !== "review" || d.issue || opened >= Number(values["max-issues"])) continue;
    const url = `https://github.com/${d.repo}`;
    if (existing.has(normalizeRepo(url)) || listed.has(normalizeRepo(url))) continue;
    if (opened) await sleep(Number(values.pace) * 1000);
    const sub: Submission = {
      repo: url,
      game: d.guess ?? "",
      platform: null,
      targets: "",
      progress: "Not sure",
      report: "",
      aiPolicy: "unspecified",
      isGame: true,
      verifiesHash: true,
      isMaintainer: false,
      notes: `Submitted by the Decompendium finder for review: ${d.reason}. The boxes above are the finder's reading, not the maintainers'; check that it's a game and the build verifies a hash before approving.`,
    };
    const issue = await github.send<{ number: number }>("POST", `/repos/${values.repo}/issues`, {
      title: `Submit: ${d.guess ?? d.repo}`,
      body: issueBody(sub),
      labels: ["submission", "needs-checks", "from-finder"],
    });
    d.issue = issue!.number;
    opened++;
    save();
    console.log(`issue #${d.issue} for ${d.repo}`);
  }
}

const decisions = Object.values(state);
const added = decisions.filter((d) => d.action === "add");
const held = decisions.filter((d) => d.action === "hold" && d.reason !== "already listed");
const reviews = decisions.filter((d) => d.action === "review");
const report = [
  `### Onboarding: ${added.length} added, ${reviews.length} sent to review, ${held.length} held`,
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
  "#### Sent to review (game not confirmed)",
  "",
  "| Repo | Issue | Why |",
  "| --- | --- | --- |",
  ...reviews.map((d) => `| [${d.repo}](https://github.com/${d.repo}) | ${d.issue ? `#${d.issue}` : "not opened yet"} | ${d.reason.replace(/\|/g, "\\|")} |`),
  "",
  "#### Held for a maintainer",
  "",
  "| Repo | Why |",
  "| --- | --- |",
  ...held.sort((x, y) => x.reason.localeCompare(y.reason)).map((d) => `| [${d.repo}](https://github.com/${d.repo}) | ${d.reason.replace(/\|/g, "\\|")} |`),
].join("\n");
if (values.report) writeFileSync(values.report, report + "\n");
console.log(`\n${added.length} added, ${reviews.length} to review (${opened} issues opened now), ${held.length} held${stopped ? ` (stopped: ${stopped})` : ""}`);
