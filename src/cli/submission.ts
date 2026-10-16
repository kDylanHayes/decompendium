// Submission bot: check a submitted project, or draft its catalog entry.
//
//   node src/cli/submission.ts check   --issue <n> [--index .cache/game-index.json] [--dry-run]
//   node src/cli/submission.ts approve --issue <n> [--index ...]
//
// check   posts (or updates) the bot's comment on the issue and sets the
//         ready-for-review / needs-info labels.
// approve writes the drafted game and project files into catalog/ and prints
//         the PR title and body for the workflow; it never commits.
// Reads GITHUB_TOKEN and GITHUB_REPOSITORY (owner/name of the catalog repo).
import { existsSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { readIndex } from "../identify/index.ts";
import { GitHub } from "../ingest/http.ts";
import { checkSubmission, COMMENT_MARKER, renderComment } from "../submit/check.ts";
import { gameYaml, projectYaml } from "../submit/draft.ts";
import { readSubmission } from "../submit/form.ts";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    issue: { type: "string" },
    index: { type: "string", default: ".cache/game-index.json" },
    root: { type: "string", default: "." },
    "dry-run": { type: "boolean", default: false },
    out: { type: "string" }, // approve: file for PR title/body (JSON)
  },
});
const command = positionals[0];
const repo = process.env.GITHUB_REPOSITORY ?? "kDylanHayes/decompendium";
const github = new GitHub(fetch, process.env.GITHUB_TOKEN || undefined, 60_000);
if (!values.issue || !/^\d+$/.test(values.issue) || (command !== "check" && command !== "approve")) {
  console.error("usage: submission.ts check|approve --issue <n>");
  process.exit(2);
}

interface Issue {
  number: number;
  title: string;
  body: string | null;
  state: string;
  user: { login: string };
  labels: { name: string }[];
}
const issue = (await github.get<Issue>(`/repos/${repo}/issues/${values.issue}`))!;
if (!issue.labels.some((l) => l.name === "submission")) {
  console.log(`#${issue.number} isn't a submission; nothing to do.`);
  process.exit(0);
}

const submission = readSubmission(issue.body ?? "");
const root = resolve(values.root!);
const result = await checkSubmission(submission, {
  github,
  root,
  index: readIndex(resolve(values.index!)),
  author: issue.user.login,
  today: new Date().toISOString().slice(0, 10),
});
const draftYaml = result.draft
  ? `${result.draft.gameExists ? "" : `# catalog/games/${result.draft.game.id}.yaml\n${gameYaml(result.draft.game)}\n`}# catalog/projects/${result.draft.project.id}.yaml\n${projectYaml(result.draft.project)}`
  : null;

if (command === "check") {
  const body = renderComment(result, draftYaml);
  console.log(body);
  if (values["dry-run"]) process.exit(0);
  // Update the bot's earlier comment if there is one, so the issue keeps a single report.
  const comments = (await github.get<{ id: number; body: string }[]>(`/repos/${repo}/issues/${issue.number}/comments?per_page=100`)) ?? [];
  const mine = comments.find((c) => c.body.startsWith(COMMENT_MARKER));
  if (mine) await github.send("PATCH", `/repos/${repo}/issues/comments/${mine.id}`, { body });
  else await github.send("POST", `/repos/${repo}/issues/${issue.number}/comments`, { body });
  const remove = ["needs-checks", result.blocked ? "ready-for-review" : "needs-info"];
  for (const label of remove) {
    if (issue.labels.some((l) => l.name === label)) {
      await github.send("DELETE", `/repos/${repo}/issues/${issue.number}/labels/${encodeURIComponent(label)}`);
    }
  }
  await github.send("POST", `/repos/${repo}/issues/${issue.number}/labels`, { labels: [result.blocked ? "needs-info" : "ready-for-review"] });
  process.exit(0);
}

// approve
if (result.blocked || !result.draft) {
  console.error(`#${issue.number} can't be approved yet: ${result.items.filter((i) => i.status === "fail").map((i) => i.text).join(" ")}`);
  process.exit(1);
}
const { game, gameExists, project, problems } = result.draft;
if (!project.targets.length) {
  console.error(`#${issue.number} has no targets to list; add versions with their hashes to the issue first.`);
  process.exit(1);
}
const gamePath = join(root, "catalog/games", `${game.id}.yaml`);
const projectPath = join(root, "catalog/projects", `${project.id}.yaml`);
if (!gameExists && !existsSync(gamePath)) writeFileSync(gamePath, gameYaml(game));
writeFileSync(projectPath, projectYaml(project));
const owner = project.owners[0];
const pr = {
  branch: `submission/${issue.number}-${project.id}`,
  title: `Add ${project.name}`,
  body: [
    `Closes #${issue.number}.`,
    "",
    `Adds [${project.repo.replace("https://github.com/", "")}](${project.repo}) as \`${project.id}\` under ${gameExists ? "the existing" : "a new"} game \`${game.id}\`, with ${project.targets.length} ${project.targets.length === 1 ? "target" : "targets"}. Generated from the submission; check the names, labels and hashes before merging.`,
    ...(problems.length ? ["", "Needs a look:", ...problems.map((p) => `- ${p}`)] : []),
    "",
    // The approval PR mentions the repo's maintainers once (POLICY.md 2).
    `@${owner}: your project is being listed on Decompendium. You can edit or remove the entry at any time; see https://decompendium.com/about/.`,
    "",
    "🤖 Generated by the Decompendium submission bot",
  ].join("\n"),
};
console.log(JSON.stringify(pr, null, 2));
if (values.out) writeFileSync(values.out, JSON.stringify(pr));
