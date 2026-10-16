import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { acronyms, namesGame } from "../src/submit/copycheck.ts";

describe("copy check: does the repo name its game?", () => {
  it("accepts names, short forms, aliases and codes", () => {
    const cases: [string, string, string[], string[]?][] = [
      ["tp", "", ["The Legend of Zelda: Twilight Princess"]],
      ["mkw", "", ["Mario Kart Wii"]],
      ["mvc2-ps2-decomp", "", ["Marvel vs. Capcom 2: New Age of Heroes"]],
      ["NCONR3decomp", "", ["Naruto Shippuden: Clash of Ninja Revolution III: European Version"]],
      ["TFP2", "", ["Tokyo Friend Park II: Ketteiban"]],
      ["ttyd_dtk", "", ["Paper Mario: The Thousand-Year Door"]],
      ["hm-gc-decomp", "", ["Disney's The Haunted Mansion"]],
      ["SDWiiDecomp", "", ["Spider-Man: Shattered Dimensions"]],
      ["mssbDecomp", "", ["Mario Superstar Baseball"]],
      ["tssm", "", ["Nickelodeon The SpongeBob SquarePants Movie"]],
      ["1080-decomp", "", ["1080 Snowboarding"]],
      ["OdysseyDecomp", "", ["Super Mario Odyssey"]],
      ["af", "Decompilation of Animal Forest", ["Doubutsu no Mori", "Animal Forest"]],
      ["slpm86183", "", ["Pop'n Music"], ["SLPM_861.83"]],
      ["unending-occlusion", "Decompilation of Eternal Darkness", ["Eternal Darkness: Sanity's Requiem"]],
    ];
    for (const [name, desc, games, codes] of cases) assert.ok(namesGame(name, desc, games, codes), name);
  });

  it("flags a template carrying another game's hashes", () => {
    assert.equal(namesGame("cooking-mama-decomp", "Decompilation of Cooking Mama", ["Pokemon Rumble Blast"]), false);
    assert.equal(namesGame("farm-frenzy-decomp", "Decompilation of Farm Frenzy", ["F-Zero: GP Legend"]), false);
    assert.equal(namesGame("spyro-shadow-legacy-decomp", "", ["Super Street Fighter IV: 3D Edition"]), false);
  });

  it("builds short forms from titles", () => {
    const a = acronyms("Tokyo Friend Park II");
    assert.ok(a.has("tfp2"));
    assert.ok(acronyms("Mario Kart 64").has("mk64"));
  });
});
