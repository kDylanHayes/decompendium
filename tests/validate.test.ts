import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { progressErrors, validateCatalog } from "../src/validate.ts";
import { copyFixture, editYaml, fixtureRoot, writeText } from "./helpers.ts";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

/** Validate a modified copy of the fixture and return the problem messages. */
function problemsAfter(change: (root: string) => void): string[] {
  const root = copyFixture();
  change(root);
  return validateCatalog(root).problems.map((p) => `${p.file}: ${p.message}`);
}

function assertProblem(problems: string[], pattern: RegExp): void {
  assert.ok(
    problems.some((p) => pattern.test(p)),
    `expected a problem matching ${pattern}, got:\n${problems.join("\n") || "(none)"}`,
  );
}

describe("validateCatalog", () => {
  it("accepts the fixture catalog", () => {
    const result = validateCatalog(fixtureRoot);
    assert.deepEqual(result.problems, []);
    assert.equal(result.games, 2);
    assert.equal(result.projects, 3);
    assert.equal(result.targets, 4);
  });

  it("accepts the real catalog", () => {
    assert.deepEqual(validateCatalog(repoRoot).problems, []);
  });

  it("requires config.yaml", () => {
    const problems = problemsAfter((root) => rmSync(`${root}/config.yaml`));
    assertProblem(problems, /config\.yaml: missing/);
  });

  it("reports YAML syntax errors and duplicate keys", () => {
    assertProblem(
      problemsAfter((root) => writeText(root, "catalog/games/example-racer.yaml", "id: [unclosed\n")),
      /example-racer\.yaml: invalid YAML/,
    );
    assertProblem(
      problemsAfter((root) => writeText(root, "catalog/games/example-racer.yaml", "id: a\nid: b\n")),
      /example-racer\.yaml: invalid YAML/,
    );
  });

  it("rejects unknown fields so typos are caught", () => {
    const problems = problemsAfter((root) =>
      editYaml(root, "catalog/projects/example-racer.yaml", (p) => (p.show_in_idex = false)),
    );
    assertProblem(problems, /unknown field "show_in_idex"/);
  });

  it("requires the id to match the file name", () => {
    const problems = problemsAfter((root) =>
      editYaml(root, "catalog/projects/example-racer.yaml", (p) => (p.id = "racer")),
    );
    assertProblem(problems, /id "racer" must equal the file name "example-racer"/);
  });

  it("requires the game to exist", () => {
    const problems = problemsAfter((root) =>
      editYaml(root, "catalog/projects/example-racer.yaml", (p) => (p.game = "missing-game")),
    );
    assertProblem(problems, /game "missing-game" does not exist/);
  });

  it("requires a configured platform", () => {
    const problems = problemsAfter((root) =>
      editYaml(root, "catalog/games/example-racer.yaml", (g) => (g.platform = "atari-jaguar")),
    );
    assertProblem(problems, /platform "atari-jaguar" is not in config\.yaml/);
  });

  it("rejects a game name already used by another game on the same platform", () => {
    const problems = problemsAfter((root) =>
      writeText(root, "catalog/games/eq-copy.yaml", "id: eq-copy\nname: example quest!\nplatform: n64\n"),
    );
    // Files are read in name order, so the clash is reported on example-quest.yaml.
    assertProblem(problems, /example-quest\.yaml: name or alias "Example Quest" is already used by game "eq-copy"/);
  });

  it("allows the same game name on a different platform", () => {
    const problems = problemsAfter((root) =>
      writeText(root, "catalog/games/example-quest-ds.yaml", "id: example-quest-ds\nname: Example Quest\nplatform: nds\n"),
    );
    assert.deepEqual(problems, []);
  });

  it("restricts repo hosts", () => {
    const problems = problemsAfter((root) =>
      editYaml(root, "catalog/projects/example-racer.yaml", (p) => (p.repo = "https://example.com/team/racer")),
    );
    assertProblem(problems, /repo host "example\.com" is not in config\.yaml allowed_hosts/);
  });

  it("requires https repo URLs that point at a repository", () => {
    assertProblem(
      problemsAfter((root) =>
        editYaml(root, "catalog/projects/example-racer.yaml", (p) => (p.repo = "http://github.com/racer-team/x")),
      ),
      /\/repo: must match pattern/,
    );
    assertProblem(
      problemsAfter((root) =>
        editYaml(root, "catalog/projects/example-racer.yaml", (p) => (p.repo = "https://github.com/racer-team")),
      ),
      /must point at a repository/,
    );
  });

  it("rejects a repo listed twice for the same game, ignoring case and .git", () => {
    const problems = problemsAfter((root) =>
      editYaml(root, "catalog/projects/example-racer.yaml", (p) => {
        p.repo = "https://github.com/Example-Org/example-quest.git";
        p.game = "example-quest";
      }),
    );
    assertProblem(problems, /already listed for this game as project "example-quest"/);
  });

  it("allows one repo under two games (a repo that builds two games)", () => {
    const problems = problemsAfter((root) =>
      editYaml(root, "catalog/projects/example-racer.yaml", (p) => (p.repo = "https://github.com/Example-Org/example-quest")),
    );
    assert.deepEqual(problems.filter((p) => /already listed/.test(p)), []);
  });

  it("rejects repos on the opt-out list", () => {
    const problems = problemsAfter((root) =>
      editYaml(root, "config.yaml", (c) => (c.opted_out = ["https://github.com/racer-team/example-racer/"])),
    );
    assertProblem(problems, /example-racer\.yaml: repo .* opted out of listing/);
  });

  it("rejects duplicate target ids", () => {
    const problems = problemsAfter((root) =>
      editYaml(root, "catalog/projects/example-quest.yaml", (p) => (p.targets[1].id = "us")),
    );
    assertProblem(problems, /target id "us" is used more than once/);
  });

  it("requires at least one well-formed hash", () => {
    assertProblem(
      problemsAfter((root) => editYaml(root, "catalog/projects/example-racer.yaml", (p) => (p.targets[0].hash = {}))),
      /\/targets\/0\/hash: must NOT have fewer than 1 properties/,
    );
    assertProblem(
      problemsAfter((root) =>
        editYaml(root, "catalog/projects/example-racer.yaml", (p) => (p.targets[0].hash = { sha1: "ABC" })),
      ),
      /\/targets\/0\/hash\/sha1: must match pattern/,
    );
  });

  it("requires a source for objdiff and decompendium progress", () => {
    const problems = problemsAfter((root) =>
      editYaml(root, "catalog/projects/example-racer.yaml", (p) => (p.targets[0].progress = { kind: "objdiff" })),
    );
    assertProblem(problems, /\/targets\/0\/progress: must have required property 'source'/);
  });

  it("rejects artifact paths that escape the artifact", () => {
    const problems = problemsAfter((root) =>
      editYaml(root, "catalog/projects/example-quest.yaml", (p) => (p.targets[0].progress.source.path = "../x.json")),
    );
    assertProblem(problems, /\/targets\/0\/progress\/source\/path: must match pattern/);
  });

  it("rejects HTML in display text", () => {
    const problems = problemsAfter((root) =>
      editYaml(root, "catalog/projects/example-racer.yaml", (p) => (p.description = "<script>x</script>")),
    );
    assertProblem(problems, /\/description: must match pattern/);
  });

  it("rejects stray files in catalog directories", () => {
    const problems = problemsAfter((root) => writeText(root, "catalog/projects/notes.txt", "hi"));
    assertProblem(problems, /notes\.txt: only \.yaml files belong/);
  });
});

describe("progressErrors", () => {
  const valid = () => JSON.parse(readFileSync(new URL("./fixtures/progress/valid.json", import.meta.url), "utf8"));

  it("accepts a valid progress file", () => {
    assert.deepEqual(progressErrors(valid()), []);
  });

  it("accepts the minimal form", () => {
    assert.deepEqual(progressErrors({ schema: "decompendium-progress/1", code: { matched: 0, total: 10 } }), []);
  });

  it("rejects matched greater than total", () => {
    const report = valid();
    report.functions.matched = 2000;
    assert.deepEqual(progressErrors(report), ["/functions: matched (2000) exceeds total (1544)"]);
  });

  it("rejects an empty code total", () => {
    assert.deepEqual(progressErrors({ schema: "decompendium-progress/1", code: { matched: 0, total: 0 } }), [
      "/code: total must be greater than 0",
    ]);
  });

  it("rejects the wrong schema version and fractional counts", () => {
    const report = valid();
    report.schema = "decompendium-progress/2";
    report.code.matched = 1.5;
    const errors = progressErrors(report);
    assert.ok(errors.some((e) => e.startsWith("/schema:")), errors.join("\n"));
    assert.ok(errors.some((e) => e === "/code/matched: must be integer"), errors.join("\n"));
  });
});
