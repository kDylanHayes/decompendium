import type { GitHub } from "../ingest/http.ts";
import { IngestError } from "../ingest/types.ts";

/** A repository found by search, before its facts are fetched. */
export interface Candidate {
  fullName: string;
  description: string;
  topics: string[];
  fork: boolean;
  archived: boolean;
  stars: number | null; // unknown for code-search hits
  sizeKb: number | null; // unknown for code-search hits
  pushedAt: string | null;
  foundBy: string[]; // query ids
}

interface Query {
  id: string;
  q: string;
  kind: "repositories" | "code";
  wide?: boolean; // broad, low-precision: run weekly, triage throws most results away for free
}

/**
 * Searches that together cover the known matching projects. Each GitHub search
 * returns at most 1,000 results, so repository searches that exceed that are
 * split by creation date until every slice fits.
 */
export const QUERIES: Query[] = [
  { id: "readme-objdiff", q: "objdiff in:readme", kind: "repositories" },
  { id: "readme-decomp-dev", q: "decomp.dev in:readme", kind: "repositories" },
  { id: "matching-decompilation", q: '"matching decompilation"', kind: "repositories" },
  { id: "topic-decompilation", q: "topic:decompilation", kind: "repositories" },
  { id: "topic-decomp", q: "topic:decomp", kind: "repositories" },
  { id: "topic-matching", q: "topic:matching-decompilation", kind: "repositories" },
  { id: "name-decompilation", q: "decompilation in:name,description", kind: "repositories" },
  { id: "readme-matching", q: "decompilation matching in:readme", kind: "repositories" },
  // Search leaves forks out unless asked. Some forks are the active project.
  { id: "fork-decompilation", q: "decompilation in:name,description fork:only stars:>=3", kind: "repositories" },
  { id: "fork-objdiff", q: "objdiff in:readme fork:only stars:>=3", kind: "repositories" },
  { id: "code-objdiff-ci", q: '"objdiff-cli" path:.github/workflows', kind: "code" },
  { id: "code-dtk-hash", q: "filename:build.sha1 path:config", kind: "code" },
  { id: "code-objdiff-json", q: "filename:objdiff.json", kind: "code" },
  { id: "code-permuter", q: "filename:permuter_settings.toml", kind: "code" },
  { id: "code-asm-differ", q: "filename:diff_settings.py", kind: "code" },
  { id: "wide-name-decomp", q: "decomp in:name", kind: "repositories", wide: true },
  { id: "wide-readme-decompilation", q: "decompilation in:readme", kind: "repositories", wide: true },
  { id: "wide-readme-disassembly", q: "disassembly in:name,description", kind: "repositories", wide: true },
];

/**
 * Inspection order. Query weights follow each query's measured precision
 * against a hand-checked list of matching projects (code search for objdiff
 * in CI ~68%, decomp-toolkit hash files ~40%, objdiff in a README ~26%,
 * plain "decompilation" wording ~5%). Matching projects are also nearly all
 * recently active, so recent pushes and stars count too. A run that hits its
 * limit has then already covered the most promising candidates.
 */
const QUERY_WEIGHT: Record<string, number> = {
  "code-objdiff-ci": 6,
  "code-dtk-hash": 5,
  "readme-objdiff": 4,
  "topic-matching": 4,
  "matching-decompilation": 4,
  "code-permuter": 3,
  "code-objdiff-json": 3,
  "code-asm-differ": 2,
  // Listed on a progress tracker: its CI uploads objdiff reports. Enough on its own
  // to be inspected the same day, since GitHub search often misses these.
  "tracker-bytematch": 8,
  "fork-decompilation": 0,
  "fork-objdiff": 0,
};

/** Candidates below this priority are not inspected: all known matching projects score above it. */
export const MIN_PRIORITY = 6;

export function priority(c: Candidate, now: Date = new Date()): number {
  let p = c.foundBy.reduce((sum, id) => sum + (QUERY_WEIGHT[id] ?? 1), 0);
  // Code-search hits carry no push date or stars; they are few and precise, so
  // treat the unknowns as probably active rather than burying them.
  const age = c.pushedAt ? (now.getTime() - Date.parse(c.pushedAt)) / 86_400_000 : null;
  if (age === null) p += 3;
  else if (age < 365) p += 4;
  else if (age < 3 * 365) p += 1;
  if (c.stars === null) p += 1;
  else if (c.stars >= 50) p += 5; // well-known projects, including finished ones that are no longer pushed
  else if (c.stars >= 5) p += 2;
  else if (c.stars >= 1) p += 1;
  return p;
}

const PAGE = 100;
const CAP = 1000;

interface SearchOptions {
  wide?: boolean;
  sleep?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
  now?: Date;
  queries?: Query[];
  /** Extra candidates by name from progress trackers, keyed by query id ("tracker-bytematch"). */
  trackers?: Record<string, () => Promise<string[]>>;
}

interface RepoItem {
  full_name: string;
  description: string | null;
  topics?: string[];
  fork: boolean;
  archived?: boolean;
  stargazers_count?: number;
  size?: number;
  pushed_at?: string;
}

/** Run every query and merge the results by repository. */
export async function searchCandidates(github: GitHub, opts: SearchOptions = {}): Promise<Map<string, Candidate>> {
  const sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const log = opts.log ?? (() => {});
  const found = new Map<string, Candidate>();

  const record = (item: RepoItem, queryId: string) => {
    const key = item.full_name.toLowerCase();
    const existing = found.get(key);
    if (existing) {
      if (!existing.foundBy.includes(queryId)) existing.foundBy.push(queryId);
      // Repository search has richer fields than code search; keep the best.
      existing.topics = existing.topics.length ? existing.topics : (item.topics ?? []);
      existing.sizeKb ??= item.size ?? null;
      existing.stars ??= item.stargazers_count ?? null;
      existing.pushedAt ??= item.pushed_at ?? null;
      return;
    }
    found.set(key, {
      fullName: item.full_name,
      description: item.description ?? "",
      topics: item.topics ?? [],
      fork: item.fork,
      archived: item.archived ?? false,
      stars: item.stargazers_count ?? null,
      sizeKb: item.size ?? null,
      pushedAt: item.pushed_at ?? null,
      foundBy: [queryId],
    });
  };

  // GitHub allows 30 repository searches and 10 code searches a minute.
  const pause = (kind: Query["kind"]) => sleep(kind === "code" ? 6500 : 2100);

  const page = async (query: Query, q: string, n: number) => {
    await pause(query.kind);
    const params = new URLSearchParams({ q, per_page: String(PAGE), page: String(n) });
    const res = await github.get<{ total_count: number; items: any[] }>(`/search/${query.kind}?${params}`);
    return res ?? { total_count: 0, items: [] };
  };

  const collect = async (query: Query, q: string, first?: { total_count: number; items: any[] }) => {
    first ??= await page(query, q, 1);
    const pages = Math.ceil(Math.min(first.total_count, CAP) / PAGE);
    const take = (items: any[]) =>
      items.forEach((it) => record(query.kind === "code" ? (it.repository as RepoItem) : (it as RepoItem), query.id));
    take(first.items);
    for (let n = 2; n <= pages; n++) take((await page(query, q, n)).items);
    log(`${query.id}${q !== query.q ? ` [${q.slice(query.q.length).trim()}]` : ""}: ${first.total_count}`);
  };

  const now = opts.now ?? new Date();
  for (const query of opts.queries ?? QUERIES.filter((q) => opts.wide || !q.wide)) {
    try {
      await runQuery(query, now);
    } catch (err) {
      // One refused query (code search needs a user or app token) shouldn't sink the run.
      if (!(err instanceof IngestError)) throw err;
      log(`${query.id}: skipped (${err.message})`);
    }
  }
  for (const [id, list] of Object.entries(opts.trackers ?? {})) {
    try {
      const names = await list();
      let added = 0;
      for (const fullName of names) {
        const key = fullName.toLowerCase();
        const existing = found.get(key);
        if (existing) {
          if (!existing.foundBy.includes(id)) existing.foundBy.push(id);
          continue;
        }
        added++;
        // Only the name is known; the inspection fetches the rest.
        found.set(key, { fullName, description: "", topics: [], fork: false, archived: false, stars: null, sizeKb: null, pushedAt: null, foundBy: [id] });
      }
      log(`${id}: ${names.length} (${added} not found by search)`);
    } catch (err) {
      log(`${id}: skipped (${(err as Error).message})`);
    }
  }
  return found;

  async function runQuery(query: Query, now: Date): Promise<void> {
    if (query.kind === "code") {
      await collect(query, query.q); // code search cannot be split by date
      return;
    }
    // Split by creation date until each slice is under the cap.
    const today = now.toISOString().slice(0, 10);
    const slices: ([string, string] | null)[] = [null]; // null: the query without a date filter
    while (slices.length) {
      const slice = slices.shift()!;
      const q = slice ? `${query.q} created:${slice[0]}..${slice[1]}` : query.q;
      const first = await page(query, q, 1);
      const [from, to] = slice ?? ["2008-01-01", today];
      if (first.total_count > CAP && from !== to) {
        const mid = new Date((Date.parse(from) + Date.parse(to)) / 2).toISOString().slice(0, 10);
        const next = new Date(Date.parse(mid) + 86_400_000).toISOString().slice(0, 10);
        slices.unshift([from, mid], [next, to]);
        continue;
      }
      await collect(query, q, first);
    }
  }
}
