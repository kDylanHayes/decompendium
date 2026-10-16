// Signs that a repo is a copy of another project rather than its own decomp:
// its name and description don't mention the game its hashes identify (a
// template carried over with someone else's hashes), or its owner created
// many decomp repos at once.

const STOP = new Set(
  (
    "the of and a an for to in on de la le no to wa ga " +
    "decomp decompilation decompiled decompile matching match disasm disassembly reverse engineering re project " +
    "src source code game games version edition ver rev port recomp recompilation " +
    "us usa jp jpn japan eu eur europe pal ntsc kor " +
    "n64 gc gcn ngc gamecube wii wiiu ps1 psx ps2 ps3 psp gba gbc gb nds ds 3ds switch nx pc win32 xbox x360 dos snes nes"
  ).split(" "),
);

const ROMAN: Record<string, string> = { ii: "2", iii: "3", iv: "4", v: "5", vi: "6", vii: "7", viii: "8", ix: "9", x: "10" };

/** Lowercase words: camelCase, letter/digit boundaries and punctuation split. */
export function words(s: string, camel = true): string[] {
  const split = camel ? s.replace(/([a-z])([A-Z])/g, "$1 $2") : s;
  return split
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/([A-Za-z])(\d)|(\d)([A-Za-z])/g, (m, a, b, c, d) => (a ? `${a} ${b}` : `${c} ${d}`))
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/**
 * Short forms of a title: "Mario Kart 64" → mk64, "The Legend of Zelda: Twilight
 * Princess" → tp, "Disney's The Haunted Mansion" → hm, "Tokyo Friend Park II" → tfp2.
 */
export function acronyms(title: string): Set<string> {
  const out = new Set<string>();
  const parts = [title, ...title.split(/:| - | – /)];
  for (const part of parts) {
    for (const camel of [true, false]) {
      const w = words(part, camel).map((x) => ROMAN[x] ?? x);
      const initials = (list: string[]) => list.map((x) => (/^\d+$/.test(x) ? x : x[0])).join("");
      const content = w.filter((x) => !["the", "of", "and", "a", "an", "s"].includes(x));
      out.add(initials(w));
      out.add(initials(content));
      // Trailing words: a brand or series name often leads ("Disney's The Haunted Mansion").
      for (let i = 1; i < content.length - 1; i++) out.add(initials(content.slice(i)));
      for (let i = 1; i < w.length - 1; i++) out.add(initials(w.slice(i))); // "tssm": The SpongeBob SquarePants Movie
    }
  }
  return new Set([...out].filter((a) => a.length >= 2));
}

const PLATFORM_AFFIX = /^(n64|gcn?|ngc|wiiu?|ps[123p]|psx|gb[ac]?|nds|3ds|ds|pc|xbox|x360|snes|nes)|(n64|gcn?|ngc|wiiu?|ps[123p]|psx|gb[ac]?|nds|3ds|ds|pc|xbox|x360|snes|nes)$/;

/**
 * Does the repo's name or description name this game (by a word of its title,
 * an alias, a short form, or a product code)? False means the identified game
 * probably isn't what the repo is about.
 */
export function namesGame(repoName: string, description: string, gameNames: string[], codes: string[] = []): boolean {
  const nameWords = words(repoName)
    .map((w) => ROMAN[w] ?? w)
    .filter((w) => !STOP.has(w));
  const joined = nameWords.join("");
  const bare = joined.replace(PLATFORM_AFFIX, ""); // "sdwii" → "sd"
  const descWords = new Set(words(description));
  const short = new Set(gameNames.flatMap((n) => [...acronyms(n)]));
  for (const n of gameNames) {
    for (const w of words(n)) {
      if (STOP.has(w)) continue;
      // A number alone ("2", "64") says little; a long one ("1080") does.
      if (/^\d+$/.test(w) ? w.length < 3 : w.length < 4) continue;
      if (joined.includes(w) || descWords.has(w)) return true;
    }
  }
  if (nameWords.some((w) => short.has(w)) || short.has(joined) || short.has(bare)) return true;
  for (const a of short) {
    if (a.length >= 3 && joined.startsWith(a)) return true; // "mkw-decomp", "sms2"
    if (a.length >= 4 && joined.includes(a)) return true; // "nconr3" holds "conr3"
    if (a.length >= 3 && isSubsequence(a, joined) && joined.length <= a.length + 1 && joined[0] === a[0]) return true; // "mssb" for msb
  }
  const flat = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  return codes.some((c) => flat(c).length >= 4 && (joined.includes(flat(c)) || flat(description).includes(flat(c))));
}

function isSubsequence(small: string, big: string): boolean {
  let i = 0;
  for (const ch of big) if (ch === small[i]) i++;
  return i === small.length;
}

// The repo describing itself as a port ("... as a native PC program", "This is a
// PC port of"), not a decomp that mentions a separate port or a port as a goal,
// and not one saying what it isn't ("This is NOT a PC port").
const PORT_TEXT =
  /\bas a native (?:pc|windows|linux|mac) (?:program|app|application|executable|game)\b|\b(?:this|it) is an? (?:native |unofficial )?(?:pc|windows|linux|android) port\b|\b(?:this|it) is an? static recomp(?:ilation)?\b/i;

/** The phrase that makes the repo read like a port, or null. */
export function portText(description: string, readme: string): string | null {
  const m = PORT_TEXT.exec(`${description}\n${readme.slice(0, 3000)}`);
  return m ? m[0] : null;
}
