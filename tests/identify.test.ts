import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { cleanTitle, parseDat, serialKeys } from "../src/identify/dat.ts";
import { codesFromFacts, hexDigests } from "../src/identify/evidence.ts";
import { codeKeys, identify, identifyByIgdb, titleFromDescription, titleFromRepoName } from "../src/identify/identify.ts";
import { addToIndex, emptyIndex } from "../src/identify/index.ts";

// Shaped like libretro-database's No-Intro and Redump DATs.
const N64 = `clrmamepro (
	name "Nintendo - Nintendo 64"
)

game (
	name "Super Mario 64 (USA)"
	region "USA"
	serial "NSME"
	rom ( name "Super Mario 64 (USA).z64" size 8388608 crc 3CE60709 md5 20B854B239203BAF6C961B850A4A51A2 sha1 9BEF1128717F958171A4AFAC3ED78EE2BB4E86CE serial "NSME" )
)

game (
	name "N64 BIOS [BIOS] (Japan)"
	region "Japan"
	rom ( name "bios.bin" size 1 crc 0 md5 00000000000000000000000000000001 sha1 0000000000000000000000000000000000000001 )
)
`;

const GC = `game (
	name "Legend of Zelda, The - The Wind Waker (USA, Canada)"
	region "USA"
	serial "DL-DOL-GZLE-USA"
	rom ( name "x.iso" size 1 crc 0 md5 D8E4D45AF2032A081A0F446384E9261B sha1 6B5F06C10D50EBB4099CDED88217EB71E5BFBB4A serial "DL-DOL-GZLE-USA" )
)

game (
	name "Zelda no Densetsu - Kaze no Takt (Japan)"
	region "Japan"
	serial "DL-DOL-GZLJ-JPN"
	rom ( name "y.iso" size 1 crc 0 md5 00 sha1 00 serial "DL-DOL-GZLJ-JPN" )
)
`;

const PS2 = `game (
	name "George of the Jungle and the Search for the Secret (USA)"
	region "USA"
	serial "SLUS-21668"
	rom ( name "g.iso" size 1 crc 0 md5 C7C5D6DA656E5A41E792D89129FC86F8 sha1 3526F950BB3B8AE00ECD5A11115D1AFD1C0CB6A2 serial "SLUS-21668" )
)
`;

function index() {
  const ix = emptyIndex();
  addToIndex(ix, parseDat(N64), "n64", true);
  addToIndex(ix, parseDat(GC), "gc", false);
  addToIndex(ix, parseDat(PS2), "ps2", false);
  return ix;
}

describe("DAT parsing", () => {
  it("reads names, regions, serials and ROM hashes", () => {
    const [sm64] = parseDat(N64);
    assert.equal(sm64!.name, "Super Mario 64 (USA)");
    assert.equal(sm64!.region, "USA");
    assert.deepEqual(sm64!.serials, ["NSME"]);
    assert.equal(sm64!.roms[0]!.sha1, "9bef1128717f958171a4afac3ed78ee2bb4e86ce");
  });

  it("cleans catalogue titles", () => {
    assert.equal(cleanTitle("Legend of Zelda, The - The Wind Waker (USA, Canada)"), "The Legend of Zelda: The Wind Waker");
    assert.equal(cleanTitle("Pokemon - Crystal Version (USA, Europe) (Rev 1)"), "Pokemon: Crystal Version");
  });

  it("turns serials into lookup keys", () => {
    assert.deepEqual(serialKeys("DL-DOL-GZLE-USA"), ["GZLE"]);
    assert.deepEqual(serialKeys("RVL-RMGE-USA"), ["RMGE"]);
    assert.deepEqual(serialKeys("SLUS-21668"), ["SLUS21668"]);
    assert.deepEqual(serialKeys("AZEP"), ["AZEP"]);
  });

  it("turns repo version codes into lookup keys, ignoring region names", () => {
    assert.deepEqual(codeKeys("GZLE01"), ["GZLE"]);
    assert.deepEqual(codeKeys("GM8E01_00"), ["GM8E"]);
    assert.deepEqual(codeKeys("SLUS_216.68"), ["SLUS21668"]);
    assert.deepEqual(codeKeys("SLPM_86.053"), ["SLPM86053"]);
    assert.deepEqual(codeKeys("A2DE"), ["A2DE"]);
    for (const c of ["us", "jp", "MarioClub_us", "LEGOLAND", "1.0", "PC_20040610"]) assert.deepEqual(codeKeys(c), [], c);
  });
});

describe("identify", () => {
  it("identifies a cartridge game by ROM hash", () => {
    const r = identify({ hashes: ["9BEF1128717F958171A4AFAC3ED78EE2BB4E86CE"], codes: [] }, index());
    assert.equal(r.status, "identified");
    assert.equal(r.title, "Super Mario 64");
    assert.equal(r.platform, "n64");
    assert.equal(r.nonGame, null);
  });

  it("identifies disc games by product code, with other-language titles as aliases", () => {
    const r = identify({ hashes: [], codes: ["GZLE01", "GZLJ01", "us"] }, index());
    assert.equal(r.title, "The Legend of Zelda: The Wind Waker");
    assert.equal(r.platform, "gc");
    assert.deepEqual(r.aliases, ["Zelda no Densetsu: Kaze no Takt"]);
    assert.equal(identify({ hashes: [], codes: ["SLUS_216.68"] }, index()).title, "George of the Jungle and the Search for the Secret");
  });

  it("prefers the English title when only a Japanese release is built", () => {
    const r = identify({ hashes: [], codes: ["GZLJ01"] }, index());
    assert.equal(r.title, "The Legend of Zelda: The Wind Waker");
    assert.deepEqual(r.aliases, ["Zelda no Densetsu: Kaze no Takt"]);
  });

  it("ignores decomp-toolkit's GAMEID placeholder", () => {
    assert.deepEqual(codeKeys("GAMEID"), []);
  });

  it("flags non-games and leaves unknowns unconfirmed", () => {
    assert.match(identify({ hashes: ["0000000000000000000000000000000000000001"], codes: [] }, index()).nonGame!, /BIOS/);
    const unknown = identify({ hashes: ["ab".repeat(20)], codes: ["dds1"] }, index());
    assert.equal(unknown.status, "unconfirmed");
    assert.equal(unknown.title, null);
  });
});

describe("evidence", () => {
  it("collects version codes and digests", () => {
    assert.deepEqual(
      codesFromFacts({ paths: ["config/GZLE01/build.sha1", "configs/USA/checksum.sha", "src/a.c"], reportArtifacts: ["SLUS_216.68_report"] }),
      ["GZLE01", "build", "USA", "checksum", "SLUS_216.68"],
    );
    assert.deepEqual(hexDigests("sm64.us.z64 `sha1: 9BEF1128717F958171A4AFAC3ED78EE2BB4E86CE` and 20b854b239203baf6c961b850a4a51a2"), [
      "9bef1128717f958171a4afac3ed78ee2bb4e86ce",
      "20b854b239203baf6c961b850a4a51a2",
    ]);
  });

  it("guesses a title from a description for the IGDB fallback", () => {
    assert.equal(titleFromDescription("Decompilation of Castlevania: Symphony of the Night (PSX, PSP, Saturn)"), "Castlevania: Symphony of the Night");
    assert.equal(titleFromDescription("A decompilation of Super Smash Bros Melee brought to you by a bunch of clever folks"), "Super Smash Bros Melee");
    assert.equal(titleFromDescription("Matching decomp for Rock Band 3 using dtk"), "Rock Band 3");
    assert.equal(titleFromDescription("Tools and notes"), null);
    assert.equal(titleFromDescription("Clean-room Top Spin 4 decompilation and source reconstruction"), "Top Spin 4");
    assert.equal(titleFromDescription("Dr. Mario 64 decomp"), "Dr. Mario 64");
    assert.equal(titleFromRepoName("topspin4-decomp"), "topspin 4");
    assert.equal(titleFromRepoName("PartnersInTimeDECOMP"), "Partners In Time");
    assert.equal(titleFromRepoName("Turok-Rage-Wars-Decomp"), "Turok Rage Wars");
    assert.equal(titleFromRepoName("mkp"), null);
  });

  it("confirms a game on IGDB only by exact title with a clear platform", async () => {
    const fake = (games: unknown) =>
      (async (url: string | URL | Request) =>
        String(url).includes("twitch")
          ? new Response(JSON.stringify({ access_token: "t", expires_in: 3600 }))
          : new Response(JSON.stringify(games))) as typeof fetch;
    const creds = { clientId: "id", clientSecret: "secret" };
    const rb3 = [{ name: "Rock Band 3", platforms: [{ name: "Wii" }, { name: "Xbox 360" }, { name: "PlayStation 3" }] }];
    const r = (await identifyByIgdb("Rock Band 3", "decomp of rock band 3 wii using dtk", creds, fake(rb3))).id;
    assert.equal(r?.title, "Rock Band 3");
    assert.equal(r?.platform, "wii");
    // Several platforms and none named in the repo: not confirmed, and the note says why.
    const unsure = await identifyByIgdb("Rock Band 3", "matching decomp", creds, fake(rb3));
    assert.equal(unsure.id, null);
    assert.match(unsure.note, /doesn't say which/);
    // A near title is not a match.
    assert.equal((await identifyByIgdb("Rock Band", "wii", creds, fake(rb3))).id, null);
    const alt = [{ name: "Chulip", alternative_names: [{ name: "Chu-Ri-Pu" }], platforms: [{ name: "PlayStation 2" }] }];
    assert.equal((await identifyByIgdb("Chu-Ri-Pu", "", creds, fake(alt))).id?.title, "Chulip");
    const ts4 = [{ name: "Top Spin 4", platforms: [{ name: "Xbox 360" }] }];
    assert.equal((await identifyByIgdb("topspin 4", "", creds, fake(ts4))).id?.title, "Top Spin 4");
  });
});
