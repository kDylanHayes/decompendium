import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { zipSync } from "fflate";
import { parseDecompendium, parseObjdiff, sanityErrors } from "../src/ingest/parsers.ts";
import { runIngest } from "../src/ingest/run.ts";
import { DataStore } from "../src/ingest/store.ts";
import { IngestError } from "../src/ingest/types.ts";
import { copyFixture, editYaml } from "./helpers.ts";

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url));
const json = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));

describe("parseObjdiff", () => {
  it("reads real version 2 reports", () => {
    const tww = parseObjdiff(fixture("objdiff/v2-tww.json"));
    assert.deepEqual(tww.measures, {
      code: { matched: 6216048, total: 7810964 },
      functions: { matched: 32968, total: 39324 },
      data: { matched: 2135024, total: 2344668 },
      linked: { matched: 5317312, total: 7810964 },
      fuzzy_percent: 82.632,
    });
    assert.deepEqual(
      tww.categories.map((c) => c.id),
      ["dol", "modules", "game", "core", "sdk", "third_party"],
    );
  });

  it("never rounds a near-complete fuzzy match up to 100", () => {
    assert.equal(parseObjdiff(fixture("objdiff/v2-melee.json")).measures.fuzzy_percent, 99.999);
  });

  it("reads binary protobuf identically to JSON", () => {
    const fromJson = parseObjdiff(fixture("objdiff/v2-tww.json"));
    const fromProto = parseObjdiff(fixture("objdiff/v2-tww.binpb"));
    assert.equal(fromProto.format, "protobuf");
    assert.deepEqual(fromProto.measures, fromJson.measures);
    assert.deepEqual(fromProto.categories, fromJson.categories);
  });

  it("reads version 1, version 0 and legacy reports", () => {
    const v1 = parseObjdiff(fixture("objdiff/v1-synthetic.json"));
    assert.deepEqual(v1.measures.linked, { matched: 300, total: 1000 });
    assert.deepEqual(v1.categories[0]!.code, { matched: 300, total: 600 });

    const v0 = parseObjdiff(fixture("objdiff/v0-synthetic.json"));
    assert.deepEqual(v0.measures.linked, { matched: 300, total: 1000 }); // from unit metadata.complete
    assert.deepEqual(v0.categories, []);

    const legacy = parseObjdiff(fixture("objdiff/legacy-synthetic.json"));
    assert.deepEqual(legacy.measures.code, { matched: 400, total: 1000 });
    assert.deepEqual(legacy.measures.linked, { matched: 250, total: 1000 });
  });

  it("rejects newer report versions, junk and bad numbers", () => {
    assert.throws(() => parseObjdiff(json({ version: 3, measures: {} })), /version 3 is newer than supported/);
    assert.throws(() => parseObjdiff(new TextEncoder().encode("{nope")), IngestError);
    assert.throws(() => parseObjdiff(new Uint8Array()), /empty report/);
    assert.throws(
      () => parseObjdiff(json({ version: 2, measures: { total_code: "-5", matched_code: "1" } })),
      /expected a non-negative integer/,
    );
  });
});

describe("parseDecompendium", () => {
  it("reads a valid file with its commit", () => {
    const parsed = parseDecompendium(fixture("progress/valid.json"));
    assert.equal(parsed.commit, "4f1c2a9e0b7d3c5a1e2f4b6d8c0a2e4f6b8d0c2a");
    assert.deepEqual(parsed.measures.code, { matched: 182340, total: 412992 });
    assert.equal(parsed.measures.linked, null);
    assert.equal(parsed.categories[0]!.id, "engine");
  });

  it("rejects files that fail the schema", () => {
    assert.throws(() => parseDecompendium(json({ schema: "decompendium-progress/1" })), /invalid progress file/);
  });
});

describe("sanityErrors", () => {
  it("rejects zero totals and matched above total", () => {
    const base = { functions: null, data: null, linked: null, fuzzy_percent: null };
    assert.deepEqual(sanityErrors({ ...base, code: { matched: 0, total: 0 } }), ["code total is 0"]);
    assert.deepEqual(sanityErrors({ ...base, code: { matched: 5, total: 4 } }), [
      "code: matched (5) exceeds total (4)",
    ]);
  });
});

// --- End-to-end runs against a mocked network -------------------------------

const dataDirs: string[] = [];
after(() => dataDirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
function tempData(): string {
  const dir = mkdtempSync(join(tmpdir(), "decompendium-data-"));
  dataDirs.push(dir);
  return dir;
}

type Route = (url: URL, init: RequestInit) => Response | undefined;

/** A fetch that answers from `routes`, records each URL, and fails loudly on anything else. */
function mockFetch(routes: Route[]) {
  const calls: string[] = [];
  const fetch = (async (input: string | URL, init: RequestInit = {}) => {
    const url = new URL(String(input));
    calls.push(url.toString());
    for (const route of routes) {
      const res = route(url, init);
      if (res) return res;
    }
    throw new Error(`unexpected request: ${url}`);
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

const API = "https://api.github.com/repos/example-org/example-quest";
const reportZip = zipSync({ "report.json": fixture("objdiff/v2-tww.json"), "other.txt": new Uint8Array(3) });

function run(id: number, extra: Record<string, unknown> = {}) {
  return {
    id,
    head_sha: `${id}`.padStart(40, "a"),
    head_branch: "main",
    event: "push",
    head_commit: { timestamp: "2026-10-01T00:00:00Z" },
    ...extra,
  };
}

/** GitHub API routes for the fixture's example-quest/us target. */
function githubRoutes(state: { runs: object[]; artifactName?: string }): Route[] {
  return [
    (u) => (u.toString() === API ? Response.json({ default_branch: "main" }) : undefined),
    (u) => {
      if (u.origin + u.pathname !== `${API}/actions/workflows/build.yml/runs`) return undefined;
      assert.equal(u.searchParams.get("branch"), "main");
      assert.equal(u.searchParams.get("event"), "push");
      assert.equal(u.searchParams.get("status"), "success");
      return Response.json({ workflow_runs: state.runs });
    },
    (u) => {
      const m = /\/actions\/runs\/(\d+)\/artifacts$/.exec(u.pathname);
      if (!m) return undefined;
      const name = state.artifactName ?? "us_report";
      return Response.json({ artifacts: [{ id: Number(m[1]) * 10, name, size_in_bytes: reportZip.length, expired: false }] });
    },
    (u) => (/\/actions\/artifacts\/\d+\/zip$/.test(u.pathname) ? new Response(reportZip) : undefined),
    (u) =>
      u.pathname.endsWith("/commits")
        ? Response.json([{ commit: { committer: { date: "2026-10-02T00:00:00Z" } } }])
        : undefined,
  ];
}

const progressUrl = "https://example-org.github.io/example-quest/progress/jp.json";
function urlRoute(state: { etag: string; body: Uint8Array }): Route {
  return (u, init) => {
    if (u.toString() !== progressUrl) return undefined;
    const headers = new Headers(init.headers);
    if (headers.get("if-none-match") === state.etag) return new Response(null, { status: 304 });
    return new Response(state.body, { headers: { etag: state.etag } });
  };
}

describe("runIngest", () => {
  it("ingests both source types, then skips unchanged sources", async () => {
    const root = copyFixture();
    const data = tempData();
    const gh = { runs: [run(200, { head_branch: "attacker-branch", event: "pull_request" }), run(100)] };
    const url = { etag: '"v1"', body: fixture("progress/valid.json") };
    const { fetch, calls } = mockFetch([...githubRoutes(gh), urlRoute(url)]);
    const now = () => new Date("2026-10-15T12:00:00Z");

    const first = await runIngest({ root, dataDir: data, fetch, now });
    assert.deepEqual(first.results.map((r) => [r.target, r.outcome]).sort(), [
      ["example-quest/jp", "new-snapshot"],
      ["example-quest/us", "new-snapshot"],
    ]);

    const store = new DataStore(data);
    const us = store.lastSnapshot("example-quest", "us")!;
    // The pull-request run (id 200) is ignored even though the API returned it.
    assert.equal(us.run_id, 100);
    assert.equal(us.commit, run(100).head_sha);
    assert.deepEqual(us.code, { matched: 6216048, total: 7810964 });
    assert.ok(!calls.some((c) => c.includes("/runs/200/")), "never looked at the PR run's artifacts");

    const jp = store.lastSnapshot("example-quest", "jp")!;
    assert.equal(jp.kind, "decompendium");
    assert.equal(jp.commit, "4f1c2a9e0b7d3c5a1e2f4b6d8c0a2e4f6b8d0c2a");
    assert.ok(existsSync(join(data, "reports/example-quest/us.json")));

    const health = store.readHealth();
    assert.equal(health.targets["example-quest/us"]!.run_id, 100);
    assert.equal(health.targets["example-quest/jp"]!.etag, '"v1"');
    assert.equal(health.projects["example-quest"]!.last_commit_at, "2026-10-02T00:00:00Z");

    const second = await runIngest({ root, dataDir: data, fetch, now });
    assert.deepEqual(second.results.map((r) => r.outcome).sort(), ["not-modified", "not-modified"]);
    assert.equal(readFileSync(join(data, "snapshots/example-quest/us.jsonl"), "utf8").trim().split("\n").length, 1);
  });

  it("appends only when numbers change, and flags large jumps", async () => {
    const root = copyFixture();
    const data = tempData();
    const url: { etag: string; body: Uint8Array } = { etag: '"a"', body: fixture("progress/valid.json") };
    const { fetch } = mockFetch([urlRoute(url)]);
    const opts = { root, dataDir: data, fetch, only: ["example-quest/jp"] };

    await runIngest(opts);
    url.etag = '"b"'; // same content, new etag
    assert.equal((await runIngest(opts)).results[0]!.outcome, "unchanged");

    const report = JSON.parse(new TextDecoder().decode(fixture("progress/valid.json")));
    report.code = { matched: 182340, total: 900000 };
    url.etag = '"c"';
    url.body = json(report);
    assert.equal((await runIngest(opts)).results[0]!.outcome, "new-snapshot");
    const store = new DataStore(data);
    assert.match(store.readHealth().targets["example-quest/jp"]!.anomaly!, /code total changed from 412992 to 900000/);
    assert.equal(readFileSync(join(data, "snapshots/example-quest/jp.jsonl"), "utf8").trim().split("\n").length, 2);
  });

  it("records failures without losing the last good snapshot", async () => {
    const root = copyFixture();
    const data = tempData();
    const url: { etag: string; body: Uint8Array } = { etag: '"a"', body: fixture("progress/valid.json") };
    const { fetch } = mockFetch([urlRoute(url)]);
    const opts = { root, dataDir: data, fetch, only: ["example-quest/jp"] };
    await runIngest(opts);

    url.etag = '"bad"';
    url.body = json({ schema: "decompendium-progress/1", code: { matched: 9, total: 1 } });
    let last;
    for (let i = 0; i < 5; i++) last = await runIngest(opts);
    assert.equal(last!.results[0]!.outcome, "failed");
    assert.deepEqual(last!.newlyFailing, ["example-quest/jp"]);
    const store = new DataStore(data);
    const health = store.readHealth().targets["example-quest/jp"]!;
    assert.equal(health.consecutive_failures, 5);
    assert.match(health.last_error!, /matched \(9\) exceeds total \(1\)/);
    assert.deepEqual(store.lastSnapshot("example-quest", "jp")!.code, { matched: 182340, total: 412992 });
  });

  it("refuses redirects to http and oversized responses", async () => {
    const root = copyFixture();
    editYaml(root, "config.yaml", (c) => (c.limits.report_read_bytes = 100));
    const redirect: Route = (u) =>
      u.toString() === progressUrl
        ? new Response(null, { status: 302, headers: { location: "http://insecure.example/p.json" } })
        : undefined;
    const r1 = await runIngest({ root, dataDir: tempData(), fetch: mockFetch([redirect]).fetch, only: ["example-quest/jp"] });
    assert.match(r1.results[0]!.detail!, /refusing non-https URL/);

    const big = urlRoute({ etag: '"x"', body: fixture("progress/valid.json") }); // > 100 bytes
    const r2 = await runIngest({ root, dataDir: tempData(), fetch: mockFetch([big]).fetch, only: ["example-quest/jp"] });
    assert.match(r2.results[0]!.detail!, /exceeds the 100-byte limit/);
  });

  it("reports a missing file inside the artifact", async () => {
    const root = copyFixture();
    editYaml(root, "catalog/projects/example-quest.yaml", (p) => (p.targets[0].progress.source.path = "out/report.json"));
    const { fetch } = mockFetch(githubRoutes({ runs: [run(100)] }));
    const result = await runIngest({ root, dataDir: tempData(), fetch, only: ["example-quest/us"] });
    assert.match(result.results[0]!.detail!, /out\/report\.json not found in artifact \(contains: report\.json, other\.txt\)/);
  });

  it("stops cleanly when the rate limit runs out", async () => {
    const root = copyFixture();
    const limited: Route = (u) =>
      u.hostname === "api.github.com"
        ? new Response("{}", { status: 403, headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "4102444800" } })
        : undefined;
    const result = await runIngest({ root, dataDir: tempData(), fetch: mockFetch([limited]).fetch, only: ["example-quest/us"] });
    assert.match(result.stopped!, /rate limit reached/);
    assert.equal(result.results[0]!.outcome, "skipped");
  });

  it("deletes stored data for projects removed from the catalog", async () => {
    const root = copyFixture();
    const data = tempData();
    const { fetch } = mockFetch([urlRoute({ etag: '"a"', body: fixture("progress/valid.json") })]);
    await runIngest({ root, dataDir: data, fetch, only: ["example-quest/jp"] });
    assert.ok(existsSync(join(data, "snapshots/example-quest/jp.jsonl")));

    rmSync(join(root, "catalog/projects/example-quest.yaml"));
    const result = await runIngest({ root, dataDir: data, fetch });
    assert.deepEqual(result.pruned.sort(), ["reports/example-quest", "snapshots/example-quest"]);
    assert.equal(new DataStore(data).readHealth().targets["example-quest/jp"], undefined);
  });
});
