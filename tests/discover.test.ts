import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { repoFromUrl, type RepoFacts } from "../src/discover/facts.ts";
import { evaluate, prefilter, runDiscover, versionCodes } from "../src/discover/run.ts";
import { searchCandidates, type Candidate } from "../src/discover/search.ts";
import { assess } from "../src/discover/signals.ts";
import { GitHub } from "../src/ingest/http.ts";
import { copyFixture, editYaml } from "./helpers.ts";

const RECENT = new Date(Date.now() - 86_400_000).toISOString();

/** Facts for a plausible repo; override what a test cares about. */
function facts(over: Partial<RepoFacts> = {}): RepoFacts {
  return {
    fullName: "someone/game",
    url: "https://github.com/someone/game",
    description: "",
    topics: [],
    fork: false,
    archived: false,
    stars: 10,
    pushedAt: RECENT,
    createdAt: "2024-01-01T00:00:00Z",
    defaultBranch: "main",
    language: "C",
    sizeKb: 5000,
    paths: Array.from({ length: 60 }, (_, i) => `src/file${i}.c`),
    treeTruncated: false,
    readme: "",
    reportArtifacts: [],
    ...over,
  };
}

const ids = (f: RepoFacts) => assess(f).signals.map((s) => s.id);

describe("assess", () => {
  it("rates a decomp-toolkit project with reports as likely", () => {
    const a = assess(
      facts({
        fullName: "someone/game-decomp",
        description: "Decompilation of Game",
        paths: ["configure.py", "config/GXXE01/build.sha1", "src/main.c", ...facts().paths],
        reportArtifacts: ["GXXE01_report"],
        readme: "a matching decompilation. [progress](https://decomp.dev/someone/game)",
      }),
    );
    assert.equal(a.verdict, "likely");
    assert.deepEqual(a.hashEvidence, ["config/GXXE01/build.sha1"]);
    assert.ok(a.signals.some((s) => s.id === "decomp-dev-badge"));
  });

  it("finds ROM hash files but ignores tool download hashes", () => {
    const a = assess(facts({ paths: ["sm64.us.sha1", "bin/cc1.tar.gz.sha256", "configs/USA/checksum.sha", "src/a.c"] }));
    assert.deepEqual(a.hashEvidence, ["sm64.us.sha1", "configs/USA/checksum.sha"]);
  });

  it("rates recomps, ports and tools as unlikely", () => {
    assert.equal(assess(facts({ fullName: "x/Zelda64Recomp", description: "Static recompilation of Majora's Mask for PC" })).verdict, "unlikely");
    assert.equal(assess(facts({ fullName: "x/sm64-port", description: "A port of https://github.com/n64decomp/sm64 for modern devices" })).verdict, "unlikely");
    assert.equal(assess(facts({ fullName: "x/dtk-template", description: "Project template for decomp-toolkit", paths: ["config/GAME01/build.sha1", ...facts().paths] })).verdict, "unlikely");
  });

  it("only lightly penalizes look-alike words next to 'decompilation'", () => {
    const a = assess(facts({ description: "Decompilation, modding and map editing for Thief", reportArtifacts: ["PC_report"], readme: "decomp" }));
    assert.equal(a.signals.find((s) => s.id === "lookalike-words")?.weight, -1);
    assert.notEqual(a.verdict, "unlikely");
  });

  it("needs something buildable, not just words", () => {
    const a = assess(facts({ description: "matching decompilation", readme: "matching decomp", paths: ["README.md", "notes.txt"] }));
    assert.equal(a.verdict, "unlikely");
  });

  it("does not call an artifact-mirror repo tiny", () => {
    assert.ok(!ids(facts({ paths: ["README.md"], reportArtifacts: ["SLUS_202.28_report"] })).includes("tiny-repo"));
    assert.ok(ids(facts({ paths: ["README.md"] })).includes("tiny-repo"));
  });
});

describe("prefilter", () => {
  const candidate = (over: Partial<Candidate> = {}): Candidate => ({
    fullName: "someone/game", description: "", topics: [], fork: false, archived: false, stars: 0, sizeKb: 100, pushedAt: null, foundBy: ["q"], ...over,
  });
  const listed = new Set(["https://github.com/zeldaret/tww"]);

  it("skips listed, opted-out, forks, empty repos and tools", () => {
    assert.equal(prefilter(candidate({ fullName: "zeldaret/TWW" }), listed, new Set()), "already listed");
    assert.equal(prefilter(candidate(), new Set(), new Set(["https://github.com/someone/game"])), "opted out");
    assert.equal(prefilter(candidate({ fork: true }), listed, new Set()), "fork");
    assert.equal(prefilter(candidate({ fork: true, stars: 12 }), listed, new Set()), null); // a starred fork may be the active project
    assert.equal(prefilter(candidate({ sizeKb: 0 }), listed, new Set()), "empty");
    assert.match(prefilter(candidate({ description: "A GameCube & Wii decompilation toolkit" }), listed, new Set())!, /^tool/);
    assert.equal(prefilter(candidate({ description: "Decompilation of Game" }), listed, new Set()), null);
  });
});

describe("searchCandidates", () => {
  it("splits searches over the 1,000-result cap by date and merges hits", async () => {
    const seen: string[] = [];
    const fetch = (async (input: string | URL) => {
      const url = new URL(String(input));
      const q = url.searchParams.get("q")!;
      seen.push(q);
      if (url.pathname === "/search/code") {
        return Response.json({ total_count: 1, items: [{ repository: { full_name: "a/one", description: null, fork: false } }] });
      }
      const total = q.includes("created:") ? 2 : 1500; // the unfiltered query is over the cap
      const name = q.includes("created:2008") ? "a/one" : "b/two";
      return Response.json({ total_count: total, items: [{ full_name: name, description: "d", fork: false, topics: ["decomp"], size: 5, pushed_at: "2026-01-01T00:00:00Z" }] });
    }) as typeof globalThis.fetch;
    const found = await searchCandidates(new GitHub(fetch, "t", 1000), {
      sleep: async () => {},
      now: new Date("2026-10-15T00:00:00Z"),
      queries: [
        { id: "repo", q: "decomp in:name", kind: "repositories" },
        { id: "code", q: "filename:objdiff.json", kind: "code" },
      ],
    });
    assert.ok(seen.some((q) => q.startsWith("decomp in:name created:2008-01-01..")), seen.join("\n"));
    assert.deepEqual(found.get("a/one")!.foundBy.sort(), ["code", "repo"]);
    assert.equal(found.get("a/one")!.sizeKb, 5); // richer repo-search fields kept
    assert.equal(found.get("b/two")!.foundBy.length, 1);
  });
});

describe("runDiscover", () => {
  const cands = (list: Partial<Candidate>[]) =>
    new Map(list.map((c) => [c.fullName!.toLowerCase(), { description: "", topics: [], fork: false, archived: false, stars: 0, sizeKb: 10, pushedAt: RECENT, foundBy: ["readme-objdiff"], ...c } as Candidate]));

  it("assesses new candidates, caches them, and evaluates against a list", async () => {
    const root = copyFixture();
    const search = async () =>
      cands([
        { fullName: "good/decomp" },
        { fullName: "tool/thing", description: "a decompiler" },
        { fullName: "example-org/example-quest" }, // listed in the fixture catalog
      ]);
    const fetched: string[] = [];
    const factsFor = async (name: string) => {
      fetched.push(name);
      return facts({ fullName: name, description: "Decompilation of Good", reportArtifacts: ["us_report"], paths: ["good.sha1", ...facts().paths] });
    };
    const github = new GitHub(globalThis.fetch, undefined, 1000);
    const first = await runDiscover({ root, github, search, facts: factsFor });
    assert.deepEqual(fetched, ["good/decomp"]);
    assert.deepEqual(first.suggestions.map((s) => s.fullName), ["good/decomp"]);
    assert.equal(first.skipped["example-org/example-quest"], "already listed");

    const second = await runDiscover({ root, github, search, facts: factsFor, state: first.state });
    assert.deepEqual(fetched, ["good/decomp"], "unchanged repos are not fetched again");
    assert.equal(second.suggestions.length, 1);

    const ev = evaluate(second, ["good/decomp", "example-org/example-quest", "missing/repo", "tool/thing"]);
    assert.equal(ev.found, 3);
    assert.equal(ev.passedPrefilter, 2);
    assert.equal(ev.likely, 1);
    assert.deepEqual(ev.misses.map((m) => m.reason), ["not found by search", "prefilter: tool: decompiler"]);
  });

  it("skips weak, stale candidates without inspecting them", async () => {
    const result = await runDiscover({
      root: copyFixture(),
      github: new GitHub(globalThis.fetch, undefined, 1000),
      search: async () => cands([{ fullName: "old/thing", foundBy: ["name-decompilation"], pushedAt: "2015-01-01T00:00:00Z" }]),
      facts: async () => assert.fail("should not fetch"),
    });
    assert.equal(result.skipped["old/thing"], "low priority");
  });

  it("stops at the fetch limit and reports what is left", async () => {
    const root = copyFixture();
    const search = async () => cands([{ fullName: "a/one" }, { fullName: "a/two" }, { fullName: "a/three" }]);
    const result = await runDiscover({
      root,
      github: new GitHub(globalThis.fetch, undefined, 1000),
      search,
      facts: async (n) => facts({ fullName: n }),
      limit: 2,
    });
    assert.equal(result.pending, 1);
    assert.equal(result.assessed.size, 2);
  });
});

describe("GitHub client throttling", () => {
  it("waits out a secondary rate limit and retries", async () => {
    let calls = 0;
    const waits: number[] = [];
    const fetch = (async () => {
      calls++;
      return calls === 1 ? new Response("{}", { status: 429, headers: { "retry-after": "2" } }) : Response.json({ ok: true });
    }) as typeof globalThis.fetch;
    const github = new GitHub(fetch, "t", 1000, async (ms) => void waits.push(ms));
    assert.deepEqual(await github.get("/x"), { ok: true });
    assert.deepEqual(waits, [2000]);
  });
});

describe("versionCodes", () => {
  it("reads version codes from decomp-toolkit configs and report artifacts", () => {
    assert.deepEqual(
      versionCodes({ hashEvidence: ["config/GALE01/build.sha1", "rom.sha1"], reportArtifacts: ["GALE01_report", "SLUS_216.68_report", "us_report"] }),
      ["gale01", "slus_216.68"], // region-only names like us_report say nothing
    );
  });

  it("flags candidates that build a version a listed project covers", async () => {
    const root = copyFixture();
    editYaml(root, "catalog/projects/example-quest.yaml", (p) => (p.targets[0].progress.source.artifact = "GXXE01_report"));
    const candidate = (name: string): [string, Candidate] => [
      name,
      { fullName: name, description: "Decompilation", topics: [], fork: false, archived: false, stars: 0, sizeKb: 10, pushedAt: RECENT, foundBy: ["readme-objdiff"] },
    ];
    const result = await runDiscover({
      root,
      github: new GitHub(globalThis.fetch, undefined, 1000),
      search: async () => new Map([candidate("copy/quest"), candidate("other/game")]),
      facts: async (n) =>
        facts({
          fullName: n,
          description: "Decompilation",
          paths: [n === "copy/quest" ? "config/GXXE01/build.sha1" : "config/GYYE01/build.sha1", ...facts().paths],
          reportArtifacts: ["us_report"],
        }),
    });
    const overlaps = Object.fromEntries(result.suggestions.map((s) => [s.fullName, s.overlaps]));
    assert.deepEqual(overlaps, { "copy/quest": ["example-quest"], "other/game": [] });
  });
});

describe("repoFromUrl", () => {
  it("accepts GitHub repo URLs only", () => {
    assert.equal(repoFromUrl("https://github.com/zeldaret/tww"), "zeldaret/tww");
    assert.equal(repoFromUrl("https://github.com/zeldaret/tww.git/"), "zeldaret/tww");
    assert.equal(repoFromUrl("https://gitlab.com/a/b"), null);
    assert.equal(repoFromUrl(""), null);
  });
});
