import {
  normalizeName,
  normalizeRepo,
  readCatalog,
  type Config,
  type Count,
  type Game,
  type Loaded,
  type Problem,
  type Project,
} from "./catalog.ts";
import { schemaErrors } from "./schemas.ts";

export interface ValidationResult {
  problems: Problem[];
  games: number;
  projects: number;
  targets: number;
}

/**
 * Validate config.yaml and the catalog under `root`: each file against its
 * schema, then the rules a schema cannot express (references, uniqueness,
 * allowed hosts, the opt-out list).
 */
export function validateCatalog(root: string): ValidationResult {
  const raw = readCatalog(root);
  const problems = [...raw.problems];
  const result = (): ValidationResult => ({
    problems,
    games: raw.games.length,
    projects: raw.projects.length,
    targets: raw.projects.reduce((n, p) => n + ((p.data as Project)?.targets?.length ?? 0), 0),
  });

  if (!raw.config) return result();
  const configErrors = schemaErrors("config", raw.config.data);
  for (const message of configErrors) problems.push({ file: raw.config.file, message });
  // Cross-file checks need a usable config.
  if (configErrors.length) return result();
  const config = raw.config.data as Config;

  const games = new Map<string, Loaded<Game>>();
  for (const loaded of raw.games) {
    const errors = schemaErrors("game", loaded.data);
    for (const message of errors) problems.push({ file: loaded.file, message });
    if (errors.length) continue;
    const game = loaded as Loaded<Game>;
    games.set(game.data.id, game);
    checkGame(game, config, problems);
  }
  checkGameNames([...games.values()], problems);

  const repos = new Map<string, string>();
  for (const loaded of raw.projects) {
    const errors = schemaErrors("project", loaded.data);
    for (const message of errors) problems.push({ file: loaded.file, message });
    if (errors.length) continue;
    checkProject(loaded as Loaded<Project>, config, games, repos, problems);
  }

  return result();
}

function checkGame({ file, id, data }: Loaded<Game>, config: Config, problems: Problem[]): void {
  if (data.id !== id) problems.push({ file, message: `id "${data.id}" must equal the file name "${id}"` });
  if (!config.platforms.includes(data.platform)) {
    problems.push({ file, message: `platform "${data.platform}" is not in config.yaml platforms` });
  }
}

/** Every game name and alias must identify exactly one game. */
function checkGameNames(games: Loaded<Game>[], problems: Problem[]): void {
  const seen = new Map<string, string>();
  for (const { file, data } of games) {
    for (const name of [data.name, ...(data.aliases ?? [])]) {
      const key = `${data.platform}:${normalizeName(name)}`;
      const other = seen.get(key);
      if (other && other !== data.id) {
        problems.push({ file, message: `name or alias "${name}" is already used by game "${other}"` });
      } else {
        seen.set(key, data.id);
      }
    }
  }
}

function checkProject(
  { file, id, data }: Loaded<Project>,
  config: Config,
  games: Map<string, Loaded<Game>>,
  repos: Map<string, string>,
  problems: Problem[],
): void {
  const problem = (message: string) => problems.push({ file, message });

  if (data.id !== id) problem(`id "${data.id}" must equal the file name "${id}"`);
  if (!games.has(data.game)) problem(`game "${data.game}" does not exist in catalog/games/`);

  const repo = normalizeRepo(data.repo);
  const host = new URL(data.repo).hostname.toLowerCase();
  if (!config.allowed_hosts.includes(host)) problem(`repo host "${host}" is not in config.yaml allowed_hosts`);
  if (new URL(data.repo).pathname.split("/").filter(Boolean).length < 2) {
    problem(`repo "${data.repo}" must point at a repository, e.g. https://github.com/owner/name`);
  }
  if (config.opted_out.some((url) => normalizeRepo(url) === repo)) {
    problem(`repo "${data.repo}" opted out of listing; only a maintainer can reverse that`);
  }
  const otherProject = repos.get(repo);
  if (otherProject) problem(`repo "${data.repo}" is already listed as project "${otherProject}"`);
  else repos.set(repo, data.id);

  const targetIds = new Set<string>();
  for (const target of data.targets) {
    if (targetIds.has(target.id)) problem(`target id "${target.id}" is used more than once`);
    targetIds.add(target.id);
  }
}

/** Validate a Decompendium progress file (schema plus matched <= total). */
export function progressErrors(value: unknown): string[] {
  const errors = schemaErrors("progress", value);
  if (errors.length) return errors;
  const report = value as {
    code: Count;
    functions?: Count;
    data?: Count;
    categories?: { id: string; code: Count; functions?: Count; data?: Count }[];
  };
  const out: string[] = [];
  const check = (where: string, count?: Count) => {
    if (count && count.matched > count.total) out.push(`${where}: matched (${count.matched}) exceeds total (${count.total})`);
  };
  check("/code", report.code);
  check("/functions", report.functions);
  check("/data", report.data);
  if (report.code.total === 0) out.push("/code: total must be greater than 0");
  report.categories?.forEach((c, i) => {
    check(`/categories/${i}/code`, c.code);
    check(`/categories/${i}/functions`, c.functions);
    check(`/categories/${i}/data`, c.data);
  });
  return out;
}
