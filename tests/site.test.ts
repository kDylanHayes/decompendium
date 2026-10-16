import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { DataStore } from "../src/ingest/store.ts";
import type { Snapshot } from "../src/ingest/types.ts";
import { loadSite, percent } from "../src/site/model.ts";
import { relativeTime } from "../src/site/format.ts";
import { copyFixture, editYaml } from "./helpers.ts";

const dirs: string[] = [];
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

const NOW = new Date("2026-10-15T12:00:00Z");

function snapshot(commitAt: string, matched = 50): Snapshot {
  return {
    taken_at: "2026-10-15T00:00:00Z",
    commit: "abc1234",
    commit_at: commitAt,
    run_id: 1,
    kind: "objdiff",
    code: { matched, total: 100 },
    functions: { matched: 5, total: 10 },
    data: null,
    linked: { matched: 40, total: 100 },
    fuzzy_percent: 60,
    categories: [],
  };
}

/** Fixture catalog plus a data dir with one snapshot for example-quest/us. */
function setup(healthOverrides: Record<string, unknown> = {}) {
  const root = copyFixture();
  const data = mkdtempSync(join(tmpdir(), "decompendium-site-"));
  dirs.push(data);
  const store = new DataStore(data);
  store.appendSnapshot("example-quest", "us", snapshot("2026-10-10T00:00:00Z"));
  store.writeHealth({
    schema: 1,
    updated_at: NOW.toISOString(),
    targets: {
      "example-quest/us": {
        last_attempt_at: "2026-10-15T06:00:00Z",
        last_success_at: "2026-10-15T06:00:00Z",
        consecutive_failures: 0,
        last_error: null,
        anomaly: null,
        ...healthOverrides,
      },
    },
    projects: {
      "example-quest": { last_commit_at: "2026-10-12T00:00:00Z" },
      "example-racer": { last_commit_at: "2025-01-01T00:00:00Z" },
    },
  });
  return { root, data };
}

describe("loadSite", () => {
  it("joins catalog and data into views", () => {
    const { root, data } = setup();
    const site = loadSite(root, data, NOW);
    assert.deepEqual(
      site.games.map((g) => [g.id, g.projects.map((p) => p.id)]),
      [
        ["example-quest", ["example-quest", "example-quest-eu"]], // listing order, oldest first
        ["example-racer", ["example-racer"]],
      ],
    );
    assert.deepEqual(site.platforms, ["n64", "ps1"]);

    const quest = site.projects.find((p) => p.id === "example-quest")!;
    assert.equal(quest.primary.state, "current");
    assert.equal(quest.primary.latest!.code.matched, 50);
    assert.equal(quest.lastActivity, "2026-10-12T00:00:00Z");
    assert.equal(quest.targets[1]!.state, "no-data"); // jp: never fetched

    const racer = site.projects.find((p) => p.id === "example-racer")!;
    assert.equal(racer.showInIndex, false);
    assert.equal(racer.quiet, true); // no commits for over 180 days
    assert.equal(racer.primary.kind, "none");
  });

  it("sorts projects by most recent activity", () => {
    const { root, data } = setup();
    assert.deepEqual(
      loadSite(root, data, NOW).projects.map((p) => p.id),
      ["example-quest", "example-racer", "example-quest-eu"], // eu has no activity data
    );
  });

  it("marks stale and failing targets", () => {
    let { root, data } = setup({ last_success_at: "2026-10-01T00:00:00Z" });
    assert.equal(loadSite(root, data, NOW).projects.find((p) => p.id === "example-quest")!.primary.state, "stale");

    ({ root, data } = setup({ consecutive_failures: 5, last_error: "boom" }));
    const failing = loadSite(root, data, NOW).projects.find((p) => p.id === "example-quest")!.primary;
    assert.equal(failing.state, "failing");
    assert.equal(failing.error, "boom");
    assert.equal(failing.latest!.code.matched, 50); // last known numbers stay
  });

  it("applies the site-wide show_in_index default", () => {
    const { root, data } = setup();
    editYaml(root, "config.yaml", (c) => (c.defaults.show_in_index = false));
    const site = loadSite(root, data, NOW);
    assert.equal(site.projects.find((p) => p.id === "example-quest-eu")!.showInIndex, false);
    assert.equal(site.projects.find((p) => p.id === "example-quest")!.showInIndex, true); // set explicitly
  });

  it("refuses to build from an invalid catalog", () => {
    const { root, data } = setup();
    editYaml(root, "catalog/projects/example-racer.yaml", (p) => (p.game = "nope"));
    assert.throws(() => loadSite(root, data, NOW), /catalog is invalid/);
  });
});

describe("percent", () => {
  it("shows 100% only for an exact match", () => {
    assert.equal(percent({ matched: 999_999, total: 1_000_000 }), "99.9%");
    assert.equal(percent({ matched: 10, total: 10 }), "100%");
    assert.equal(percent({ matched: 1, total: 3 }), "33.3%");
    assert.equal(percent({ matched: 0, total: 0 }), null);
    assert.equal(percent(null), null);
  });
});

describe("relativeTime", () => {
  it("formats past times", () => {
    assert.equal(relativeTime("2026-10-12T12:00:00Z", NOW), "3 days ago");
    assert.equal(relativeTime("2026-10-15T11:59:30Z", NOW), "just now");
    assert.equal(relativeTime(null, NOW), "unknown");
  });
});
