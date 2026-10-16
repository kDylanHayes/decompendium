import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { parseYaml } from "../src/catalog.ts";
import { COMMENT_MARKER, renderComment, type CheckResult } from "../src/submit/check.ts";
import { fetchFacts, uploadedReportFiles, type RepoFacts } from "../src/discover/facts.ts";
import type { Identification } from "../src/identify/identify.ts";
import { GitHub } from "../src/ingest/http.ts";
import { findGame, gameYaml, gamesIn, makeDraft, projectYaml, readmeHash, slug, targetLabel, versionLabel } from "../src/submit/draft.ts";
import { issueBody, parseIssueForm, readSubmission } from "../src/submit/form.ts";
import { schemaErrors } from "../src/schemas.ts";

// What GitHub renders for a filled-in submit-project.yml.
const BODY = `### Repository URL

https://github.com/doldecomp/mkw

### Game

Mario Kart Wii

### Platform

Wii

### Versions it builds

_No response_

### Progress data

objdiff report (CI artifact)

### Report location

RMCP01_report, report.json

### AI-assisted contributions

Discouraged

### Checks

- [X] It's a game (not an SDK, library, compiler, emulator or system software)
- [X] The build checks its output against a hash of the original binary
- [ ] I'm a maintainer of this project (optional)

### Notes

_No response_`;

describe("version labels", () => {
  it("names PlayStation serials by region", () => {
    assert.equal(versionLabel("SLES_011.76"), "Europe (SLES-01176)");
    assert.equal(versionLabel("scus_942.36"), "USA (SCUS-94236)");
    assert.equal(versionLabel("SLPM_86.053"), "Japan (SLPM-86053)");
    assert.equal(versionLabel("us"), "US");
    assert.equal(versionLabel("Kiosk"), "Kiosk");
  });
});

describe("issue form parsing", () => {
  it("writes bodies the parser reads back (finder-made issues)", () => {
    const sub = {
      repo: "https://github.com/a/b", game: "Rock Band 3", platform: "wii", targets: "", progress: "Not sure", report: "",
      aiPolicy: "unspecified" as const, isGame: true, verifiesHash: true, isMaintainer: false,
      notes: "Submitted by the finder for review: game not confirmed.",
    };
    assert.deepEqual(readSubmission(issueBody(sub)), sub);
    assert.equal(readSubmission(issueBody({ ...sub, platform: null })).platform, null);
  });

  it("reads every field, treating _No response_ as empty", () => {
    const f = parseIssueForm(BODY);
    assert.equal(f["Repository URL"], "https://github.com/doldecomp/mkw");
    assert.equal(f["Versions it builds"], "");
  });

  it("maps answers onto a submission", () => {
    const s = readSubmission(BODY);
    assert.equal(s.repo, "https://github.com/doldecomp/mkw");
    assert.equal(s.game, "Mario Kart Wii");
    assert.equal(s.platform, "wii");
    assert.equal(s.aiPolicy, "discouraged");
    assert.equal(s.report, "RMCP01_report, report.json");
    assert.deepEqual([s.isGame, s.verifiesHash, s.isMaintainer], [true, true, false]);
  });

  it("treats 'Other or not sure' as no platform", () => {
    assert.equal(readSubmission(BODY.replace("\nWii\n", "\nOther or not sure\n")).platform, null);
  });

  it("matches the platform options in the form to config.yaml", () => {
    const form = readFileSync(new URL("../.github/ISSUE_TEMPLATE/submit-project.yml", import.meta.url), "utf8");
    const block = form.slice(form.indexOf("id: platform"), form.indexOf("validations:", form.indexOf("id: platform")));
    const options = [...block.matchAll(/^ {8}- (.+)$/gm)].map((m) => m[1]!).filter((o) => o !== "Other or not sure");
    assert.ok(options.length > 20);
    for (const name of options) {
      assert.notEqual(readSubmission(BODY.replace("\nWii\n", `\n${name}\n`)).platform, null, name);
    }
  });
});

describe("drafts", () => {
  const game = { id: "mario-kart-wii", name: "Mario Kart Wii", platform: "wii", aliases: ["MKW"] };
  const project = {
    id: "mkw",
    name: "Mario Kart Wii decompilation",
    game: "mario-kart-wii",
    repo: "https://github.com/doldecomp/mkw",
    description: "Matching decompilation of Mario Kart Wii.",
    owners: ["doldecomp"],
    confirmed: false,
    ai_policy: "discouraged" as const,
    listed_at: "2026-10-16",
    targets: [
      {
        id: "rmcp01",
        label: "RMCP01 (Europe)",
        region: "eu",
        hash: { sha1: "ac7d72448630ade7655fc8bc5fd7a6543cb53a49" },
        progress: { kind: "objdiff" as const, source: { type: "github-artifact" as const, artifact: "RMCP01_report", path: "report.json" } },
      },
    ],
  };

  it("renders YAML that passes the catalog schemas", () => {
    assert.deepEqual(schemaErrors("game", parseYaml(gameYaml(game))), []);
    assert.deepEqual(schemaErrors("project", parseYaml(projectYaml(project))), []);
    assert.deepEqual(parseYaml(projectYaml(project)), project);
  });

  it("finds an existing game by name or alias on the same platform", () => {
    assert.equal(findGame([game], "mario kart wii", "wii")?.id, "mario-kart-wii");
    assert.equal(findGame([game], "MKW", null)?.id, "mario-kart-wii");
    assert.equal(findGame([game], "Mario Kart Wii", "gc"), undefined);
  });

  it("makes slugs from any title", () => {
    assert.equal(slug("Pokémon Pinball: Ruby & Sapphire"), "pokemon-pinball-ruby-sapphire");
    assert.equal(slug("GM8E01_00"), "gm8e01-00");
  });
});

describe("bot comment", () => {
  const base: CheckResult = { items: [], blocked: false, facts: null, assessment: null, identification: null, submitterMaintains: false, hashCheck: null, draft: null };

  it("starts with a marker so the bot updates its own comment", () => {
    const body = renderComment({ ...base, items: [{ status: "pass", text: "Found it." }] }, null);
    assert.ok(body.startsWith(COMMENT_MARKER));
    assert.match(body, /✅ Found it\./);
    assert.match(body, /Ready for review/);
  });

  it("says what blocks a submission", () => {
    const body = renderComment({ ...base, blocked: true, items: [{ status: "fail", text: "Already listed." }] }, null);
    assert.match(body, /❌ Already listed\./);
    assert.match(body, /Needs attention/);
  });
});

/** A GitHub client answering API paths (with their query strings) from `routes`; strings are raw files. */
function fakeGitHub(routes: Record<string, unknown>): GitHub {
  return new GitHub(
    (async (input: string | URL) => {
      const url = new URL(String(input));
      const body = routes[decodeURIComponent(url.pathname + url.search)] ?? routes[decodeURIComponent(url.pathname)];
      if (body === undefined) return new Response("", { status: 404 });
      return new Response(typeof body === "string" ? body : JSON.stringify(body));
    }) as typeof globalThis.fetch,
    "t",
    1000,
  );
}

function repoFacts(over: Partial<RepoFacts>): RepoFacts {
  return {
    fullName: "a/b", url: "https://github.com/a/b", description: "", topics: [], fork: false, archived: false, stars: 10,
    pushedAt: "2026-10-01T00:00:00Z", createdAt: "2024-01-01T00:00:00Z", defaultBranch: "main", language: "C", sizeKb: 5000,
    paths: [], treeTruncated: false, readme: "", reportArtifacts: [], reportFiles: {}, ...over,
  };
}

const submission = {
  repo: "https://github.com/a/b", game: "", platform: null, targets: "", progress: "Not sure", report: "",
  aiPolicy: "unspecified" as const, isGame: true, verifiesHash: true, isMaintainer: false, notes: "",
};

const release = (title: string, region: string, code: string, platform = "ps2") => ({
  title, name: `${title} (${region})`, platform, region, via: `code ${code}`, match: { kind: "code" as const, value: code },
});

const draft = (github: GitHub, facts: RepoFacts, identification: Identification) =>
  makeDraft({ github, facts, submission, identification, games: [], projectIds: new Set(), submitterMaintains: false, today: "2026-10-16" });

const PS_WORKFLOW = `jobs:
  build:
    strategy:
      matrix:
        game_id: [SLUS_010.13, SLPS_021.70]
    steps:
      - uses: actions/checkout@v4
      - name: Upload Progress Report
        uses: actions/upload-artifact@v4
        with:
            name: \${{ matrix.game_id }}_report
            path: ./build/\${{ matrix.dir_name }}/progress.json
      - name: Upload audit
        uses: actions/upload-artifact@v4
        with:
          name: build-audit
          path: |
            build/report.all.json
            build/report.json.raw
`;

describe("report artifact files", () => {
  it("reads each artifact's file name from the workflow's upload steps", () => {
    assert.deepEqual(uploadedReportFiles(PS_WORKFLOW, ["SLUS_010.13_report", "SLPS_021.70_report", "build-audit"]), {
      "SLUS_010.13_report": "progress.json",
      "SLPS_021.70_report": "progress.json",
    });
    const dds = `      - name: Upload dds1 report
        if: steps.orig.outputs.available == 'true'
        uses: actions/upload-artifact@v5
        with:
          name: dds1_report
          path: build/dds1/report.json

      - name: Upload dds2 report
        uses: actions/upload-artifact@v5
        with:
          name: "dds2_report"
          path: build/dds2/report.json  # objdiff
        if: always()
`;
    assert.deepEqual(uploadedReportFiles(dds, ["dds1_report", "dds2_report"]), { dds1_report: "report.json", dds2_report: "report.json" });
  });

  it("fetches the workflow of the run that uploaded the reports", async () => {
    const github = fakeGitHub({
      "/repos/a/b": { full_name: "a/b", html_url: "https://github.com/a/b", description: null, fork: false, archived: false, stargazers_count: 1, pushed_at: "", created_at: "", default_branch: "main", language: "C", size: 1 },
      "/repos/a/b/git/trees/main?recursive=1": { tree: [{ path: "config/SLUS_010.13.yaml", type: "blob" }], truncated: false },
      "/repos/a/b/actions/runs?branch=main&event=push&status=success&per_page=10": { workflow_runs: [{ id: 7, workflow_id: 1, path: ".github/workflows/build.yaml" }] },
      "/repos/a/b/actions/runs/7/artifacts?per_page=100": { artifacts: [{ name: "SLUS_010.13_report" }, { name: "build-audit" }] },
      "/repos/a/b/contents/.github/workflows/build.yaml?ref=main": PS_WORKFLOW,
    });
    const f = (await fetchFacts(github, "a/b"))!;
    assert.deepEqual(f.reportArtifacts, ["SLUS_010.13_report"]);
    assert.deepEqual(f.reportFiles, { "SLUS_010.13_report": "progress.json" });
  });

  it("puts that file name in the draft's progress source", async () => {
    const github = fakeGitHub({ "/repos/a/b/contents/config/SLUS_010.13.sha1?ref=main": "da39a3ee5e6b4b0d3255bfef95601890afd80709  SLUS_010.13\n" });
    const facts = repoFacts({ paths: ["config/SLUS_010.13.sha1"], reportArtifacts: ["SLUS_010.13_report"], reportFiles: { "SLUS_010.13_report": "progress.json" } });
    const d = await draft(github, facts, { status: "identified", title: "Game", platform: "ps1", releases: [], nonGame: null, aliases: [] });
    assert.deepEqual(d.project.targets[0]!.progress, { kind: "objdiff", source: { type: "github-artifact", artifact: "SLUS_010.13_report", path: "progress.json" } });
  });
});

describe("draft targets", () => {
  it("labels versions that only name a platform by the platform", () => {
    assert.equal(targetLabel("sum-pc", "win32"), "PC");
    assert.equal(targetLabel("54540859", "x360"), "Xbox 360 (title 54540859)");
    assert.equal(targetLabel("SLUS_209.74", "ps2"), "USA (SLUS-20974)");
    assert.equal(targetLabel("us", "n64"), "US");
  });

  it("uses decomp-toolkit folder names for the label", async () => {
    const github = fakeGitHub({ "/repos/a/b/contents/config/sum-pc/build.sha1?ref=main": "da39a3ee5e6b4b0d3255bfef95601890afd80709 build/sum.exe\n" });
    const d = await draft(github, repoFacts({ paths: ["config/sum-pc/build.sha1"] }), { status: "identified", title: "Summoner", platform: "win32", releases: [], nonGame: null, aliases: [] });
    assert.equal(d.project.targets[0]!.label, "PC");
  });

  it("makes one target per version folder, not one per data file hash", async () => {
    const files = ["battle_tables", "event_scripts", "field_amb", "scripts"];
    const paths = ["dds1", "dds2"].flatMap((v) => [...files.map((n) => `config/${v}/${n}.sha1`), `config/${v}/symbol_addrs.txt`]);
    paths.push("config/dds1/SLUS_209.74.yaml", "config/dds2/SLUS_211.52.yaml");
    const routes: Record<string, unknown> = {
      "/repos/a/b/contents/config/dds1/SLUS_209.74.yaml?ref=main": 'name: "DDS (USA)"\nsha1: 6d18898e2724bf1d145392766e8ba1e678487419\noptions:\n  basename: SLUS_209.74\n',
      "/repos/a/b/contents/config/dds2/SLUS_211.52.yaml?ref=main": "sha1: 9be91ee1b4a535a4cb6ec89237b5a6ba41be2add\n",
    };
    for (const p of paths.filter((p) => p.endsWith(".sha1"))) routes[`/repos/a/b/contents/${p}?ref=main`] = "0123456789abcdef0123456789abcdef01234567  data.bin\n";
    const facts = repoFacts({ paths, reportArtifacts: ["dds1_report", "dds2_report"], reportFiles: { dds1_report: "report.json", dds2_report: "report.json" } });
    const id: Identification = {
      status: "identified", title: "Shin Megami Tensei: Digital Devil Saga", platform: "ps2", nonGame: null,
      releases: [release("Shin Megami Tensei: Digital Devil Saga", "USA", "SLUS_209.74"), release("Shin Megami Tensei: Digital Devil Saga 2", "USA", "SLUS_211.52")],
      aliases: ["Shin Megami Tensei: Digital Devil Saga 2"],
    };
    const d = await draft(fakeGitHub(routes), facts, id);
    assert.deepEqual(d.project.targets, [
      {
        id: "slus-209-74",
        label: "USA (SLUS-20974)",
        hash: { sha1: "6d18898e2724bf1d145392766e8ba1e678487419" },
        progress: { kind: "objdiff", source: { type: "github-artifact", artifact: "dds1_report", path: "report.json" } },
      },
    ]);
    // The second game is flagged for its own entry, not folded in as an alias.
    assert.deepEqual(d.otherGames, ["Shin Megami Tensei: Digital Devil Saga 2"]);
    assert.equal(d.game.aliases, undefined);
  });

  it("falls back to a README table for a version folder without a splat hash", async () => {
    assert.equal(readmeHash("| version | sha1 |\n| slus-20974 | 6d18898e2724bf1d145392766e8ba1e678487419 |", ["SLUS_209.74"]), "6d18898e2724bf1d145392766e8ba1e678487419");
    const routes = { "/repos/a/b/contents/config/us/scripts.sha1?ref=main": "0123456789abcdef0123456789abcdef01234567  scripts.bin\n" };
    const facts = repoFacts({
      paths: ["config/us/scripts.sha1", "config/us/fields.sha1"],
      reportArtifacts: ["us_report"],
      readme: "| us | `6d18898e2724bf1d145392766e8ba1e678487419` |",
    });
    const d = await draft(fakeGitHub(routes), facts, { status: "identified", title: "Game", platform: "ps2", releases: [], nonGame: null, aliases: [] });
    assert.deepEqual(d.project.targets.map((t) => [t.id, Object.values(t.hash)[0]]), [["us", "6d18898e2724bf1d145392766e8ba1e678487419"]]);
  });
});

describe("games in an identification", () => {
  it("keeps regional titles of one game together", () => {
    const id: Identification = {
      status: "identified", title: "Shin Megami Tensei: Digital Devil Saga", platform: "ps2", nonGame: null, aliases: [],
      releases: [release("Shin Megami Tensei: Digital Devil Saga", "USA", "SLUS_209.74"), release("Digital Devil Saga: Avatar Tuner", "Japan", "SLPM_654.24")],
    };
    assert.deepEqual(gamesIn(id).map((g) => g.title), ["Shin Megami Tensei: Digital Devil Saga"]);
  });

  it("keeps paired versions together", () => {
    const id: Identification = {
      status: "identified", title: "Pokemon - Red Version", platform: "gb", nonGame: null, aliases: [],
      releases: [release("Pokemon - Red Version", "USA, Europe", "", "gb"), release("Pokemon - Blue Version", "USA, Europe", "", "gb")],
    };
    assert.equal(gamesIn(id).length, 1);
  });

  it("separates games released in the same region", () => {
    const id: Identification = {
      status: "identified", title: "Shin Megami Tensei: Digital Devil Saga", platform: "ps2", nonGame: null, aliases: [],
      releases: [
        release("Shin Megami Tensei: Digital Devil Saga 2", "USA", "SLUS_211.52"),
        release("Shin Megami Tensei: Digital Devil Saga", "USA", "SLUS_209.74"),
        release("Digital Devil Saga: Avatar Tuner", "Japan", "SLPM_654.24"),
        release("Digital Devil Saga: Avatar Tuner 2", "Japan", "SLPM_655.85"),
      ],
    };
    const games = gamesIn(id);
    assert.deepEqual(games.map((g) => g.title), ["Shin Megami Tensei: Digital Devil Saga", "Shin Megami Tensei: Digital Devil Saga 2"]);
    assert.deepEqual(games[1]!.releases.map((r) => r.match.value).sort(), ["SLPM_655.85", "SLUS_211.52"]);
  });
});
