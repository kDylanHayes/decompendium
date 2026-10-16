/** One release in a clrmamepro-format DAT (No-Intro, Redump, as mirrored by libretro-database). */
export interface DatGame {
  name: string;
  region: string | null;
  serials: string[];
  roms: { sha1?: string; md5?: string }[];
}

const FIELD = /(\w+)\s+"((?:[^"\\]|\\.)*)"|(\w+)\s+([^\s()"]+)/g;

/** Parse the `game ( ... )` blocks of a clrmamepro DAT. Unknown blocks are skipped. */
export function parseDat(text: string): DatGame[] {
  const games: DatGame[] = [];
  const blocks = text.split(/\n(?=game \()/);
  for (const block of blocks) {
    if (!block.startsWith("game (")) continue;
    const game: DatGame = { name: "", region: null, serials: [], roms: [] };
    for (const line of block.split("\n")) {
      const trimmed = line.trim();
      if (trimmed.startsWith("rom (")) {
        const rom: DatGame["roms"][number] = {};
        for (const m of trimmed.matchAll(FIELD)) {
          const key = m[1] ?? m[3];
          const value = m[2] ?? m[4];
          if (key === "sha1") rom.sha1 = value!.toLowerCase();
          else if (key === "md5") rom.md5 = value!.toLowerCase();
          else if (key === "serial") game.serials.push(value!);
        }
        game.roms.push(rom);
        continue;
      }
      const m = /^(\w+)\s+"((?:[^"\\]|\\.)*)"/.exec(trimmed);
      if (!m) continue;
      if (m[1] === "name") game.name = m[2]!;
      else if (m[1] === "region") game.region = m[2]!;
      else if (m[1] === "serial") game.serials.push(m[2]!);
    }
    if (game.name) {
      game.serials = [...new Set(game.serials)];
      games.push(game);
    }
  }
  return games;
}

/**
 * Readable title from a catalogue name: "Legend of Zelda, The - The Wind Waker
 * (USA, Canada)" becomes "The Legend of Zelda: The Wind Waker".
 */
export function cleanTitle(name: string): string {
  let t = name.replace(/\s*[([][^)\]]*[)\]]/g, "").trim();
  // Catalogues sort "The"/"A" last: "Legend of Zelda, The - X".
  t = t.replace(/^(.+?), (The|A|An)(\b.*)$/, "$2 $1$3");
  return t.replace(/ - /g, ": ").replace(/\s+/g, " ").trim();
}

/** A product code as a lookup key: "DL-DOL-GZLE-USA" → "GZLE", "SLUS-21668" → "SLUS21668". */
export function serialKeys(serial: string): string[] {
  const s = serial.toUpperCase();
  const ps = /\b([A-Z]{4})[-_ ]?(\d)(\d)\.?(\d)\.?(\d)(\d)\b/.exec(s);
  if (ps) return [`${ps[1]}${ps.slice(2).join("")}`];
  // Nintendo serials: DL-DOL-GZLE-USA, RVL-RMGE-USA, NTR-AZEP-EUR, AGB-BPEE-USA, or a bare "AZEP".
  const parts = s.split(/[-_ ,]+/).filter((p) => /^[A-Z0-9]{4}$/.test(p) && !/^(USA|EUR|JPN|KOR|AUS|CHN|ROC|NOE|UKV|FRA|ESP|ITA|HOL|SCN)$/.test(p));
  return [...new Set(parts)];
}
