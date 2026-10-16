import { PLATFORM_NAMES } from "../site/format.ts";

/** A submission as entered in .github/ISSUE_TEMPLATE/submit-project.yml. */
export interface Submission {
  repo: string;
  game: string;
  platform: string | null; // platform id from config.yaml, or null for "Other or not sure"
  targets: string;
  progress: string;
  report: string;
  aiPolicy: "unspecified" | "allowed" | "discouraged" | "prohibited";
  isGame: boolean;
  verifiesHash: boolean;
  isMaintainer: boolean;
  notes: string;
}

/**
 * GitHub renders issue forms as "### Label" headings followed by the answer,
 * with "_No response_" for empty fields and "- [X]" for ticked boxes.
 */
export function parseIssueForm(body: string): Record<string, string> {
  const fields: Record<string, string> = {};
  const parts = body.replace(/\r\n/g, "\n").split(/^### /m).slice(1);
  for (const part of parts) {
    const newline = part.indexOf("\n");
    const label = (newline < 0 ? part : part.slice(0, newline)).trim();
    const value = newline < 0 ? "" : part.slice(newline + 1).trim();
    fields[label] = value === "_No response_" ? "" : value;
  }
  return fields;
}

const ticked = (checks: string, text: RegExp) =>
  checks.split("\n").some((line) => /^- \[[xX]\]/.test(line.trim()) && text.test(line));

export function readSubmission(body: string): Submission {
  const f = parseIssueForm(body);
  const platformName = f["Platform"] ?? "";
  const platform = Object.entries(PLATFORM_NAMES).find(([, name]) => name === platformName)?.[0] ?? null;
  const ai = (f["AI-assisted contributions"] ?? "").toLowerCase();
  const checks = f["Checks"] ?? "";
  return {
    repo: (f["Repository URL"] ?? "").trim(),
    game: (f["Game"] ?? "").trim(),
    platform: platform === "other" ? null : platform,
    targets: f["Versions it builds"] ?? "",
    progress: f["Progress data"] ?? "",
    report: (f["Report location"] ?? "").trim(),
    aiPolicy: ai === "allowed" || ai === "discouraged" || ai === "prohibited" ? ai : "unspecified",
    isGame: ticked(checks, /It's a game/i),
    verifiesHash: ticked(checks, /checks its output against a hash/i),
    isMaintainer: ticked(checks, /I'm a maintainer/i),
    notes: f["Notes"] ?? "",
  };
}
