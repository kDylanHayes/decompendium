import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { SourceState } from "./sources.ts";
import type { Snapshot } from "./types.ts";

export interface TargetHealth extends SourceState {
  last_attempt_at: string;
  last_success_at: string | null; // last fetch that worked, changed or not
  consecutive_failures: number;
  last_error: string | null;
  anomaly: string | null; // set when the last snapshot looked suspicious; kept until the next one
}

export interface ProjectHealth {
  default_branch?: string;
  default_branch_checked_at?: string;
  last_commit_at?: string | null; // newest commit on the default branch, for the Quiet marker
  commits_checked_at?: string;
}

export interface Health {
  schema: 1;
  updated_at: string | null;
  targets: Record<string, TargetHealth>; // keyed "<project>/<target>"
  projects: Record<string, ProjectHealth>;
}

/**
 * The data branch, checked out at `dir`:
 *   snapshots/<project>/<target>.jsonl  append-only history
 *   reports/<project>/<target>.<ext>    latest full report, if small enough
 *   health.json                         fetch state and errors
 */
export class DataStore {
  readonly dir: string;

  constructor(dir: string) {
    this.dir = dir;
  }

  readHealth(): Health {
    const path = join(this.dir, "health.json");
    if (!existsSync(path)) return { schema: 1, updated_at: null, targets: {}, projects: {} };
    return JSON.parse(readFileSync(path, "utf8")) as Health;
  }

  writeHealth(health: Health): void {
    const sorted = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b)));
    const out = { ...health, targets: sorted(health.targets), projects: sorted(health.projects) };
    this.write("health.json", JSON.stringify(out, null, 2) + "\n");
  }

  lastSnapshot(project: string, target: string): Snapshot | undefined {
    const path = join(this.dir, "snapshots", project, `${target}.jsonl`);
    if (!existsSync(path)) return undefined;
    const lines = readFileSync(path, "utf8").trimEnd().split("\n").filter(Boolean);
    const last = lines.at(-1);
    return last ? (JSON.parse(last) as Snapshot) : undefined;
  }

  appendSnapshot(project: string, target: string, snapshot: Snapshot): void {
    const path = join(this.dir, "snapshots", project, `${target}.jsonl`);
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, JSON.stringify(snapshot) + "\n");
  }

  /** Keep the latest full report only when it is under `limit` bytes. */
  writeReport(project: string, target: string, bytes: Uint8Array, ext: "json" | "binpb", limit: number): void {
    const dir = join(this.dir, "reports", project);
    for (const old of ["json", "binpb"]) rmSync(join(dir, `${target}.${old}`), { force: true });
    if (bytes.byteLength > limit) return;
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${target}.${ext}`), bytes);
  }

  /**
   * Delete data for projects and targets no longer in the catalog, so an
   * opt-out removes stored history too. Returns what was removed.
   */
  prune(keep: Map<string, Set<string>>, health: Health): string[] {
    const removed: string[] = [];
    for (const area of ["snapshots", "reports"]) {
      const areaDir = join(this.dir, area);
      if (!existsSync(areaDir)) continue;
      for (const project of readdirSync(areaDir)) {
        const targets = keep.get(project);
        if (!targets) {
          rmSync(join(areaDir, project), { recursive: true, force: true });
          removed.push(`${area}/${project}`);
          continue;
        }
        for (const file of readdirSync(join(areaDir, project))) {
          const target = file.replace(/\.(jsonl|json|binpb)$/, "");
          if (!targets.has(target)) {
            rmSync(join(areaDir, project, file), { force: true });
            removed.push(`${area}/${project}/${file}`);
          }
        }
      }
    }
    for (const key of Object.keys(health.targets)) {
      const [project, target] = key.split("/");
      if (!keep.get(project!)?.has(target!)) delete health.targets[key];
    }
    for (const project of Object.keys(health.projects)) {
      if (!keep.has(project)) delete health.projects[project];
    }
    return removed;
  }

  private write(file: string, text: string): void {
    const path = join(this.dir, file);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
  }
}
