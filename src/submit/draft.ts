import { normalizeName, type Game, type Project, type Target } from "../catalog.ts";
import type { RepoFacts } from "../discover/facts.ts";
import { hexDigests } from "../identify/evidence.ts";
import type { Identification } from "../identify/identify.ts";
import type { GitHub } from "../ingest/http.ts";
import type { Submission } from "./form.ts";

/** A proposed catalog entry, generated from a submission for a maintainer to review. */
export interface Draft {
  game: Game;
  gameExists: boolean;
  project: Project;
  problems: string[]; // what a maintainer needs to fill in by hand
}

export const slug = (s: string) =>
  s
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 64);

const REGION_SLUG: Record<string, string> = { USA: "us", Japan: "jp", Europe: "eu", Korea: "kr", Australia: "au", China: "cn" };
// The 4th character of a Nintendo product code is its region.
const CODE_REGION: Record<string, [string, string]> = { E: ["us", "USA"], J: ["jp", "Japan"], P: ["eu", "Europe"], K: ["kr", "Korea"], U: ["au", "Australia"] };
const regionFromCode = (code: string) => CODE_REGION[code[3] ?? ""]?.[0];
const regionNameFromCode = (code: string) => CODE_REGION[code[3] ?? ""]?.[1];

/** Find a catalog game with the same title or alias on the same platform. */
export function findGame(games: Game[], title: string, platform: string | null): Game | undefined {
  const key = normalizeName(title);
  return games.find(
    (g) => (platform === null || g.platform === platform) && [g.name, ...(g.aliases ?? [])].some((n) => normalizeName(n) === key),
  );
}

/** The hash of a decomp-toolkit version's main binary: the first line of config/<VER>/build.sha1. */
async function dtkHash(github: GitHub, f: RepoFacts, version: string): Promise<string | null> {
  const text = await github.getText(
    `/repos/${f.fullName}/contents/config/${encodeURIComponent(version)}/build.sha1?ref=${encodeURIComponent(f.defaultBranch)}`,
    "application/vnd.github.raw+json",
    5_000,
  );
  return hexDigests(text ?? "")[0] ?? null;
}

export async function makeDraft(opts: {
  github: GitHub;
  facts: RepoFacts;
  submission: Submission;
  identification: Identification;
  games: Game[];
  projectIds: Set<string>;
  submitterMaintains: boolean;
  today: string;
}): Promise<Draft> {
  const { github, facts: f, submission: sub, identification: id } = opts;
  const problems: string[] = [];

  // The game: an existing catalog game when one matches, else a new one.
  const title = id.title ?? sub.game;
  const platform = id.platform ?? sub.platform ?? "other";
  const existing = findGame(opts.games, title, platform) ?? (sub.game ? findGame(opts.games, sub.game, platform) : undefined);
  let gameId = existing?.id ?? slug(title);
  if (!existing && opts.games.some((g) => g.id === gameId)) gameId = `${gameId}-${platform}`;
  const game: Game = existing ?? {
    id: gameId,
    name: title,
    platform,
    ...(id.aliases.length ? { aliases: id.aliases.slice(0, 5) } : {}),
  };
  if (!id.title) problems.push("The game couldn't be confirmed; check the name and platform.");

  // Targets: decomp-toolkit versions first, then identified ROM hashes, then what the submitter typed.
  const targets: Target[] = [];
  const reports = new Set(f.reportArtifacts);
  const versions = [...new Set(f.paths.map((p) => /^config\/([^/]+)\/build\.sha1$/.exec(p)?.[1]).filter((v): v is string => !!v && v !== "GAMEID"))];
  for (const version of versions.slice(0, 20)) {
    const hash = await dtkHash(github, f, version);
    if (!hash) continue;
    const region = regionFromCode(version);
    const regionName = regionNameFromCode(version);
    targets.push({
      id: slug(version),
      label: regionName ? `${version} (${regionName})` : version,
      ...(region ? { region } : {}),
      hash: hash.length === 40 ? { sha1: hash } : { md5: hash },
      progress: reports.has(`${version}_report`)
        ? { kind: "objdiff", source: { type: "github-artifact", artifact: `${version}_report`, path: "report.json" } }
        : { kind: "none" },
    });
  }
  if (!targets.length) {
    for (const r of id.releases.filter((r) => r.match.kind === "hash")) {
      const region = REGION_SLUG[r.region ?? ""];
      const base = slug(r.name.replace(/^[^(]*/, "")) || "main";
      let tid = base;
      for (let n = 2; targets.some((t) => t.id === tid); n++) tid = `${base}-${n}`;
      targets.push({
        id: tid,
        label: r.name.replace(/^[^(]*\(/, "(").replace(/^\((.*)\)$/, "$1").replace(/\) \(/g, ", ") || r.name,
        ...(region ? { region } : {}),
        hash: r.match.value.length === 40 ? { sha1: r.match.value } : { md5: r.match.value },
        progress: { kind: "none" },
      });
    }
  }
  if (!targets.length) {
    // Hash files of other layouts: config/SLPM_86.053.sha1, configs/USA/checksum.sha, sm64.us.sha1.
    const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
    const stemOf = (path: string) => {
      const file = path.split("/").pop()!.replace(/\.(sha1|md5|sha)$/i, "");
      return /^checksum/i.test(file) ? (path.split("/").slice(-2, -1)[0] ?? "main") : file;
    };
    // A version's hash file, not a per-overlay or per-module one: skip those folders, then prefer
    // files named like a version (a product code, a region, or a report artifact's code).
    let files = f.paths.filter(
      (p) =>
        /\.(sha1|md5|sha)$|(^|\/)checksum[^/]*$/i.test(p) &&
        !/build\.sha1$|\.(tar|tgz|gz|zip|7z|exe|bin|xz)\.|^(bin|tools|ext|external|third_party|lib|libs)\/|\/(overlays?|ovl|modules?|objects?|labels|segments|assets)\//i.test(p),
    );
    const reportCodes = new Set(f.reportArtifacts.map((a) => norm(a.replace(/_report$/, ""))));
    const versionLike = (stem: string) =>
      reportCodes.has(norm(stem)) || /^[A-Z]{4}[-_ ]?\d{2,3}\.?\d{2,3}$/.test(stem) || /(^|[._-])(us|usa|jp|jpn|eu|eur|pal|ntsc|ntsc-u|ntsc-j|en|kr|cn)$/i.test(stem);
    const named = files.filter((p) => versionLike(stemOf(p)));
    if (named.length) files = named;
    else {
      const depth = (p: string) => p.split("/").length;
      const min = Math.min(...files.map(depth));
      files = files.filter((p) => depth(p) === min);
    }
    files = files.slice(0, 8);
    for (const path of files) {
      const text = await github.getText(
        `/repos/${f.fullName}/contents/${path.split("/").map(encodeURIComponent).join("/")}?ref=${encodeURIComponent(f.defaultBranch)}`,
        "application/vnd.github.raw+json",
        20_000,
      );
      const hash = hexDigests(text ?? "")[0];
      if (!hash) continue;
      let stem = stemOf(path); // configs/USA/checksum.sha → USA
      stem = stem.replace(/^[a-z0-9]+[._-](?=(us|usa|jp|jpn|eu|eur|pal|ntsc)$)/i, ""); // sm64.us → us
      const artifact = f.reportArtifacts.find((a) => norm(a.replace(/_report$/, "")) === norm(stem));
      let tid = slug(stem) || "main";
      for (let n = 2; targets.some((t) => t.id === tid); n++) tid = `${slug(stem) || "main"}-${n}`;
      targets.push({
        id: tid,
        label: stem.length <= 3 || /^(usa|jpn|eur|pal|ntsc)$/i.test(stem) ? stem.toUpperCase() : stem,
        hash: hash.length === 40 ? { sha1: hash } : { md5: hash },
        progress: artifact ? { kind: "objdiff", source: { type: "github-artifact", artifact, path: "report.json" } } : { kind: "none" },
      });
    }
  }
  if (!targets.length) {
    for (const line of sub.targets.split("\n")) {
      const hash = hexDigests(line)[0];
      if (!hash) continue;
      const label = line.replace(hash, "").replace(/\b(sha1|md5|sha256)\b:?/gi, "").replace(/[,`:]+\s*$/, "").replace(/\s+/g, " ").trim() || "Main";
      targets.push({ id: slug(label) || `target-${targets.length + 1}`, label, hash: hash.length === 40 ? { sha1: hash } : { md5: hash }, progress: { kind: "none" } });
    }
  }
  if (!targets.length) problems.push("No versions found: add at least one target with the hash its build checks.");
  // One generic objdiff report and one target: connect them.
  const generic = f.reportArtifacts.filter((a) => /^(us|jp|eu|usa|eur|pal)_report$/i.test(a));
  if (targets.length === 1 && targets[0]!.progress?.kind === "none" && f.reportArtifacts.length === 1) {
    targets[0]!.progress = { kind: "objdiff", source: { type: "github-artifact", artifact: f.reportArtifacts[0]!, path: "report.json" } };
  } else if (generic.length && targets.every((t) => t.progress?.kind === "none")) {
    problems.push(`Reports ${generic.join(", ")} exist but couldn't be matched to targets; connect them by hand.`);
  }

  // The project.
  const repoName = f.fullName.split("/")[1]!;
  let projectId = slug(repoName.replace(/[-_]?(decomp(ilation)?|disasm|disassembly)$/i, "")) || slug(repoName);
  if (opts.projectIds.has(projectId)) projectId = slug(repoName);
  for (let n = 2; opts.projectIds.has(projectId); n++) projectId = `${slug(repoName)}-${n}`;
  const kind = /disassembl/i.test(`${f.description} ${f.readme.slice(0, 500)}`) && !/decompil/i.test(f.description) ? "disassembly" : "decompilation";
  const project: Project = {
    id: projectId,
    name: `${game.name} ${kind}`,
    game: game.id,
    repo: f.url,
    description: `Matching ${kind} of ${game.name}.`,
    owners: [f.fullName.split("/")[0]!],
    confirmed: opts.submitterMaintains,
    ...(sub.aiPolicy !== "unspecified" ? { ai_policy: sub.aiPolicy } : {}),
    listed_at: opts.today,
    targets,
  };
  return { game, gameExists: !!existing, project, problems };
}

const q = (s: string) => JSON.stringify(s);

export function gameYaml(g: Game): string {
  return [
    "# yaml-language-server: $schema=../../schema/game.schema.json",
    `id: ${g.id}`,
    `name: ${q(g.name)}`,
    ...(g.aliases?.length ? [`aliases: [${g.aliases.map(q).join(", ")}]`] : []),
    `platform: ${g.platform}`,
    "",
  ].join("\n");
}

export function projectYaml(p: Project): string {
  const lines = [
    "# yaml-language-server: $schema=../../schema/project.schema.json",
    `id: ${p.id}`,
    `name: ${q(p.name)}`,
    `game: ${p.game}`,
    `repo: ${p.repo}`,
    `description: ${q(p.description)}`,
    `owners: [${p.owners.join(", ")}]  # repo owner; maintainers can replace this with their usernames`,
    `confirmed: ${p.confirmed ? "true" : "false"}`,
    ...(p.ai_policy ? [`ai_policy: ${p.ai_policy}`] : []),
    `listed_at: ${p.listed_at}`,
    "targets:",
  ];
  for (const t of p.targets) {
    const [algo, value] = Object.entries(t.hash)[0]!;
    lines.push(`  - id: ${t.id}`, `    label: ${q(t.label)}`);
    if (t.region) lines.push(`    region: ${t.region}`);
    lines.push(`    hash: { ${algo}: ${q(value!)} }`, "    progress:");
    const pr = t.progress;
    if (!pr || pr.kind === "none") lines.push("      kind: none");
    else if (pr.source.type === "github-artifact") {
      lines.push(`      kind: ${pr.kind}`, `      source: { type: github-artifact, artifact: ${pr.source.artifact}, path: ${pr.source.path} }`);
    } else lines.push(`      kind: ${pr.kind}`, `      source: { type: url, url: ${pr.source.url} }`);
  }
  return lines.join("\n") + "\n";
}
