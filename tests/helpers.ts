import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after } from "node:test";
import { parse, stringify } from "yaml";

export const fixtureRoot = new URL("./fixtures/catalog/", import.meta.url).pathname;

const tempDirs: string[] = [];
after(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

/** A throwaway copy of the fixture catalog that a test can modify. */
export function copyFixture(): string {
  const dir = mkdtempSync(join(tmpdir(), "decompendium-test-"));
  tempDirs.push(dir);
  cpSync(fixtureRoot, dir, { recursive: true });
  return dir;
}

/** Parse a YAML file in `root`, let `edit` change it, and write it back. */
export function editYaml(root: string, file: string, edit: (data: any) => void): void {
  const path = join(root, file);
  const data = parse(readFileSync(path, "utf8"));
  edit(data);
  writeFileSync(path, stringify(data));
}

export function writeText(root: string, file: string, text: string): void {
  writeFileSync(join(root, file), text);
}
