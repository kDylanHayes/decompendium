import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { DataStore } from "../src/ingest/store.ts";
import type { Snapshot } from "../src/ingest/types.ts";
import { apiCount, apiIndex, apiProject, byId, Urls } from "../src/site/api.ts";
import { badgeContent, badgeSvg, shieldsPayload } from "../src/site/badge.ts";
import { loadSite } from "../src/site/model.ts";
import { copyFixture } from "./helpers.ts";

const dirs: string[] = [];
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

const NOW = new Date("2026-10-15T12:00:00Z");
const urls = new Urls("https://decompendium.com/");

function snapshot(over: Partial<Snapshot> = {}): Snapshot {
  return {
    taken_at: "2026-10-15T00:00:00Z",
    commit: "abc1234",
    commit_at: "2026-10-14T00:00:00Z",
    run_id: 1,
    kind: "objdiff",
    code: { matched: 2, total: 3 },
    functions: { matched: 4120, total: 4389 },
    data: null,
    linked: { matched: 1, total: 3 },
    fuzzy_percent: 70.5,
    categories: [{ id: "game", name: "Game", code: { matched: 1, total: 2 }, functions: null, data: null, linked: null, fuzzy_percent: null }],
    ...over,
  };
}

/** The fixture catalog with one snapshot for example-quest/us, fetched recently or long ago. */
function site(lastSuccess = "2026-10-15T06:00:00Z") {
  const root = copyFixture();
  const data = mkdtempSync(join(tmpdir(), "decompendium-api-"));
  dirs.push(data);
  const store = new DataStore(data);
  store.appendSnapshot("example-quest", "us", snapshot({ code: { matched: 1, total: 3 } }));
  store.appendSnapshot("example-quest", "us", snapshot());
  store.writeHealth({
    schema: 1,
    updated_at: null,
    targets: {
      "example-quest/us": { last_attempt_at: lastSuccess, last_success_at: lastSuccess, consecutive_failures: 0, last_error: null, anomaly: null },
    },
    projects: {},
  });
  return { model: loadSite(root, data, NOW), store };
}

describe("API shapes", () => {
  it("describes a project with absolute URLs and per-target measures", () => {
    const { model } = site();
    const p = apiProject(model.projects.find((x) => x.id === "example-quest")!, urls);
    assert.equal(p.url, "https://decompendium.com/projects/example-quest/");
    assert.equal(p.api_url, "https://decompendium.com/api/v1/projects/example-quest.json");
    assert.equal(p.game.url, "https://decompendium.com/games/example-quest/");
    const us = p.targets[0]!;
    assert.equal(us.state, "current");
    assert.deepEqual(us.latest!.code, { matched: 2, total: 3, percent: 66.666 }); // truncated, never rounded up
    assert.equal(us.latest!.categories[0]!.code.percent, 50);
    assert.equal(us.badges.code, "https://decompendium.com/badges/example-quest/us/code.svg");
    assert.equal(us.history_url, "https://decompendium.com/api/v1/history/example-quest/us.json");
    assert.equal(p.targets[1]!.latest, null); // jp: no data yet
  });

  it("indexes the API and counts what is listed", () => {
    const { model } = site();
    const index = apiIndex(model, urls);
    assert.equal(index.api_version, 1);
    assert.deepEqual(index.counts, { games: 2, projects: 3, targets: 4 });
    assert.equal(index.endpoints.badge, "https://decompendium.com/badges/{project}/{target}/{measure}.svg");
  });

  it("orders projects by id, never by progress", () => {
    assert.deepEqual(byId([{ id: "b" }, { id: "a" }, { id: "c" }]).map((x) => x.id), ["a", "b", "c"]);
  });

  it("reads history oldest first", () => {
    const { store } = site();
    assert.deepEqual(store.readSnapshots("example-quest", "us").map((s) => s.code.matched), [1, 2]);
    assert.deepEqual(store.readSnapshots("example-quest", "nope"), []);
  });

  it("handles zero totals", () => {
    assert.deepEqual(apiCount({ matched: 0, total: 0 }), { matched: 0, total: 0, percent: null });
    assert.equal(apiCount(null), null);
  });
});

describe("badges", () => {
  it("shows fresh data in blue and the right message per measure", () => {
    const t = site().model.projects.find((x) => x.id === "example-quest")!.targets[0]!;
    assert.deepEqual(badgeContent(t, "code"), { label: "matching", message: "66.6%", current: true });
    assert.deepEqual(badgeContent(t, "linked"), { label: "linked", message: "33.3%", current: true });
    assert.deepEqual(badgeContent(t, "functions"), { label: "functions", message: "4,120 / 4,389", current: true });
    assert.deepEqual(shieldsPayload(badgeContent(t, "code")), { schemaVersion: 1, label: "matching", message: "66.6%", color: "blue" });
  });

  it("greys out stale data and says when there is none", () => {
    const stale = site("2026-09-01T00:00:00Z").model.projects.find((x) => x.id === "example-quest")!;
    assert.equal(badgeContent(stale.targets[0]!, "code").current, false);
    assert.deepEqual(badgeContent(stale.targets[1]!, "code"), { label: "matching", message: "no data", current: false });
    assert.equal(shieldsPayload(badgeContent(stale.targets[1]!, "code")).color, "lightgrey");
  });

  it("renders an escaped, sized SVG", () => {
    const svg = badgeSvg({ label: "a<b", message: "1 & 2", current: true });
    assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" width="\d+" height="20"/);
    assert.ok(svg.includes("a&lt;b") && svg.includes("1 &amp; 2"));
    assert.ok(!svg.includes("a<b"));
    assert.ok(svg.includes("#007ec6"));
    assert.ok(badgeSvg({ label: "x", message: "no data", current: false }).includes("#9f9f9f"));
  });
});
