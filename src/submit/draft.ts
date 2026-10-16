import { normalizeName, type Game, type Project, type Target } from "../catalog.ts";
import type { RepoFacts } from "../discover/facts.ts";
import { hexDigests } from "../identify/evidence.ts";
import type { Identification } from "../identify/identify.ts";
import { platformName } from "../site/format.ts";
import type { GitHub } from "../ingest/http.ts";
import type { Submission } from "./form.ts";

/** A proposed catalog entry, generated from a submission for a maintainer to review. */
export interface Draft {
  game: Game;
  gameExists: boolean;
  project: Project;
  problems: string[]; // what a maintainer needs to fill in by hand
  otherGames: string[]; // other games the same repo builds; each needs its own entry
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

// PlayStation serial prefixes by region: SLUS/SCUS are North America, SLES/SCES Europe, ...
const PS_REGION: Record<string, string> = { US: "USA", ES: "Europe", PS: "Japan", PM: "Japan", PD: "Japan", KA: "Korea", AJ: "Asia" };

/** A readable label for a version stem: "SLES_011.76" → "Europe (SLES-01176)", "us" → "US". */
export function versionLabel(stem: string): string {
  const ps = /^([A-Z]{2}([A-Z]{2}))[-_ ]?(\d{2,3})\.?(\d{2,3})$/i.exec(stem);
  if (ps && ps[3]!.length + ps[4]!.length === 5) {
    const serial = `${ps[1]!.toUpperCase()}-${ps[3]}${ps[4]}`;
    const region = PS_REGION[ps[2]!.toUpperCase()];
    return region ? `${region} (${serial})` : serial;
  }
  return stem.length <= 4 || /^(usa|jpn|eur|pal|ntsc)$/i.test(stem) ? stem.toUpperCase() : stem;
}

// Version names that only say which platform: sum-pc, game.win32, x360.
const PLATFORM_WORD = /(^|[-_.])(pc|win|win32|win64|windows|steam|dos|x360|xbox|xbox360|ps[1-5p]|psx|gc|wii|n64|switch|nds|gba)$/i;

/**
 * A target's label: readable serials and regions, the platform for names that only say
 * which platform ("sum-pc" → "PC"), and Xbox title ids spelled out.
 */
export function targetLabel(stem: string, platform: string): string {
  const word = PLATFORM_WORD.exec(stem)?.[2];
  if (word) return /^(pc|win|win32|win64|windows|steam)$/i.test(word) ? "PC" : platformName(platform);
  if (/^[0-9a-f]{8}$/i.test(stem) && /^(xbox|x360|xbone)$/.test(platform)) return `${platformName(platform)} (title ${stem.toUpperCase()})`;
  return versionLabel(stem);
}

/** The objdiff progress source for a report artifact, with the file name its workflow uploads. */
function objdiff(f: RepoFacts, artifact: string): Target["progress"] {
  return { kind: "objdiff", source: { type: "github-artifact", artifact, path: f.reportFiles[artifact] ?? "report.json" } };
}

/** A hash on a README line that names one of `names` (a version table: "| SLUS-20974 | 6d18… |"). */
export function readmeHash(readme: string, names: string[]): string | null {
  const norm = (x: string) => x.toLowerCase().replace(/[^a-z0-9]/g, "");
  const keys = names.map(norm).filter(Boolean);
  for (const line of readme.split("\n")) {
    const hash = hexDigests(line)[0];
    if (!hash) continue;
    // A table cell or word that is the name ("us"), or a long name anywhere on the line ("slus-20974").
    const rest = line.replace(hash, "");
    const cells = rest.split(/[|,;\t]|\s+/).map(norm);
    if (keys.some((k) => cells.includes(k) || (k.length >= 5 && norm(rest).includes(k)))) return hash;
  }
  return null;
}

type Release = Identification["releases"][number];

/**
 * The games among an identification's releases, the identified game first. Different
 * titles are regional names of one game unless they were released in the same region
 * (Digital Devil Saga and Digital Devil Saga 2 both have USA releases). Paired versions
 * that differ by one word (Pokémon Red and Pokémon Blue) are one game.
 */
export function gamesIn(id: Identification): { title: string; releases: Release[] }[] {
  const strip = (t: string) => t.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const regions = (rs: Release[]) => new Set(rs.flatMap((r) => (r.region ?? "").split(/,\s*/).filter(Boolean)));
  const sequel = (t: string) => / (\d+|ii|iii|iv|v)$/.exec(strip(t).replace(/ (the )?(\w+ )?(edition|version)$/, ""))?.[1] ?? "";
  const paired = (a: string, b: string) => {
    const wa = strip(a).split(" ");
    const wb = strip(b).split(" ");
    const onlyA = wa.filter((w) => !wb.includes(w));
    const onlyB = wb.filter((w) => !wa.includes(w));
    return onlyA.length === 1 && onlyB.length === 1 && wa.length === wb.length && ![...onlyA, ...onlyB].some((w) => /^(\d+|ii|iii|iv|v)$/.test(w));
  };
  const byTitle = new Map<string, Release[]>();
  for (const r of id.releases.filter((r) => !id.platform || r.platform === id.platform)) {
    byTitle.set(strip(r.title), [...(byTitle.get(strip(r.title)) ?? []), r]);
  }
  const games: { title: string; releases: Release[] }[] = [];
  for (const rs of [...byTitle.values()].sort((a, b) => b.length - a.length)) {
    const mine = regions(rs);
    const fits = games.filter((g) => paired(g.title, rs[0]!.title) || ![...regions(g.releases)].some((x) => mine.has(x)));
    const home = fits.find((g) => sequel(g.title) === sequel(rs[0]!.title)) ?? fits[0];
    if (home) home.releases.push(...rs);
    else games.push({ title: rs[0]!.title, releases: [...rs] });
  }
  // Name each game after an English release when it has one.
  for (const g of games) g.title = (g.releases.find((r) => /\b(USA|Europe|World)\b/.test(r.region ?? "")) ?? g.releases[0]!).title;
  const main = games.findIndex((g) => g.releases.some((r) => strip(r.title) === strip(id.title ?? "")));
  if (main > 0) games.unshift(...games.splice(main, 1));
  if (games[0] && id.title) games[0].title = id.title;
  return games;
}

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

  // A repo can build several games (Digital Devil Saga 1 and 2). The draft covers the
  // identified one; the others need entries of their own, not aliases.
  const games = gamesIn(id);
  const otherGames = games.slice(1).map((g) => g.title);
  const strip = (t: string) => t.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const mainTitles = new Set((games[0]?.releases ?? []).map((r) => strip(r.title)));
  const aliases = otherGames.length ? id.aliases.filter((a) => mainTitles.has(strip(a))) : id.aliases;
  const releases = otherGames.length ? games[0]!.releases : id.releases;
  // Version codes of the other games' releases, to keep their targets out of this draft.
  const norm = (x: string) => x.toLowerCase().replace(/[^a-z0-9]/g, "");
  const otherCodes = new Set(games.slice(1).flatMap((g) => g.releases.filter((r) => r.match.kind === "code").map((r) => norm(r.match.value))));

  // The game: an existing catalog game when one matches, else a new one.
  const title = id.title ?? sub.game;
  const platform = id.platform ?? sub.platform ?? "other";
  const existing = [title, ...aliases, sub.game].filter(Boolean).map((n) => findGame(opts.games, n, platform)).find(Boolean);
  let gameId = existing?.id ?? slug(title);
  if (!existing && opts.games.some((g) => g.id === gameId)) gameId = `${gameId}-${platform}`;
  const game: Game = existing ?? {
    id: gameId,
    name: title,
    platform,
    ...(aliases.length ? { aliases: aliases.slice(0, 5) } : {}),
  };
  if (!id.title) problems.push("The game couldn't be confirmed; check the name and platform.");

  // Targets: decomp-toolkit versions first, then identified ROM hashes, then what the submitter typed.
  const targets: Target[] = [];
  const reports = new Set(f.reportArtifacts);
  const versions = [...new Set(f.paths.map((p) => /^config\/([^/]+)\/build\.sha1$/.exec(p)?.[1]).filter((v): v is string => !!v && v !== "GAMEID"))];
  for (const version of versions.filter((v) => !otherCodes.has(norm(v))).slice(0, 20)) {
    const hash = await dtkHash(github, f, version);
    if (!hash) continue;
    const region = regionFromCode(version);
    const regionName = regionNameFromCode(version);
    targets.push({
      id: slug(version),
      label: regionName ? `${version} (${regionName})` : targetLabel(version, platform),
      ...(region ? { region } : {}),
      hash: hashField(hash),
      progress: reports.has(`${version}_report`)
        ? objdiff(f, `${version}_report`)
        : { kind: "none" },
    });
  }
  if (!targets.length) {
    for (const r of releases.filter((r) => r.match.kind === "hash")) {
      const region = REGION_SLUG[r.region ?? ""];
      const base = slug(r.name.replace(/^[^(]*/, "")) || "main";
      let tid = base;
      for (let n = 2; targets.some((t) => t.id === tid); n++) tid = `${base}-${n}`;
      targets.push({
        id: tid,
        label: r.name.replace(/^[^(]*\(/, "(").replace(/^\((.*)\)$/, "$1").replace(/\) \(/g, ", ") || r.name,
        ...(region ? { region } : {}),
        hash: hashField(r.match.value),
        progress: { kind: "none" },
      });
    }
  }
  // Version names: product codes, serials, regions, and the codes in report artifact names.
  const reportCodes = new Set(f.reportArtifacts.map((a) => norm(a.replace(/_report$/, ""))));
  const versionLike = (stem: string) =>
    reportCodes.has(norm(stem)) || /^[A-Z]{4}[-_ ]?\d{2,3}\.?\d{2,3}$/.test(stem) || /(^|[._-])(us|usa|jp|jpn|eu|eur|pal|ntsc|ntsc-u|ntsc-j|en|kr|cn)$/i.test(stem);
  const artifactFor = (...names: string[]) => f.reportArtifacts.find((a) => names.some((n) => norm(a.replace(/_report$/, "")) === norm(n)));
  const dirOf = (p: string) => p.split("/").slice(0, -1).join("/");
  const read = (path: string, limit: number) =>
    github.getText(
      `/repos/${f.fullName}/contents/${path.split("/").map(encodeURIComponent).join("/")}?ref=${encodeURIComponent(f.defaultBranch)}`,
      "application/vnd.github.raw+json",
      limit,
    );
  const addTarget = (stem: string, hash: string, artifact: string | undefined) => {
    let tid = slug(stem) || "main";
    for (let n = 2; targets.some((t) => t.id === tid); n++) tid = `${slug(stem) || "main"}-${n}`;
    targets.push({ id: tid, label: targetLabel(stem, platform), hash: hashField(hash), progress: artifact ? objdiff(f, artifact) : { kind: "none" } });
  };
  // A version folder whose hash files are per data file (config/dds1/battle_tables.sha1), not
  // named for the version: the executable's hash is in the folder's splat yaml or the README.
  const hashFileStem = (path: string) => {
    const file = path.split("/").pop()!.replace(/\.(sha1|md5|sha)$/i, "");
    return /^checksum/i.test(file) ? (path.split("/").slice(-2, -1)[0] ?? "main") : file;
  };
  const hashFiles = f.paths.filter(
    (p) =>
      /\.(sha1|md5|sha)$|(^|\/)checksum[^/]*$/i.test(p) &&
      !/build\.sha1$|\.(tar|tgz|gz|zip|7z|exe|bin|xz)\.|^(bin|tools|ext|external|third_party|lib|libs)\/|\/(overlays?|ovl|modules?|objects?|labels|segments|assets)\//i.test(p),
  );
  const yamlStem = (p: string) => p.split("/").pop()!.replace(/\.ya?ml$/i, "").replace(/(^splat[._-]|[._-]splat$)/i, "");
  const versionDirs = new Set(
    hashFiles
      .map(dirOf)
      .filter((d) => /^configs?\/[^/]+$/i.test(d) && !hashFiles.some((p) => dirOf(p) === d && versionLike(hashFileStem(p))))
      .filter((d) => reportCodes.has(norm(d.split("/").pop()!)) || f.paths.some((p) => dirOf(p) === d && /\.ya?ml$/i.test(p) && versionLike(yamlStem(p)))),
  );
  if (!targets.length) {
    // Hash files of other layouts: config/SLPM_86.053.sha1, configs/USA/checksum.sha, sm64.us.sha1.
    // A version's hash file, not a per-overlay or per-module one: skip those folders, then prefer
    // files named like a version (a product code, a region, or a report artifact's code).
    let files = hashFiles.filter((p) => !versionDirs.has(dirOf(p)) && !otherCodes.has(norm(hashFileStem(p))));
    const named = files.filter((p) => versionLike(hashFileStem(p)));
    if (named.length) files = named;
    else {
      const depth = (p: string) => p.split("/").length;
      const min = Math.min(...files.map(depth));
      files = files.filter((p) => depth(p) === min);
    }
    for (const path of files.slice(0, 8)) {
      const hash = hexDigests((await read(path, 20_000)) ?? "")[0];
      if (!hash) continue;
      let stem = hashFileStem(path); // configs/USA/checksum.sha → USA
      stem = stem.replace(/^[a-z0-9]+[._-](?=(us|usa|jp|jpn|eu|eur|pal|ntsc)$)/i, ""); // sm64.us → us
      // config/checksum.sha with one report artifact: name the version after the artifact.
      if (/^(configs?|main|build|checksum)$/i.test(stem) && f.reportArtifacts.length === 1) stem = f.reportArtifacts[0]!.replace(/_report$/, "");
      addTarget(stem, hash, artifactFor(stem));
    }
  }
  if (!targets.length) {
    // splat configs keep the executable's hash in a top-level `sha1:` field:
    // config/SLUS_005.61.splat.yaml, config/splat.us.yaml, configs/USA/SCUS_941.82.yaml.
    const yamls = f.paths
      .filter((p) => /^configs?\/([^/]+\/)?[^/]+\.ya?ml$/i.test(p))
      .map((p) => ({ path: p, stem: yamlStem(p), dir: dirOf(p).split("/").slice(1).join("/") }))
      .filter(({ stem }) => /^[A-Z]{4}[-_ ]?\d{2,3}\.?\d{2,3}$/.test(stem) || /^(us|usa|jp|jpn|eu|eur|pal|ntsc|en|kr)$/i.test(stem) || reportCodes.has(norm(stem)))
      .slice(0, 8);
    // Folders already settled by a yaml, including the other games' ones.
    const covered = new Set(yamls.filter(({ stem }) => otherCodes.has(norm(stem))).map(({ path }) => dirOf(path)));
    for (const { path, stem, dir } of yamls.filter(({ path }) => !covered.has(dirOf(path)))) {
      const hash = /^sha1:\s*["']?([0-9a-fA-F]{40})/m.exec((await read(path, 50_000)) ?? "")?.[1]?.toLowerCase();
      if (!hash || targets.some((t) => Object.values(t.hash)[0] === hash)) continue;
      covered.add(dirOf(path));
      // config/dds1/SLUS_209.74.yaml reports as dds1_report.
      addTarget(stem, hash, artifactFor(stem, ...(dir ? [dir] : [])));
    }
    // Version folders without a splat hash: a README table row naming the folder.
    for (const d of [...versionDirs].filter((d) => !covered.has(d) && !otherCodes.has(norm(d.split("/").pop()!)))) {
      const name = d.split("/").pop()!;
      const hash = readmeHash(f.readme, [name]);
      if (hash && !targets.some((t) => Object.values(t.hash)[0] === hash)) addTarget(name, hash, artifactFor(name));
    }
  }
  if (!targets.length) {
    for (const line of sub.targets.split("\n")) {
      const hash = hexDigests(line)[0];
      if (!hash) continue;
      const label = line.replace(hash, "").replace(/\b(sha1|md5|sha256)\b:?/gi, "").replace(/[,`:]+\s*$/, "").replace(/\s+/g, " ").trim() || "Main";
      targets.push({ id: slug(label) || `target-${targets.length + 1}`, label, hash: hashField(hash), progress: { kind: "none" } });
    }
  }
  if (!targets.length) problems.push("No versions found: add at least one target with the hash its build checks.");
  // One generic objdiff report and one target: connect them.
  const generic = f.reportArtifacts.filter((a) => /^(us|jp|eu|usa|eur|pal)_report$/i.test(a));
  if (targets.length === 1 && targets[0]!.progress?.kind === "none" && f.reportArtifacts.length === 1) {
    targets[0]!.progress = objdiff(f, f.reportArtifacts[0]!);
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
  return { game, gameExists: !!existing, project, problems, otherGames };
}

const q = (s: string) => JSON.stringify(s);

/** A target's hash field from a hex digest: 64 → sha256, 40 → sha1, 32 → md5. */
export function hashField(hex: string): { sha1: string } | { md5: string } | { sha256: string } {
  return hex.length === 64 ? { sha256: hex } : hex.length === 40 ? { sha1: hex } : { md5: hex };
}

export function gameYaml(g: Game): string {
  return [
    "# yaml-language-server: $schema=../../schema/game.schema.json",
    `id: ${q(g.id)}`,
    `name: ${q(g.name)}`,
    ...(g.aliases?.length ? [`aliases: [${g.aliases.map(q).join(", ")}]`] : []),
    `platform: ${g.platform}`,
    "",
  ].join("\n");
}

export function projectYaml(p: Project): string {
  const lines = [
    "# yaml-language-server: $schema=../../schema/project.schema.json",
    `id: ${q(p.id)}`,
    `name: ${q(p.name)}`,
    `game: ${q(p.game)}`,
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
    lines.push(`  - id: ${q(t.id)}`, `    label: ${q(t.label)}`);
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
