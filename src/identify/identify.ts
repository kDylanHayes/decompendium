import type { GameIndex, Release } from "./index.ts";

/**
 * Work out which game a repo builds (spec section 8.6), from evidence that
 * doesn't depend on how the repo is named:
 *   1. ROM hashes the repo verifies against, matched to retail dumps;
 *   2. product codes in config folders and report names (GZLE01, SLUS_216.68);
 *   3. optionally, an IGDB title search from the description.
 * Not finding a match never rules a repo out; it just leaves the game unconfirmed.
 */
export interface Evidence {
  hashes: string[]; // hex digests the repo verifies against
  codes: string[]; // raw version codes: config dir names, report artifact prefixes, submission input
  description?: string;
}

export interface Identification {
  status: "identified" | "unconfirmed";
  title: string | null; // the game, e.g. "Super Mario 64"
  platform: string | null;
  releases: (Release & { via: string; match: { kind: "hash" | "code"; value: string } })[]; // each matched release and what matched it
  nonGame: string | null; // set when the match is not a game (BIOS, cheat disc, SDK)
  aliases: string[]; // other titles the releases go by (other regions and languages)
}

// Catalogue entries that aren't games.
const NOT_A_GAME = /\[BIOS\]|\bBIOS\b|System Menu|Action Replay|\bDatel\b|\bSDK\b|Development Kit|Utility Disc|\(Program\)/i;

/** Lookup keys for a repo's version code: GZLE01 → GZLE, GM8E01_00 → GM8E, SLUS_216.68 → SLUS21668. */
export function codeKeys(code: string): string[] {
  // PlayStation: 4 letters and 5 digits, written SLUS-21668, SLUS_216.68 or SLPM_86.053.
  const ps = /^([A-Z]{4})[-_ ]?(\d)(\d)\.?(\d)\.?(\d)(\d)$/.exec(code);
  if (ps) return [`${ps[1]}${ps.slice(2).join("")}`];
  // Nintendo product codes are upper case: 4 characters, then an optional maker code and suffixes.
  if (code === "GAMEID") return []; // decomp-toolkit's template placeholder
  const nin = /^([A-Z0-9]{4})([A-Z0-9]{2})?(_.*)?$/.exec(code);
  if (nin && /[A-Z]/.test(nin[1]!)) return [nin[1]!];
  return [];
}

/** Region tags dropped when comparing titles across releases. */
const strip = (t: string) => t.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

export function identify(e: Evidence, index: GameIndex): Identification {
  const releases: Identification["releases"] = [];
  const seen = new Set<string>();
  const add = (r: Release, match: { kind: "hash" | "code"; value: string }) => {
    if (seen.has(r.name)) return;
    seen.add(r.name);
    releases.push({ ...r, via: match.kind === "hash" ? `hash ${match.value.slice(0, 12)}…` : `code ${match.value}`, match });
  };
  for (const h of e.hashes) {
    const r = index.hashes[h.toLowerCase()];
    if (r) add(r, { kind: "hash", value: h.toLowerCase() });
  }
  for (const code of e.codes) {
    for (const key of codeKeys(code)) for (const r of index.codes[key] ?? []) add(r, { kind: "code", value: code });
  }
  if (!releases.length) {
    return { status: "unconfirmed", title: null, platform: null, releases: [], nonGame: null, aliases: [] };
  }

  // The game is the most common title among matched releases; prefer hash matches on ties.
  const tally = new Map<string, { title: string; platform: string; n: number; hash: boolean }>();
  for (const r of releases) {
    const k = `${r.platform}:${strip(r.title)}`;
    const t = tally.get(k) ?? { title: r.title, platform: r.platform, n: 0, hash: false };
    t.n++;
    t.hash ||= r.via.startsWith("hash");
    tally.set(k, t);
  }
  const best = [...tally.values()].sort((a, b) => b.n - a.n || Number(b.hash) - Number(a.hash))[0]!;
  const nonGame = releases.find((r) => NOT_A_GAME.test(r.name))?.name ?? null;
  let title = best.title;
  const english = (r: Release) => /\b(USA|Europe|World|UK|Australia)\b/.test(r.region ?? "") || /\((USA|Europe|World)/.test(r.name);
  if (!releases.some(english)) {
    for (const r of releases.filter((x) => x.match.kind === "code")) {
      const key = codeKeys(r.match.value)[0];
      if (!key || key.length !== 4) continue;
      const sibling = ["E", "P"].map((c) => index.codes[key.slice(0, 3) + c]?.find((x) => x.platform === best.platform && english(x))).find(Boolean);
      if (sibling) {
        title = sibling.title;
        break;
      }
    }
  }
  const aliases = [...new Set(releases.map((r) => r.title))].filter((t) => strip(t) !== strip(title));
  return { status: "identified", title, platform: best.platform, releases, nonGame, aliases };
}

/** A title guess from a description like "Decompilation of Rock Band 3 (Wii)". */
export function titleFromDescription(description: string): string | null {
  const m = /(?:decompilation|disassembly|decomp|reconstruction)(?:\s+project)?\s+(?:of|for)\s+(?:the\s+)?(.+?)(?:\s*[([,;]|\.(?:\s|$)|\s+(?:for|on|using|by|brought)\b|$)/i.exec(description);
  if (m) return m[1]!.trim();
  // "Clean-room Top Spin 4 decompilation and ...", "Dr. Mario 64 decomp"
  const before = /^(?:an?\s+|the\s+)?(?:(?:matching|byte-matching|clean-room|wip|work-in-progress|open-source|unofficial|full)\s+)*(.+?)\s+(?:decompilation|decomp|disassembly)\b/i.exec(description);
  const t = before?.[1]?.trim();
  return t && t.split(/\s+/).length <= 8 ? t : null;
}

/**
 * A title guess from a repo name, for the IGDB search: "topspin4-decomp" → "topspin 4",
 * "PartnersInTimeDECOMP" → "Partners In Time". Null when too little is left.
 */
export function titleFromRepoName(name: string): string | null {
  const t = name
    .replace(/[-_. ]?(matching[-_ ]?)?(decomp(ilation)?|disasm|disassembly|reverse|re)([-_ ]?project)?$/i, "")
    .replace(/^(decomp(ilation)?|disasm)[-_ ]/i, "")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/([A-Za-z])(\d)/g, "$1 $2")
    .replace(/[-_.]+/g, " ")
    .trim();
  return t.replace(/[^a-z]/gi, "").length >= 4 ? t : null;
}

// IGDB platform names to Decompendium platform ids.
const IGDB_PLATFORMS: Record<string, string> = {
  "Nintendo GameCube": "gc", Wii: "wii", "Wii U": "wiiu", "Nintendo 64": "n64", "Game Boy": "gb", "Game Boy Color": "gbc",
  "Game Boy Advance": "gba", "Nintendo DS": "nds", "Nintendo 3DS": "3ds", "Nintendo Switch": "switch",
  "Nintendo Entertainment System": "nes", "Super Nintendo Entertainment System": "snes", PlayStation: "ps1",
  "PlayStation 2": "ps2", "PlayStation 3": "ps3", "PlayStation Portable": "psp", Xbox: "xbox", "Xbox 360": "x360",
  "PC (Microsoft Windows)": "win32", DOS: "dos", Dreamcast: "dc", "Sega Saturn": "saturn", "Sega Mega Drive/Genesis": "genesis",
};

export interface IgdbCreds {
  clientId: string;
  clientSecret: string;
}

/** Credentials from IGDB_CLIENT_ID and IGDB_CLIENT_SECRET, if both are set. */
export function igdbCredsFromEnv(env: NodeJS.ProcessEnv = process.env): IgdbCreds | null {
  // Trimmed: secrets pasted from the clipboard can carry a trailing newline.
  const clientId = env.IGDB_CLIENT_ID?.trim();
  const clientSecret = env.IGDB_CLIENT_SECRET?.trim();
  return clientId && clientSecret ? { clientId, clientSecret } : null;
}

let igdbToken: { value: string; expires: number } | null = null;

/**
 * Search IGDB for games by title: its fuzzy search (top 20), or with `exact`, a
 * case-insensitive name match. Returns candidates with their platforms and other names.
 */
export async function igdbSearch(
  title: string,
  creds: IgdbCreds,
  fetch: typeof globalThis.fetch = globalThis.fetch,
  exact = false,
): Promise<{ name: string; platforms: string[]; alt: string[] }[]> {
  if (!igdbToken || igdbToken.expires < Date.now() + 60_000) {
    const res = await fetch(
      `https://id.twitch.tv/oauth2/token?${new URLSearchParams({ client_id: creds.clientId, client_secret: creds.clientSecret, grant_type: "client_credentials" })}`,
      { method: "POST" },
    );
    if (!res.ok) {
      // Twitch says why (e.g. "invalid client secret"); it never echoes the credentials.
      const why = ((await res.json().catch(() => ({}))) as { message?: string }).message;
      throw new Error(`IGDB auth failed: HTTP ${res.status}${why ? ` (${why})` : ""}`);
    }
    const t = (await res.json()) as { access_token: string; expires_in: number };
    igdbToken = { value: t.access_token, expires: Date.now() + t.expires_in * 1000 };
  }
  const res = await fetch("https://api.igdb.com/v4/games", {
    method: "POST",
    headers: { "Client-ID": creds.clientId, Authorization: `Bearer ${igdbToken.value}`, Accept: "application/json" },
    body: exact
      ? `fields name,alternative_names.name,platforms.name; where name ~ "${title.replace(/["\\]/g, "")}"; limit 20;`
      : `search "${title.replace(/["\\]/g, "")}"; fields name,alternative_names.name,platforms.name; limit 20;`,
  });
  if (!res.ok) throw new Error(`IGDB search failed: HTTP ${res.status}`);
  const games = (await res.json()) as { name: string; platforms?: { name: string }[]; alternative_names?: { name: string }[] }[];
  return games.map((g) => ({ name: g.name, platforms: (g.platforms ?? []).map((p) => p.name), alt: (g.alternative_names ?? []).map((a) => a.name) }));
}

/**
 * Confirm a game by IGDB title search: only an exact title match (ignoring case
 * and punctuation) whose platform is clear from the repo or IGDB counts.
 */
export async function identifyByIgdb(
  title: string,
  hint: string, // repo name, description and README start, for platform words
  creds: IgdbCreds,
  fetch: typeof globalThis.fetch = globalThis.fetch,
): Promise<{ id: Identification | null; note: string }> {
  // Spaces don't count: "topspin 4" matches "Top Spin 4".
  const tight = (t: string) => strip(t).replace(/ /g, "");
  const key = tight(title);
  const isMatch = (g: { name: string; alt: string[] }) => tight(g.name) === key || g.alt.some((a) => tight(a) === key);
  let results = await igdbSearch(title, creds, fetch);
  let match = results.find(isMatch);
  if (!match) {
    // The fuzzy search can rank an exact title below longer ones ("Summoners War" above "Summoner").
    const exact = await igdbSearch(title, creds, fetch, true);
    match = exact.find(isMatch);
    if (!match) results = [...results, ...exact];
  }
  if (!match) {
    const seen = [...new Set(results.map((g) => g.name))].slice(0, 5);
    return { id: null, note: `no IGDB title matches "${title}"${seen.length ? ` (closest: ${seen.join(", ")})` : ""}` };
  }
  const platforms = [...new Set(match.platforms.map((p) => IGDB_PLATFORMS[p]).filter((p): p is string => !!p))];
  const mentioned = platforms.filter((p) => new RegExp(`\\b(${platformWords(p).join("|")})\\b`, "i").test(hint));
  const platform = platforms.length === 1 ? platforms[0]! : mentioned.length === 1 ? mentioned[0]! : null;
  if (!platform) {
    return { id: null, note: `IGDB has "${match.name}" on ${match.platforms.join(", ") || "no listed platform"}, and the repo doesn't say which` };
  }
  return {
    id: { status: "identified", title: match.name, platform, releases: [], nonGame: null, aliases: tight(match.name) === key ? [] : [title] },
    note: `IGDB: "${match.name}"`,
  };
}

function platformWords(p: string): string[] {
  const words: Record<string, string[]> = {
    gc: ["gamecube", "gcn", "ngc", "gc"], wii: ["wii"], wiiu: ["wii u", "wiiu"], n64: ["n64", "nintendo 64"],
    gb: ["game boy", "gb"], gbc: ["game boy color", "gbc"], gba: ["game boy advance", "gba"], nds: ["nintendo ds", "nds", "ds"],
    "3ds": ["3ds"], switch: ["switch", "nx"], nes: ["nes", "famicom"], snes: ["snes", "super famicom"],
    ps1: ["ps1", "psx", "playstation"], ps2: ["ps2", "playstation 2"], ps3: ["ps3", "playstation 3"], psp: ["psp"],
    xbox: ["xbox"], x360: ["xbox 360", "x360"], win32: ["pc", "windows", "win32", "steam"], dos: ["dos", "ms-dos"],
    dc: ["dreamcast"], saturn: ["saturn"], genesis: ["genesis", "mega drive"],
  };
  return (words[p] ?? [p]).map((w) => w.replace(/ /g, "\\s"));
}
