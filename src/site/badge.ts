import type { BadgeMeasure } from "./api.ts";
import { percent, type TargetView } from "./model.ts";

export interface BadgeContent {
  label: string;
  message: string;
  current: boolean; // fresh data: colored; stale, failing or no data: grey
}

const LABELS: Record<BadgeMeasure, string> = { code: "matching", linked: "linked", functions: "functions" };

/** What a target's badge says for one measure (spec section 7.2). */
export function badgeContent(t: TargetView, measure: BadgeMeasure): BadgeContent {
  const label = LABELS[measure];
  const latest = t.latest;
  const count = latest ? (measure === "code" ? latest.code : measure === "linked" ? latest.linked : latest.functions) : null;
  if (!latest || !count || count.total === 0) return { label, message: "no data", current: false };
  const message =
    measure === "functions"
      ? `${count.matched.toLocaleString("en-US")} / ${count.total.toLocaleString("en-US")}`
      : percent(count)!;
  // Colour shows freshness, not progress: comparing projects by colour is what we avoid.
  return { label, message, current: t.state === "current" };
}

/** shields.io endpoint payload: https://shields.io/badges/endpoint-badge */
export function shieldsPayload(c: BadgeContent) {
  return { schemaVersion: 1, label: c.label, message: c.message, color: c.current ? "blue" : "lightgrey" };
}

const BLUE = "#007ec6";
const GREY = "#9f9f9f";

// Approximate Verdana 11px advance widths, as badge renderers use.
function textWidth(text: string): number {
  let w = 0;
  for (const ch of text) {
    if ("iIl.,:;|!'".includes(ch)) w += 3.6;
    else if ("fjrt()[]/ ".includes(ch)) w += 4.6;
    else if ("mwMW%".includes(ch)) w += 10.4;
    else if (/[0-9]/.test(ch)) w += 7;
    else if (/[A-Z]/.test(ch)) w += 7.6;
    else w += 6.6;
  }
  return Math.round(w);
}

const escape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** A flat SVG badge in the familiar shields style. */
export function badgeSvg(c: BadgeContent): string {
  const lw = textWidth(c.label) + 12;
  const mw = textWidth(c.message) + 12;
  const w = lw + mw;
  const color = c.current ? BLUE : GREY;
  const label = escape(c.label);
  const message = escape(c.message);
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="20" role="img" aria-label="${label}: ${message}">` +
    `<title>${label}: ${message}</title>` +
    `<linearGradient id="s" x2="0" y2="100%"><stop offset="0" stop-color="#bbb" stop-opacity=".1"/><stop offset="1" stop-opacity=".1"/></linearGradient>` +
    `<clipPath id="r"><rect width="${w}" height="20" rx="3" fill="#fff"/></clipPath>` +
    `<g clip-path="url(#r)"><rect width="${lw}" height="20" fill="#555"/><rect x="${lw}" width="${mw}" height="20" fill="${color}"/><rect width="${w}" height="20" fill="url(#s)"/></g>` +
    `<g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" font-size="11">` +
    `<text x="${lw / 2}" y="15" fill="#010101" fill-opacity=".3">${label}</text><text x="${lw / 2}" y="14">${label}</text>` +
    `<text x="${lw + mw / 2}" y="15" fill="#010101" fill-opacity=".3">${message}</text><text x="${lw + mw / 2}" y="14">${message}</text>` +
    `</g></svg>\n`
  );
}
