import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Absolute path of a file in this repository, e.g. repoFile("schema/game.schema.json").
 * Resolved from this module's location, or from the working directory when the
 * module has been bundled elsewhere (the Astro build moves it into dist/).
 */
export function repoFile(relative: string): string {
  const beside = fileURLToPath(new URL(`../${relative}`, import.meta.url));
  return existsSync(beside) ? beside : join(process.cwd(), relative);
}
