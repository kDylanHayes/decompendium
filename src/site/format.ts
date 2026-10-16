export const PLATFORM_NAMES: Record<string, string> = {
  n64: "Nintendo 64",
  gc: "GameCube",
  wii: "Wii",
  ps1: "PlayStation",
  ps2: "PlayStation 2",
  psp: "PSP",
  gb: "Game Boy",
  gbc: "Game Boy Color",
  gba: "Game Boy Advance",
  nds: "Nintendo DS",
  "3ds": "Nintendo 3DS",
  wiiu: "Wii U",
  switch: "Nintendo Switch",
  snes: "Super Nintendo",
  nes: "NES",
  genesis: "Genesis / Mega Drive",
  saturn: "Saturn",
  dc: "Dreamcast",
  xbox: "Xbox",
  x360: "Xbox 360",
  ps3: "PlayStation 3",
  dos: "DOS",
  win32: "Windows",
  other: "Other",
};

export const platformName = (id: string): string => PLATFORM_NAMES[id] ?? id;

export const AI_POLICY_LABELS: Record<string, string> = {
  unspecified: "Not stated",
  allowed: "Allowed",
  discouraged: "Discouraged",
  prohibited: "Prohibited",
};

export const STATUS_LABELS: Record<string, string> = {
  active: "Active",
  complete: "Complete",
  archived: "Archived",
};

const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ["year", 365 * 24 * 3600],
  ["month", 30 * 24 * 3600],
  ["week", 7 * 24 * 3600],
  ["day", 24 * 3600],
  ["hour", 3600],
  ["minute", 60],
];
const rtf = new Intl.RelativeTimeFormat("en", { numeric: "auto" });

/** "3 days ago", relative to the build time. */
export function relativeTime(iso: string | null, now: Date): string {
  if (!iso) return "unknown";
  const seconds = (Date.parse(iso) - now.getTime()) / 1000;
  for (const [unit, size] of UNITS) {
    if (Math.abs(seconds) >= size) return rtf.format(Math.round(seconds / size), unit);
  }
  return "just now";
}

/** "15 Oct 2026", in UTC. */
export function shortDate(iso: string | null): string {
  if (!iso) return "unknown";
  return new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
}

/** Exact UTC time for hover titles. */
export function exactTime(iso: string | null): string {
  return iso ? new Date(iso).toISOString().replace("T", " ").replace(/\.\d+Z$/, " UTC") : "";
}

/** 1234567 → "1,234,567". */
export const number = (n: number): string => n.toLocaleString("en-US");

/** Bytes as KB/MB with one decimal. */
export function bytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${n} B`;
}
