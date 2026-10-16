import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { stringify } from "yaml";
import { parseYaml, type Config } from "../src/catalog.ts";
import { classifyChanges } from "../src/review.ts";
import { fixtureRoot } from "./helpers.ts";

const config = parseYaml(readFileSync(`${fixtureRoot}/config.yaml`, "utf8")) as Config;
const path = "catalog/projects/example-quest.yaml";
const original = readFileSync(`${fixtureRoot}/${path}`, "utf8");

/** The fixture project with `edit` applied, as YAML text. */
function edited(edit: (p: any) => void): string {
  const data = parseYaml(original) as any;
  edit(data);
  return stringify(data);
}

describe("classifyChanges", () => {
  it("trusts catalog maintainers with any change", () => {
    const result = classifyChanges([{ path: "config.yaml", before: "a", after: "b" }], "KDYLANHAYES", config);
    assert.equal(result.verdict, "maintainer");
  });

  it("accepts an owner editing owner fields of their project", () => {
    const after = edited((p) => {
      p.show_in_index = false;
      p.ai_policy = "prohibited";
      p.note = "Paused for the summer.";
    });
    const result = classifyChanges([{ path, before: original, after }], "example-maintainer", config);
    assert.deepEqual(result, {
      verdict: "owner-change",
      notes: [`${path}: owner edit by example-maintainer`],
      violations: [],
    });
  });

  it("accepts an owner removing their project", () => {
    const result = classifyChanges([{ path, before: original }], "second-maintainer", config);
    assert.equal(result.verdict, "owner-change");
    assert.match(result.notes[0]!, /opt-out/);
  });

  it("flags owners changing maintainer-only fields", () => {
    const after = edited((p) => {
      p.game = "example-racer";
      p.listed_at = "2020-01-01";
    });
    const result = classifyChanges([{ path, before: original, after }], "example-maintainer", config);
    assert.equal(result.verdict, "needs-review");
    assert.equal(result.violations.length, 2);
    assert.match(result.violations[0]!, /cannot change "game"/);
  });

  it("flags turning confirmed off", () => {
    const after = edited((p) => (p.confirmed = false));
    const result = classifyChanges([{ path, before: original, after }], "example-maintainer", config);
    assert.match(result.violations[0]!, /"confirmed" cannot be turned off/);
  });

  it("sends edits by non-owners to review without failing", () => {
    const after = edited((p) => (p.note = "drive-by"));
    const result = classifyChanges([{ path, before: original, after }], "someone-else", config);
    assert.equal(result.verdict, "needs-review");
    assert.deepEqual(result.violations, []);
  });

  it("sends new projects and non-project files to review", () => {
    const result = classifyChanges(
      [
        { path: "catalog/projects/new-one.yaml", after: original },
        { path: "catalog/games/example-quest.yaml", before: "x", after: "y" },
      ],
      "example-maintainer",
      config,
    );
    assert.equal(result.verdict, "needs-review");
    assert.equal(result.notes.length, 2);
  });

  it("does not let an owner of one project edit another in the same PR", () => {
    const other = readFileSync(`${fixtureRoot}/catalog/projects/example-racer.yaml`, "utf8");
    const result = classifyChanges(
      [
        { path, before: original, after: edited((p) => (p.note = "ok")) },
        { path: "catalog/projects/example-racer.yaml", before: other, after: other + "\n" },
      ],
      "example-maintainer",
      config,
    );
    assert.equal(result.verdict, "needs-review");
  });
});
