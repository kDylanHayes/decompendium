import type { Count } from "../catalog.ts";

/** Progress for a whole target or one category, normalized across report formats. */
export interface Measures {
  code: Count; // bytes
  functions: Count | null;
  data: Count | null; // bytes
  linked: Count | null; // objdiff "complete" (fully linked) code, bytes
  fuzzy_percent: number | null;
}

export interface Category extends Measures {
  id: string;
  name: string;
}

/** What a parser extracts from a report file. */
export interface Parsed {
  measures: Measures;
  categories: Category[];
  commit?: string;
  commit_at?: string;
  format: "json" | "protobuf";
}

/** One line of snapshots/<project>/<target>.jsonl. */
export interface Snapshot extends Measures {
  taken_at: string;
  commit: string | null;
  commit_at: string | null;
  run_id: number | null;
  kind: "objdiff" | "decompendium";
  categories: Category[];
}

/** A report the ingester could not use. Recorded in health.json, never fatal to the run. */
export class IngestError extends Error {}

/** The API rate limit ran out or the token was rejected: stop cleanly, resume next run. */
export class StopRunError extends Error {}
