import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { cleanTitle, parseDat, serialKeys, type DatGame } from "./dat.ts";

/**
 * Release catalogues used to identify games, from libretro-database (CC BY-SA
 * 4.0), which mirrors No-Intro and Redump. The derived index is built at run
 * time and cached; it is never committed or published, so only identified
 * facts (title, platform) end up in Decompendium's CC0 data.
 */
export const DAT_SOURCES: { file: string; platform: string; hashes: boolean }[] = [
  // Cartridge systems: retail ROM hashes match the hash files repos verify against.
  { file: "metadat/no-intro/Nintendo - Game Boy.dat", platform: "gb", hashes: true },
  { file: "metadat/no-intro/Nintendo - Game Boy Color.dat", platform: "gbc", hashes: true },
  { file: "metadat/no-intro/Nintendo - Game Boy Advance.dat", platform: "gba", hashes: true },
  { file: "metadat/no-intro/Nintendo - Nintendo 64.dat", platform: "n64", hashes: true },
  { file: "metadat/no-intro/Nintendo - Nintendo DS.dat", platform: "nds", hashes: true },
  { file: "metadat/no-intro/Nintendo - Nintendo 3DS.dat", platform: "3ds", hashes: true },
  { file: "metadat/no-intro/Nintendo - Nintendo Entertainment System.dat", platform: "nes", hashes: true },
  { file: "metadat/no-intro/Nintendo - Super Nintendo Entertainment System.dat", platform: "snes", hashes: true },
  { file: "metadat/no-intro/Sega - Mega Drive - Genesis.dat", platform: "genesis", hashes: true },
  // Disc systems: identified by product code (decomp builds hash a file on the disc, not the disc).
  { file: "metadat/redump/Nintendo - GameCube.dat", platform: "gc", hashes: false },
  { file: "metadat/redump/Nintendo - Wii.dat", platform: "wii", hashes: false },
  { file: "metadat/redump/Sony - PlayStation.dat", platform: "ps1", hashes: false },
  { file: "metadat/redump/Sony - PlayStation 2.dat", platform: "ps2", hashes: false },
  { file: "metadat/redump/Sony - PlayStation Portable.dat", platform: "psp", hashes: false },
  { file: "metadat/redump/Sega - Dreamcast.dat", platform: "dc", hashes: false },
  { file: "metadat/redump/Sega - Saturn.dat", platform: "saturn", hashes: false },
  { file: "metadat/redump/Microsoft - Xbox.dat", platform: "xbox", hashes: false },
  { file: "metadat/redump/Microsoft - Xbox 360.dat", platform: "x360", hashes: false },
];

export const DAT_BASE = "https://raw.githubusercontent.com/libretro/libretro-database/master/";

export interface Release {
  title: string; // cleaned: "The Legend of Zelda: The Wind Waker"
  name: string; // as catalogued, with region and language tags
  platform: string;
  region: string | null;
}

export interface GameIndex {
  schema: 1;
  built_at: string;
  codes: Record<string, Release[]>; // "GZLE", "SLUS21668", "NSME"
  hashes: Record<string, Release>; // lowercase sha1 or md5 of a retail ROM
}

export function emptyIndex(): GameIndex {
  return { schema: 1, built_at: new Date(0).toISOString(), codes: {}, hashes: {} };
}

/** Add one catalogue's releases to the index. */
export function addToIndex(index: GameIndex, games: DatGame[], platform: string, withHashes: boolean): void {
  for (const g of games) {
    const release: Release = { title: cleanTitle(g.name), name: g.name, platform, region: g.region };
    for (const serial of g.serials) {
      for (const key of serialKeys(serial)) {
        const list = (index.codes[key] ??= []);
        if (!list.some((r) => r.name === release.name)) list.push(release);
      }
    }
    if (withHashes) {
      for (const rom of g.roms) {
        if (rom.sha1) index.hashes[rom.sha1] = release;
        if (rom.md5) index.hashes[rom.md5] = release;
      }
    }
  }
}

/** Download every catalogue and build the index. */
export async function buildIndex(fetch: typeof globalThis.fetch, log: (line: string) => void = () => {}): Promise<GameIndex> {
  const index = emptyIndex();
  index.built_at = new Date().toISOString();
  for (const source of DAT_SOURCES) {
    const url = DAT_BASE + source.file.split("/").map(encodeURIComponent).join("/");
    const res = await fetch(url, { signal: AbortSignal.timeout(120_000) });
    if (!res.ok) {
      log(`${source.file}: HTTP ${res.status}, skipped`);
      continue;
    }
    const games = parseDat(await res.text());
    addToIndex(index, games, source.platform, source.hashes);
    log(`${source.file}: ${games.length} releases`);
  }
  return index;
}

export function readIndex(path: string): GameIndex | null {
  return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as GameIndex) : null;
}

export function writeIndex(path: string, index: GameIndex): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(index));
}
