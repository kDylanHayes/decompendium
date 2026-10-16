import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { parse } from "yaml";

export interface Count {
  matched: number;
  total: number;
}

export interface Config {
  defaults: { show_in_index: boolean };
  catalog_maintainers: string[];
  platforms: string[];
  allowed_hosts: string[];
  opted_out: string[];
  limits: {
    report_download_bytes: number;
    report_read_bytes: number;
    report_store_bytes: number;
    fetch_timeout_seconds: number;
  };
  thresholds: {
    stale_after_days: number;
    quiet_after_days: number;
    failing_after_attempts: number;
    fork_inactive_months: number;
  };
}

export interface Game {
  id: string;
  name: string;
  aliases?: string[];
  platform: string;
  released?: number;
}

export type Source =
  | { type: "github-artifact"; workflow?: string; artifact: string; path: string }
  | { type: "url"; url: string };

export type Progress = { kind: "none" } | { kind: "objdiff" | "decompendium"; source: Source };

export interface Target {
  id: string;
  label: string;
  region?: string;
  version?: string;
  hash: { sha1?: string; md5?: string; sha256?: string };
  progress?: Progress;
}

export interface Project {
  id: string;
  name: string;
  game: string;
  repo: string;
  description: string;
  owners: string[];
  status?: "active" | "complete" | "archived";
  show_in_index?: boolean;
  ai_policy?: "unspecified" | "allowed" | "discouraged" | "prohibited";
  confirmed?: boolean;
  note?: string;
  links?: { contributing?: string; chat?: string; website?: string };
  listed_at: string;
  targets: Target[];
}

/** A parsed YAML file, kept with its path so problems can point at it. */
export interface Loaded<T> {
  file: string; // relative to the catalog root
  id: string; // file name without extension
  data: T;
}

export interface Problem {
  file: string;
  message: string;
}

export interface RawCatalog {
  root: string;
  config?: Loaded<unknown>;
  games: Loaded<unknown>[];
  projects: Loaded<unknown>[];
  problems: Problem[];
}

/** Parse YAML text. `yaml` would turn dates into strings anyway; keep core schema. */
export function parseYaml(text: string): unknown {
  return parse(text, { schema: "core", uniqueKeys: true, prettyErrors: true });
}

function loadFile(root: string, path: string, problems: Problem[]): Loaded<unknown> | undefined {
  const file = relative(root, path);
  try {
    const data = parseYaml(readFileSync(path, "utf8"));
    return { file, id: basename(path).replace(/\.ya?ml$/, ""), data };
  } catch (err) {
    problems.push({ file, message: `invalid YAML: ${(err as Error).message.split("\n")[0]}` });
    return undefined;
  }
}

function loadDir(root: string, dir: string, problems: Problem[]): Loaded<unknown>[] {
  const full = join(root, dir);
  if (!existsSync(full)) return [];
  const out: Loaded<unknown>[] = [];
  for (const name of readdirSync(full).sort()) {
    if (name.startsWith(".")) continue;
    const path = join(full, name);
    if (!/\.ya?ml$/.test(name)) {
      problems.push({ file: relative(root, path), message: "only .yaml files belong in this directory" });
      continue;
    }
    if (name.endsWith(".yml")) {
      problems.push({ file: relative(root, path), message: "use the .yaml extension" });
    }
    const loaded = loadFile(root, path, problems);
    if (loaded) out.push(loaded);
  }
  return out;
}

/** Read config.yaml and every catalog file under `root` without validating them. */
export function readCatalog(root: string): RawCatalog {
  const problems: Problem[] = [];
  const configPath = join(root, "config.yaml");
  const config = existsSync(configPath) ? loadFile(root, configPath, problems) : undefined;
  if (!config && !problems.length) problems.push({ file: "config.yaml", message: "missing" });
  return {
    root,
    config,
    games: loadDir(root, "catalog/games", problems),
    projects: loadDir(root, "catalog/projects", problems),
    problems,
  };
}

/** Normalize a repo URL for comparison: lowercase, no trailing slash or .git. */
export function normalizeRepo(url: string): string {
  return url
    .trim()
    .toLowerCase()
    .replace(/\/+$/, "")
    .replace(/\.git$/, "");
}

/** Normalize a game name or alias for duplicate detection. */
export function normalizeName(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}
