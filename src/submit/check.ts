import { normalizeRepo, readCatalog, type Config, type Game, type Project } from "../catalog.ts";
import { deepCheck } from "../discover/deep.ts";
import { fetchFacts, repoFromUrl, type RepoFacts } from "../discover/facts.ts";
import { assess, type Assessment } from "../discover/signals.ts";
import { hexDigests, repoEvidence } from "../identify/evidence.ts";
import { identify, type Identification } from "../identify/identify.ts";
import type { GameIndex } from "../identify/index.ts";
import type { GitHub } from "../ingest/http.ts";
import { parseDecompendium, parseObjdiff, sanityErrors } from "../ingest/parsers.ts";
import { fetchSource } from "../ingest/sources.ts";
import { IngestError } from "../ingest/types.ts";
import { percent } from "../site/model.ts";
import { platformName } from "../site/format.ts";
import { makeDraft, type Draft } from "./draft.ts";
import type { Submission } from "./form.ts";

export type ItemStatus = "pass" | "warn" | "fail" | "info";

export interface CheckItem {
  status: ItemStatus;
  text: string;
}

export interface CheckResult {
  items: CheckItem[];
  blocked: boolean; // a "fail": the submission can't be approved as it stands
  facts: RepoFacts | null;
  assessment: Assessment | null;
  identification: Identification | null;
  submitterMaintains: boolean;
  draft: Draft | null;
}

export interface CheckContext {
  github: GitHub;
  root: string;
  index: GameIndex | null;
  author: string; // the issue's author
  today: string;
  siteOrigin?: string;
}

/** Run every check on a submission. Network reads only; nothing is written. */
export async function checkSubmission(sub: Submission, ctx: CheckContext): Promise<CheckResult> {
  const items: CheckItem[] = [];
  const add = (status: ItemStatus, text: string) => items.push({ status, text });
  const result: CheckResult = { items, blocked: false, facts: null, assessment: null, identification: null, submitterMaintains: false, draft: null };
  const site = (ctx.siteOrigin ?? "https://decompendium.com").replace(/\/$/, "");

  const raw = readCatalog(ctx.root);
  const config = raw.config!.data as Config;
  const games = raw.games.map((g) => g.data as Game);
  const projects = raw.projects.map((p) => p.data as Project);

  // 1. The repository.
  const name = repoFromUrl(sub.repo);
  if (!name) {
    let host = "";
    try {
      host = new URL(sub.repo).hostname;
    } catch {}
    if (host && config.allowed_hosts.includes(host)) {
      add("warn", `Only GitHub repositories can be checked automatically; a maintainer will review ${sub.repo} by hand.`);
    } else add("fail", `"${sub.repo}" isn't a repository URL on an allowed host (${config.allowed_hosts.join(", ")}).`);
    return finish(result);
  }
  const facts = await fetchFacts(ctx.github, name);
  if (!facts) {
    add("fail", `Repository ${name} wasn't found, or isn't public.`);
    return finish(result);
  }
  result.facts = facts;
  const key = normalizeRepo(facts.url);
  const listed = projects.find((p) => normalizeRepo(p.repo) === key);
  if (listed) add("fail", `Already listed: [${listed.name}](${site}/projects/${listed.id}/).`);
  if (config.opted_out.some((u) => normalizeRepo(u) === key)) add("fail", "Its maintainers opted out of being listed; only they can reverse that.");
  const excluded = (config.excluded ?? []).find((e) => normalizeRepo(e.repo) === key);
  if (excluded) add("warn", `A catalog maintainer excluded this repo before: "${excluded.reason}".`);
  add("pass", `Found [${facts.fullName}](${facts.url})${facts.archived ? " (archived)" : ""}${facts.fork ? " (a fork)" : ""}.`);

  // 2. Does it look like a matching decomp?
  const a = assess(facts);
  result.assessment = a;
  const summary = a.signals.filter((s) => s.weight > 0).map((s) => s.id).join(", ");
  if (a.verdict === "unlikely") add("warn", `Doesn't look much like a matching decomp yet (score ${a.score}: ${summary || "no strong signals"}).`);
  else add("pass", `Looks like a matching decomp (score ${a.score}: ${summary}).`);

  // 3. Does the build verify a hash of the original? (Required to list.)
  if (a.hashEvidence.length) add("pass", `Hash the build checks: ${a.hashEvidence.slice(0, 3).map((h) => `\`${h}\``).join(", ")}.`);
  const deep = await deepCheck(ctx.github, facts);
  if (deep.hashCheck) add("pass", `Hash comparison in the build: \`${deep.hashCheck}\`.`);
  if (!a.hashEvidence.length && !deep.hashCheck) {
    add("warn", "No hash file or hash comparison found. Listing needs a build that checks its output against a hash of the original.");
  }

  // 4. Which game is it?
  if (ctx.index) {
    const evidence = await repoEvidence(ctx.github, facts);
    evidence.hashes.push(...hexDigests(sub.targets));
    const id = identify(evidence, ctx.index);
    result.identification = id;
    if (id.nonGame) add("fail", `This builds something that isn't a game: ${id.nonGame}. Only game decomps are listed.`);
    else if (id.title) {
      const where = id.releases.slice(0, 3).map((r) => `${r.name} (${r.via})`).join("; ");
      add("pass", `Game: **${id.title}** on ${platformName(id.platform!)}, from ${where}.`);
      if (sub.platform && sub.platform !== id.platform) add("warn", `The form says ${platformName(sub.platform)}, but the evidence says ${platformName(id.platform!)}.`);
    } else {
      add("warn", `Couldn't confirm the game from ROM hashes or product codes, so the game name from the form ("${sub.game}") will be used. A maintainer will check it's a game.`);
    }
  } else add("info", "Game identification is unavailable in this run.");

  // 5. Progress data.
  const progress = await checkProgress(facts, sub, ctx);
  add(progress.status, progress.text);

  // 6. Does the submitter maintain it? (Only decides whether the entry starts confirmed.)
  try {
    const perm = await ctx.github.get<{ permission: string }>(`/repos/${facts.fullName}/collaborators/${encodeURIComponent(ctx.author)}/permission`);
    result.submitterMaintains = !!perm && ["admin", "maintain", "write"].includes(perm.permission);
  } catch {
    result.submitterMaintains = false; // the bot can't see other repos' collaborators; that's fine
  }
  if (result.submitterMaintains) add("pass", `@${ctx.author} has push access, so the entry will start as maintainer confirmed.`);
  else if (sub.isMaintainer) add("info", "Couldn't verify push access from here; a maintainer can confirm the entry later.");

  // 7. A draft catalog entry for /approve, unless something above rules it out.
  if (!items.some((i) => i.status === "fail")) {
    result.draft = await makeDraft({
      github: ctx.github,
      facts,
      submission: sub,
      identification: result.identification ?? { status: "unconfirmed", title: null, platform: null, releases: [], nonGame: null, aliases: [] },
      games,
      projectIds: new Set(projects.map((p) => p.id)),
      submitterMaintains: result.submitterMaintains,
      today: ctx.today,
    });
    if (!result.draft.project.targets.length) {
      add("fail", "No versions to list: add the versions it builds, each with the hash its build checks, under \"Versions it builds\".");
    }
    const g = result.draft.game;
    const others = projects.filter((p) => p.game === g.id);
    if (result.draft.gameExists && others.length) {
      add("info", `${g.name} already has ${others.length} listed ${others.length === 1 ? "project" : "projects"} ([game page](${site}/games/${g.id}/)). That's fine: duplicates are listed too.`);
    }
  }
  return finish(result);
}

function finish(r: CheckResult): CheckResult {
  r.blocked = r.items.some((i) => i.status === "fail");
  return r;
}

async function checkProgress(f: RepoFacts, sub: Submission, ctx: CheckContext): Promise<CheckItem> {
  const limits = { report_download_bytes: 104857600, report_read_bytes: 52428800, report_store_bytes: 0, fetch_timeout_seconds: 60 };
  const url = /^https:\/\//.test(sub.report) ? sub.report : null;
  const artifact = f.reportArtifacts[0] ?? (/^\S+_report\b/.exec(sub.report)?.[0] ?? null);
  if (!url && !artifact) return { status: "info", text: "No progress reports found; the project will be listed without progress data." };
  try {
    const source = url
      ? ({ type: "url", url } as const)
      : ({ type: "github-artifact", artifact: artifact!, path: /\b[\w./-]+\.json\b/.exec(sub.report.replace(artifact!, ""))?.[0] ?? "report.json" } as const);
    const fetched = await fetchSource(source, {
      fetch: globalThis.fetch,
      github: ctx.github,
      limits,
      repo: f.url,
      defaultBranch: async () => f.defaultBranch,
      previous: {},
    });
    if (fetched.status !== "fetched") return { status: "warn", text: `Report ${url ?? artifact} wasn't available.` };
    let parsed;
    try {
      parsed = parseObjdiff(fetched.bytes);
    } catch {
      parsed = parseDecompendium(fetched.bytes);
    }
    const problems = sanityErrors(parsed.measures);
    if (problems.length) return { status: "warn", text: `Report ${url ?? artifact} parsed, but: ${problems.join("; ")}.` };
    return { status: "pass", text: `Progress report \`${url ?? artifact}\` reads ${percent(parsed.measures.code)} matched code${parsed.measures.linked ? `, ${percent(parsed.measures.linked)} fully linked` : ""}.` };
  } catch (err) {
    const msg = err instanceof IngestError ? err.message : (err as Error).message;
    return { status: "warn", text: `Couldn't read progress report ${url ?? artifact}: ${msg}.` };
  }
}

const MARK: Record<ItemStatus, string> = { pass: "✅", warn: "⚠️", fail: "❌", info: "ℹ️" };

/** The bot's issue comment. The marker lets the bot find and update its own comment. */
export const COMMENT_MARKER = "<!-- decompendium-submission-check -->";

export function renderComment(r: CheckResult, draftYaml: string | null): string {
  const lines = [
    COMMENT_MARKER,
    "### Submission checks",
    "",
    ...r.items.map((i) => `- ${MARK[i.status]} ${i.text}`),
    "",
    r.blocked
      ? "**Needs attention** before it can be listed (see ❌ above). Edit the issue to re-run these checks."
      : "**Ready for review.** A catalog maintainer can comment `/approve` to open a catalog PR with the entry below.",
  ];
  if (r.draft && draftYaml && r.draft.project.targets.length) {
    lines.push("", "<details><summary>Draft catalog entry</summary>", "", "```yaml", draftYaml.trimEnd(), "```", "</details>");
    if (r.draft.problems.length) lines.push("", ...r.draft.problems.map((p) => `- ⚠️ ${p}`));
  }
  lines.push("", "<sub>Updated automatically. Edit the issue to check again.</sub>");
  return lines.join("\n");
}
