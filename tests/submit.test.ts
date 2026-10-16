import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { parseYaml } from "../src/catalog.ts";
import { COMMENT_MARKER, renderComment, type CheckResult } from "../src/submit/check.ts";
import { findGame, gameYaml, projectYaml, slug } from "../src/submit/draft.ts";
import { parseIssueForm, readSubmission } from "../src/submit/form.ts";
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

describe("issue form parsing", () => {
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
  const base: CheckResult = { items: [], blocked: false, facts: null, assessment: null, identification: null, submitterMaintains: false, draft: null };

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
