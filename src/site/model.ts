import { readCatalog, type Config, type Count, type Game, type Project, type Target } from "../catalog.ts";
import { DataStore, type Health, type TargetHealth } from "../ingest/store.ts";
import type { Snapshot } from "../ingest/types.ts";
import { validateCatalog } from "../validate.ts";

/** How fresh a target's numbers are (spec section 5.6). */
export type TargetState = "current" | "stale" | "failing" | "no-data";

export interface TargetView {
  id: string;
  label: string;
  region?: string;
  version?: string;
  hash: { algo: string; value: string };
  kind: "objdiff" | "decompendium" | "none";
  latest: Snapshot | null;
  state: TargetState;
  checkedAt: string | null; // last successful fetch
  error: string | null;
}

export interface ProjectView {
  id: string;
  name: string;
  game: { id: string; name: string; platform: string };
  repo: string;
  repoName: string; // owner/name
  description: string;
  note: string | null;
  owners: string[];
  status: "active" | "complete" | "archived";
  showInIndex: boolean;
  aiPolicy: "unspecified" | "allowed" | "discouraged" | "prohibited";
  confirmed: boolean;
  links: { contributing?: string; chat?: string; website?: string };
  listedAt: string;
  targets: TargetView[];
  primary: TargetView; // first target; what lists show
  lastCommitAt: string | null;
  lastActivity: string | null; // newest of repo commit and snapshot commit
  quiet: boolean;
}

export interface GameView extends Game {
  aliases: string[];
  projects: ProjectView[]; // listing order, oldest first (POLICY.md section 4)
}

export interface SiteModel {
  builtAt: string;
  config: Config;
  games: GameView[]; // by name
  projects: ProjectView[]; // most recent activity first
  platforms: string[]; // platforms that have at least one game, in config order
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Build everything the pages need from the catalog and a data branch checkout. */
export function loadSite(root: string, dataDir: string, now: Date = new Date()): SiteModel {
  const problems = validateCatalog(root).problems;
  if (problems.length) {
    throw new Error(`catalog is invalid:\n${problems.map((p) => `${p.file}: ${p.message}`).join("\n")}`);
  }
  const raw = readCatalog(root);
  const config = raw.config!.data as Config;
  const store = new DataStore(dataDir);
  const health = store.readHealth();

  const gameData = new Map(raw.games.map((g) => [g.id, g.data as Game]));
  const projects = raw.projects.map((p) =>
    projectView(p.data as Project, gameData.get((p.data as Project).game)!, store, health, config, now),
  );
  projects.sort(byActivity);

  const games: GameView[] = [...gameData.values()]
    .map((g) => ({
      ...g,
      aliases: g.aliases ?? [],
      projects: projects
        .filter((p) => p.game.id === g.id)
        .sort((a, b) => a.listedAt.localeCompare(b.listedAt) || a.id.localeCompare(b.id)),
    }))
    .filter((g) => g.projects.length > 0)
    .sort((a, b) => a.name.localeCompare(b.name));

  const used = new Set(games.map((g) => g.platform));
  return {
    builtAt: now.toISOString(),
    config,
    games,
    projects,
    platforms: config.platforms.filter((p) => used.has(p)),
  };
}

function projectView(
  project: Project,
  game: Game,
  store: DataStore,
  health: Health,
  config: Config,
  now: Date,
): ProjectView {
  const targets = project.targets.map((t) =>
    targetView(t, store.lastSnapshot(project.id, t.id) ?? null, health.targets[`${project.id}/${t.id}`], config, now),
  );
  const lastCommitAt = health.projects[project.id]?.last_commit_at ?? null;
  const snapshotCommits = targets.map((t) => t.latest?.commit_at).filter((d): d is string => !!d);
  const lastActivity = [lastCommitAt, ...snapshotCommits].filter((d): d is string => !!d).sort().at(-1) ?? null;
  const url = new URL(project.repo);
  return {
    id: project.id,
    name: project.name,
    game: { id: game.id, name: game.name, platform: game.platform },
    repo: project.repo,
    repoName: url.pathname.replace(/^\/|\/$/g, "").replace(/\.git$/, ""),
    description: project.description,
    note: project.note ?? null,
    owners: project.owners,
    status: project.status ?? "active",
    showInIndex: project.show_in_index ?? config.defaults.show_in_index,
    aiPolicy: project.ai_policy ?? "unspecified",
    confirmed: project.confirmed ?? false,
    links: project.links ?? {},
    listedAt: project.listed_at,
    targets,
    primary: targets[0]!,
    lastCommitAt,
    lastActivity,
    quiet:
      lastCommitAt !== null && now.getTime() - Date.parse(lastCommitAt) > config.thresholds.quiet_after_days * DAY_MS,
  };
}

function targetView(
  target: Target,
  latest: Snapshot | null,
  health: TargetHealth | undefined,
  config: Config,
  now: Date,
): TargetView {
  const kind = target.progress?.kind ?? "none";
  const [algo, value] = Object.entries(target.hash)[0]!;
  let state: TargetState;
  if (kind === "none" || !latest) state = "no-data";
  else if ((health?.consecutive_failures ?? 0) >= config.thresholds.failing_after_attempts) state = "failing";
  else if (
    !health?.last_success_at ||
    now.getTime() - Date.parse(health.last_success_at) > config.thresholds.stale_after_days * DAY_MS
  )
    state = "stale";
  else state = "current";
  return {
    id: target.id,
    label: target.label,
    region: target.region,
    version: target.version,
    hash: { algo, value: value! },
    kind,
    latest: kind === "none" ? null : latest,
    state,
    checkedAt: health?.last_success_at ?? null,
    error: kind === "none" ? null : (health?.last_error ?? null),
  };
}

function byActivity(a: ProjectView, b: ProjectView): number {
  return (b.lastActivity ?? "").localeCompare(a.lastActivity ?? "") || a.name.localeCompare(b.name);
}

/**
 * A percentage for display: one decimal, truncated, so 100% only appears
 * when matched equals total exactly (spec section 6.5).
 */
export function percent(count: Count | null | undefined): string | null {
  if (!count || count.total === 0) return null;
  if (count.matched === count.total) return "100%";
  return `${(Math.floor((count.matched / count.total) * 1000) / 10).toFixed(1)}%`;
}

/** Fraction 0..1 for progress bars. */
export function fraction(count: Count | null | undefined): number {
  return count && count.total > 0 ? count.matched / count.total : 0;
}
