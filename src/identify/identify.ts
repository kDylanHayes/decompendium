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
  releases: (Release & { via: string })[]; // each matched release and what matched it
  nonGame: string | null; // set when the match is not a game (BIOS, cheat disc, SDK)
  aliases: string[]; // other titles the releases go by (other regions and languages)
}

// Catalogue entries that aren't games.
const NOT_A_GAME = /\[BIOS\]|\bBIOS\b|System Menu|Action Replay|\bDatel\b|\bSDK\b|Development Kit|Utility Disc|\(Program\)/i;

/** Lookup keys for a repo's version code: GZLE01 → GZLE, GM8E01_00 → GM8E, SLUS_216.68 → SLUS21668. */
export function codeKeys(code: string): string[] {
  const ps = /^([A-Z]{4})[-_ ]?(\d{3})\.?(\d{2})/.exec(code);
  if (ps) return [`${ps[1]}${ps[2]}${ps[3]}`];
  // Nintendo product codes are upper case: 4 characters, then an optional maker code and suffixes.
  const nin = /^([A-Z0-9]{4})([A-Z0-9]{2})?(_.*)?$/.exec(code);
  if (nin && /[A-Z]/.test(nin[1]!)) return [nin[1]!];
  return [];
}

/** Region tags dropped when comparing titles across releases. */
const strip = (t: string) => t.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

export function identify(e: Evidence, index: GameIndex): Identification {
  const releases: Identification["releases"] = [];
  const seen = new Set<string>();
  const add = (r: Release, via: string) => {
    if (seen.has(r.name)) return;
    seen.add(r.name);
    releases.push({ ...r, via });
  };
  for (const h of e.hashes) {
    const r = index.hashes[h.toLowerCase()];
    if (r) add(r, `hash ${h.slice(0, 12)}…`);
  }
  for (const code of e.codes) {
    for (const key of codeKeys(code)) for (const r of index.codes[key] ?? []) add(r, `code ${code}`);
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
  const aliases = [...new Set(releases.map((r) => r.title))].filter((t) => strip(t) !== strip(best.title));
  return { status: "identified", title: best.title, platform: best.platform, releases, nonGame, aliases };
}

/** A title guess from a description like "Decompilation of Rock Band 3 (Wii)". */
export function titleFromDescription(description: string): string | null {
  const m = /(?:decompilation|disassembly|decomp|reconstruction)(?:\s+project)?\s+(?:of|for)\s+(?:the\s+)?(.+?)(?:\s*[([,;]|\.(?:\s|$)|\s+(?:for|on|using|by|brought)\b|$)/i.exec(description);
  return m ? m[1]!.trim() : null;
}

/**
 * IGDB fallback, used only when Twitch credentials are configured
 * (IGDB_CLIENT_ID, IGDB_CLIENT_SECRET). Returns the best-matching game name.
 */
export async function igdbSearch(
  title: string,
  creds: { clientId: string; clientSecret: string },
  fetch: typeof globalThis.fetch = globalThis.fetch,
): Promise<{ name: string; platforms: string[] } | null> {
  const tokenRes = await fetch(
    `https://id.twitch.tv/oauth2/token?${new URLSearchParams({ client_id: creds.clientId, client_secret: creds.clientSecret, grant_type: "client_credentials" })}`,
    { method: "POST" },
  );
  if (!tokenRes.ok) return null;
  const { access_token } = (await tokenRes.json()) as { access_token: string };
  const res = await fetch("https://api.igdb.com/v4/games", {
    method: "POST",
    headers: { "Client-ID": creds.clientId, Authorization: `Bearer ${access_token}`, Accept: "application/json" },
    body: `search "${title.replace(/["\\]/g, "")}"; fields name,platforms.name; limit 1;`,
  });
  if (!res.ok) return null;
  const [game] = (await res.json()) as { name: string; platforms?: { name: string }[] }[];
  return game ? { name: game.name, platforms: (game.platforms ?? []).map((p) => p.name) } : null;
}
