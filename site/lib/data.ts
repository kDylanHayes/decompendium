import { resolve } from "node:path";
import { loadSite, type SiteModel } from "../../src/site/model.ts";

export const REPO_URL = "https://github.com/kDylanHayes/decompendium";

let cached: SiteModel | undefined;

/** The catalog joined with the data branch, loaded once per build. DATA_DIR defaults to ./data. */
export function site(): SiteModel {
  cached ??= loadSite(process.cwd(), resolve(process.env.DATA_DIR ?? "data"));
  return cached;
}

/** A site path with the configured base, e.g. url("games/") → "/decompendium/games/". */
export function url(path = ""): string {
  const base = import.meta.env.BASE_URL.replace(/\/?$/, "/");
  return base + path.replace(/^\//, "");
}

/** A prefilled GitHub issue on the catalog repo. */
export function issueUrl(title: string, body: string): string {
  return `${REPO_URL}/issues/new?${new URLSearchParams({ title, body })}`;
}
