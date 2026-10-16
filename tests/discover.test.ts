import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { repoFromUrl, type RepoFacts } from "../src/discover/facts.ts";
import { deepCheck, type DeepFindings } from "../src/discover/deep.ts";
import { decide, evaluate, runDiscover, serializeLedger, triage, versionCodes, type Ledger } from "../src/discover/run.ts";
import { searchCandidates, type Candidate } from "../src/discover/search.ts";
import { assess, type Assessment } from "../src/discover/signals.ts";
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

  it("rates unmodified decomp-toolkit template copies as unlikely", () => {
    const a = assess(facts({ description: "Decompilation", paths: ["config/GAMEID/build.sha1", "configure.py", ...facts().paths], reportArtifacts: ["GAMEID_report"] }));
    assert.ok(a.signals.some((s) => s.id === "template-copy"));
    const real = assess(facts({ paths: ["config/GAMEID/build.sha1", "config/GYQE01/build.sha1", ...facts().paths] }));
    assert.ok(!real.signals.some((s) => s.id === "template-copy"), "a real config next to the placeholder is fine");
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

describe("triage", () => {
  const candidate = (over: Partial<Candidate> = {}): Candidate => ({
    fullName: "someone/game", description: "", topics: [], fork: false, archived: false, stars: 0, sizeKb: 100, pushedAt: null, foundBy: ["q"], ...over,
  });
  const none = new Set<string>();
  const listed = new Set(["https://github.com/zeldaret/tww"]);

  it("rules out only with high confidence, using search data alone", () => {
    assert.equal(triage(candidate({ fullName: "zeldaret/TWW" }), listed, none, none), "already listed");
    assert.equal(triage(candidate(), none, new Set(["https://github.com/someone/game"]), none), "opted out");
    assert.equal(triage(candidate(), none, none, new Set(["https://github.com/someone/game"])), "excluded by a maintainer");
    assert.equal(triage(candidate({ fork: true }), none, none, none), "fork");
    assert.equal(triage(candidate({ fork: true, stars: 12 }), none, none, none), null); // a starred fork may be the active project
    assert.equal(triage(candidate({ sizeKb: 0 }), none, none, none), "empty");
    assert.match(triage(candidate({ description: "A GameCube & Wii decompilation toolkit" }), none, none, none)!, /^tool/);
    assert.match(triage(candidate({ fullName: "x/Zelda64Recomp", description: "Static recompilation for PC" }), none, none, none)!, /^look-alike/);
    assert.equal(triage(candidate({ description: "Decompilation, modding and map editing" }), none, none, none), null);
    assert.equal(triage(candidate({ description: "Decompilation of Game" }), none, none, none), null);
    // Named as a port: out, even when built on a decomp. "Recompilation" alone stays in.
    assert.equal(triage(candidate({ fullName: "x/MetroidPrimePort", description: "Port of the Prime decomp" }), none, none, none), "look-alike: port");
    assert.equal(triage(candidate({ fullName: "x/report-viewer", description: "Decompilation" }), none, none, none), null);
    assert.equal(triage(candidate({ fullName: "x/mkp", description: "Recompilation project of a game" }), none, none, none), null);
    // Only games are listed.
    assert.match(triage(candidate({ description: "Decompilation of sead: the standard C++ library for Nintendo games" }), none, none, none)!, /^tool: library/);
    assert.match(triage(candidate({ description: "A decompilation of the Dolphin SDK Libraries" }), none, none, none)!, /^tool/);
  });
});

describe("decide", () => {
  const base = (over: Partial<Assessment>): Assessment => ({
    fullName: "a/b", score: 10, verdict: "likely", signals: [], hashEvidence: [], reportArtifacts: [], ...over,
  });
  const deep = (over: Partial<DeepFindings> = {}): DeepFindings => ({ hashCheck: null, objdiffCI: null, checked: [], ...over });

  it("needs no deep check for a hash file plus objdiff reports", () => {
    assert.equal(decide(base({ hashEvidence: ["a.sha1"], reportArtifacts: ["us_report"] })).status, "likely");
  });
  it("excludes unlikely repos, after a deep look if they call themselves a decomp", () => {
    assert.equal(decide(base({ verdict: "unlikely", score: 2 })).status, "excluded");
    const borderline = base({ verdict: "unlikely", score: 3, signals: [{ id: "named-decomp", weight: 2 }, { id: "has-source", weight: 1 }] });
    assert.equal(decide(borderline).needsDeep, true);
    assert.equal(decide(borderline, deep()).status, "excluded");
    assert.equal(decide(borderline, deep({ hashCheck: "ci.yml: sha256sum -c" })).status, "likely");
  });
  it("treats a decomp.dev badge as evidence of reports", () => {
    const a = base({ hashEvidence: ["ph_eur.sha1"], signals: [{ id: "decomp-dev-badge", weight: 3 }] });
    assert.equal(decide(a).status, "likely");
  });
  it("sends anything else to a deep check, which settles it", () => {
    const a = base({ verdict: "possible", score: 5 });
    assert.deepEqual(decide(a), { status: "possible", reason: "score 5; needs a deep check", needsDeep: true });
    assert.equal(decide(a, deep({ hashCheck: "Makefile: sha1sum -c" })).status, "likely");
    assert.equal(decide(a, deep()).status, "excluded");
    assert.equal(decide(base({ verdict: "possible", hashEvidence: ["rom.sha1"] }), deep()).status, "possible"); // a person decides
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
  const strong = (name: string) =>
    facts({ fullName: name, description: "Decompilation of Good", reportArtifacts: ["us_report"], paths: ["good.sha1", ...facts().paths] });
  const github = () => new GitHub(globalThis.fetch, undefined, 1000);

  it("records decisions in the ledger and does not redo them", async () => {
    const root = copyFixture();
    const search = async () =>
      cands([
        { fullName: "good/decomp" },
        { fullName: "tool/thing", description: "a decompiler" },
        { fullName: "example-org/example-quest" }, // listed in the fixture catalog
      ]);
    const fetched: string[] = [];
    const factsFor = async (name: string) => (fetched.push(name), strong(name));
    const first = await runDiscover({ root, github: github(), search, facts: factsFor });
    assert.deepEqual(fetched, ["good/decomp"]);
    assert.deepEqual(first.suggestions.map((s) => [s.fullName, s.status]), [["good/decomp", "likely"]]);
    assert.equal(first.triaged["example-org/example-quest"], "already listed");
    assert.equal(first.triaged["tool/thing"], "tool: decompiler");
    assert.equal(first.ledger.repos["tool/thing"], undefined, "free decisions are not stored");

    const second = await runDiscover({ root, github: github(), search, facts: factsFor, ledger: readBack(first.ledger) });
    assert.deepEqual(fetched, ["good/decomp"], "decided repos are not fetched again");
    assert.equal(second.suggestions.length, 1);

    const ev = evaluate(second, ["good/decomp", "example-org/example-quest", "missing/repo", "tool/thing"]);
    assert.deepEqual([ev.found, ev.keptByTriage, ev.likely], [3, 2, 1]);
    assert.deepEqual(ev.misses.map((m) => m.reason), ["not found by search", "triage: tool: decompiler"]);
  });

  it("deep-checks possible repos and settles them", async () => {
    const root = copyFixture();
    const search = async () => cands([{ fullName: "a/verified" }, { fullName: "a/unverified" }]);
    const weak = (name: string) => facts({ fullName: name, description: "Decompilation of a game", readme: "a matching decompilation", paths: ["Makefile", ...facts().paths] });
    const deepFor = async (f: RepoFacts): Promise<DeepFindings> => ({
      hashCheck: f.fullName === "a/verified" ? "Makefile: sha1sum -c" : null, objdiffCI: null, checked: ["Makefile"],
    });
    const result = await runDiscover({ root, github: github(), search, facts: async (n) => weak(n), deep: deepFor });
    assert.equal(result.ledger.repos["a/verified"]!.status, "likely");
    assert.equal(result.ledger.repos["a/unverified"]!.status, "excluded");
    assert.equal(result.ledger.repos["a/unverified"]!.reason, "no hash file and no hash check in build or CI");
    assert.deepEqual(result.suggestions.map((s) => s.fullName), ["a/verified"]);
  });

  it("revisits an excluded repo only when its description changes, or after long enough", async () => {
    const root = copyFixture();
    let description = "Decompilation of a game";
    const search = async () => cands([{ fullName: "a/b", description }]);
    const fetched: string[] = [];
    const weak = async (n: string) => (fetched.push(n), facts({ fullName: n, description, paths: facts().paths.slice(0, 30) }));
    const nothing = async (): Promise<DeepFindings> => ({ hashCheck: null, objdiffCI: null, checked: [] });
    const first = await runDiscover({ root, github: github(), search, facts: weak, deep: nothing });
    assert.equal(first.ledger.repos["a/b"]!.status, "excluded");
    await runDiscover({ root, github: github(), search, facts: weak, deep: nothing, ledger: first.ledger });
    assert.equal(fetched.length, 1);
    description = "Matching decompilation of a game";
    await runDiscover({ root, github: github(), search, facts: weak, deep: nothing, ledger: first.ledger });
    assert.equal(fetched.length, 2);
  });

  it("looks at weak candidates last, and stops at the API-call budget", async () => {
    const root = copyFixture();
    const search = async () =>
      cands([
        { fullName: "weak/old", foundBy: ["name-decompilation"], pushedAt: "2015-01-01T00:00:00Z" },
        { fullName: "a/one" },
        { fullName: "a/two" },
      ]);
    const gh = github();
    const order: string[] = [];
    const factsFor = async (n: string) => {
      order.push(n);
      gh.requests += 5; // what a real facts fetch costs
      return strong(n);
    };
    const result = await runDiscover({ root, github: gh, search, facts: factsFor, budget: 10 });
    assert.deepEqual(order.sort(), ["a/one", "a/two"]);
    assert.equal(result.queued, 1);
    assert.equal(result.deferred, 1);
    assert.equal(result.requests, 10);
  });

  it("never suggests repos a maintainer excluded", async () => {
    const root = copyFixture();
    editYaml(root, "config.yaml", (c) => (c.excluded = [{ repo: "https://github.com/good/decomp", reason: "copy of a listed project" }]));
    const result = await runDiscover({ root, github: github(), search: async () => cands([{ fullName: "good/decomp" }]), facts: async (n) => strong(n) });
    assert.equal(result.triaged["good/decomp"], "excluded by a maintainer");
    assert.equal(result.suggestions.length, 0);
  });
});

/** A ledger as the next run would read it from disk. */
function readBack(ledger: Ledger): Ledger {
  return JSON.parse(serializeLedger(ledger));
}

describe("deepCheck", () => {
  /** A GitHub client whose raw file reads come from `files`. */
  const fileServer = (files: Record<string, string>) =>
    new GitHub(
      (async (input: string | URL) => {
        const path = decodeURIComponent(new URL(String(input)).pathname.replace(/^\/repos\/a\/b\/contents\//, ""));
        return path in files ? new Response(files[path]) : new Response("", { status: 404 });
      }) as typeof globalThis.fetch,
      "t",
      1000,
    );

  it("finds a hash comparison in CI and objdiff report generation", async () => {
    const files = {
      ".github/workflows/build.yml": "- run: ninja\n- run: objdiff-cli report generate -o report.json\n- run: sha1sum -c rom.sha1",
    };
    const found = await deepCheck(fileServer(files), facts({ fullName: "a/b", paths: [".github/workflows/build.yml", "Makefile"] }));
    assert.match(found.hashCheck!, /^\.github\/workflows\/build\.yml: sha1sum -c/);
    assert.equal(found.objdiffCI, ".github/workflows/build.yml");
  });

  it("reads build scripts, and falls back to README instructions", async () => {
    const make = await deepCheck(fileServer({ Makefile: "compare:\n\t$(SHA1SUM) --check $(TARGET).sha1" }), facts({ fullName: "a/b", paths: ["Makefile"] }));
    assert.match(make.hashCheck!, /^Makefile:/);
    const readme = await deepCheck(fileServer({}), facts({ fullName: "a/b", paths: [], readme: "run make. it should print: game.z64: ok" }));
    assert.match(readme.hashCheck!, /^README:/);
    const none = await deepCheck(fileServer({ Makefile: "all:\n\tgcc main.c" }), facts({ fullName: "a/b", paths: ["Makefile"] }));
    assert.equal(none.hashCheck, null);
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
