import type { Count } from "../catalog.ts";
import type { Category, Snapshot } from "../ingest/types.ts";
import type { GameView, ProjectView, SiteModel, TargetView } from "./model.ts";

/**
 * Shapes of the public JSON API (spec section 7). Version 1 only grows:
 * fields may be added, but removing or renaming one needs /api/v2/.
 */
export const API_VERSION = 1;

export type BadgeMeasure = "code" | "linked" | "functions";
export const BADGE_MEASURES: BadgeMeasure[] = ["code", "linked", "functions"];

export interface ApiCount extends Count {
  percent: number | null; // matched / total × 100, three decimals, truncated
}

interface ApiMeasures {
  code: ApiCount;
  linked: ApiCount | null;
  functions: ApiCount | null;
  data: ApiCount | null;
  fuzzy_percent: number | null;
}

export interface ApiTarget {
  id: string;
  label: string;
  region: string | null;
  version: string | null;
  hash: { algo: string; value: string };
  progress_kind: "objdiff" | "decompendium" | "none";
  state: TargetView["state"];
  checked_at: string | null;
  last_error: string | null;
  latest: (ApiMeasures & { commit: string | null; commit_at: string | null; taken_at: string; categories: (ApiMeasures & { id: string; name: string })[] }) | null;
  history_url: string;
  badges: Record<BadgeMeasure, string>;
}

export interface ApiProject {
  id: string;
  name: string;
  url: string;
  api_url: string;
  repo: string;
  game: { id: string; name: string; platform: string; url: string };
  description: string;
  note: string | null;
  owners: string[];
  status: ProjectView["status"];
  show_in_index: boolean;
  ai_policy: ProjectView["aiPolicy"];
  confirmed: boolean;
  links: ProjectView["links"];
  listed_at: string;
  last_commit_at: string | null;
  last_activity: string | null;
  quiet: boolean;
  targets: ApiTarget[];
}

/** Absolute URLs from the site origin, e.g. https://decompendium.com. */
export class Urls {
  readonly origin: string;
  constructor(origin: string) {
    this.origin = origin.replace(/\/$/, "");
  }
  page = (path: string) => `${this.origin}/${path}`;
  game = (id: string) => this.page(`games/${id}/`);
  project = (id: string) => this.page(`projects/${id}/`);
  api = (path: string) => this.page(`api/v1/${path}`);
  badge = (project: string, target: string, measure: BadgeMeasure) => this.page(`badges/${project}/${target}/${measure}.svg`);
}

export function apiCount(c: Count | null | undefined): ApiCount | null {
  if (!c) return null;
  return { matched: c.matched, total: c.total, percent: c.total > 0 ? Math.floor((c.matched / c.total) * 100_000) / 1000 : null };
}

function measures(m: Snapshot | Category): ApiMeasures {
  return {
    code: apiCount(m.code)!,
    linked: apiCount(m.linked),
    functions: apiCount(m.functions),
    data: apiCount(m.data),
    fuzzy_percent: m.fuzzy_percent,
  };
}

export function apiTarget(project: ProjectView, t: TargetView, urls: Urls): ApiTarget {
  return {
    id: t.id,
    label: t.label,
    region: t.region ?? null,
    version: t.version ?? null,
    hash: t.hash,
    progress_kind: t.kind,
    state: t.state,
    checked_at: t.checkedAt,
    last_error: t.error,
    latest: t.latest
      ? {
          commit: t.latest.commit,
          commit_at: t.latest.commit_at,
          taken_at: t.latest.taken_at,
          ...measures(t.latest),
          categories: t.latest.categories.map((c) => ({ id: c.id, name: c.name, ...measures(c) })),
        }
      : null,
    history_url: urls.api(`history/${project.id}/${t.id}.json`),
    badges: Object.fromEntries(BADGE_MEASURES.map((m) => [m, urls.badge(project.id, t.id, m)])) as Record<BadgeMeasure, string>,
  };
}

export function apiProject(p: ProjectView, urls: Urls): ApiProject {
  return {
    id: p.id,
    name: p.name,
    url: urls.project(p.id),
    api_url: urls.api(`projects/${p.id}.json`),
    repo: p.repo,
    game: { ...p.game, url: urls.game(p.game.id) },
    description: p.description,
    note: p.note,
    owners: p.owners,
    status: p.status,
    show_in_index: p.showInIndex,
    ai_policy: p.aiPolicy,
    confirmed: p.confirmed,
    links: p.links,
    listed_at: p.listedAt,
    last_commit_at: p.lastCommitAt,
    last_activity: p.lastActivity,
    quiet: p.quiet,
    targets: p.targets.map((t) => apiTarget(p, t, urls)),
  };
}

export function apiGameSummary(g: GameView, urls: Urls) {
  return {
    id: g.id,
    name: g.name,
    aliases: g.aliases,
    platform: g.platform,
    url: urls.game(g.id),
    api_url: urls.api(`games/${g.id}.json`),
    project_ids: g.projects.map((p) => p.id),
  };
}

/** /api/v1/index.json */
export function apiIndex(site: SiteModel, urls: Urls) {
  return {
    api_version: API_VERSION,
    generated_at: site.builtAt,
    license: "CC0-1.0",
    docs: urls.page("about/"),
    counts: {
      games: site.games.length,
      projects: site.projects.length,
      targets: site.projects.reduce((n, p) => n + p.targets.length, 0),
    },
    endpoints: {
      games: urls.api("games.json"),
      game: urls.api("games/{game}.json"),
      projects: urls.api("projects.json"),
      project: urls.api("projects/{project}.json"),
      history: urls.api("history/{project}/{target}.json"),
      shields: urls.api("shields/{project}/{target}/{measure}.json"),
      badge: urls.page("badges/{project}/{target}/{measure}.svg"),
    },
    measures: BADGE_MEASURES,
  };
}

/** Projects in a stable order for the API: by id, never by progress. */
export function byId<T extends { id: string }>(items: T[]): T[] {
  return [...items].sort((a, b) => a.id.localeCompare(b.id));
}

export function json(value: unknown): Response {
  return new Response(JSON.stringify(value, null, 1) + "\n", {
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}
