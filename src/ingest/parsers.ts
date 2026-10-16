import { readFileSync } from "node:fs";
import protobuf from "protobufjs";
import type { Count } from "../catalog.ts";
import { repoFile } from "../paths.ts";
import { progressErrors } from "../validate.ts";
import { IngestError, type Category, type Measures, type Parsed } from "./types.ts";

/** Newest objdiff report version understood here (objdiff-core REPORT_VERSION). */
export const OBJDIFF_REPORT_VERSION = 2;

const reportType = protobuf
  // keepCase: field names stay snake_case, matching objdiff's JSON output.
  .parse(readFileSync(repoFile("src/ingest/objdiff/report.proto"), "utf8"), { keepCase: true })
  .root.lookupType("objdiff.report.Report");

/** A non-negative integer from a JSON number or a protobuf-JSON uint64 string. */
function int(value: unknown, where: string): number {
  if (value === undefined || value === null) return 0; // proto3 JSON omits zero values
  const n = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
  if (typeof n !== "number" || !Number.isSafeInteger(n) || n < 0) {
    throw new IngestError(`${where}: expected a non-negative integer, got ${JSON.stringify(value)}`);
  }
  return n;
}

// Truncate rather than round so 99.99997 never displays as 100.
function percent(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? Math.floor(value * 1000) / 1000 : null;
}

function count(matched: unknown, total: unknown, where: string): Count {
  return { matched: int(matched, `${where}.matched`), total: int(total, `${where}.total`) };
}

/** Measures from an objdiff `Measures` message (version 1 or later). */
function objdiffMeasures(m: any, where: string, hasLinked: boolean): Measures {
  if (typeof m !== "object" || m === null) throw new IngestError(`${where}: missing measures`);
  return {
    code: count(m.matched_code, m.total_code, `${where}.code`),
    functions: count(m.matched_functions, m.total_functions, `${where}.functions`),
    data: count(m.matched_data, m.total_data, `${where}.data`),
    linked: hasLinked ? count(m.complete_code, m.total_code, `${where}.linked`) : null,
    fuzzy_percent: percent(m.fuzzy_match_percent),
  };
}

/**
 * Linked code for reports that predate `complete_code` (legacy and version 0):
 * the code size of units marked complete. Null when no unit says either way.
 */
function linkedFromUnits(units: any[], total: number, legacy: boolean): Count | null {
  let known = false;
  let matched = 0;
  for (const [i, unit] of units.entries()) {
    const complete = legacy ? unit?.complete : unit?.metadata?.complete;
    if (typeof complete !== "boolean") continue;
    known = true;
    if (complete) matched += int(legacy ? unit.total_code : unit.measures?.total_code, `/units/${i}/total_code`);
  }
  return known ? { matched, total } : null;
}

/**
 * Parse an objdiff report: JSON (any version, including the pre-`measures`
 * legacy format) or binary protobuf. Mirrors objdiff-core's Report::parse.
 */
export function parseObjdiff(bytes: Uint8Array): Parsed {
  if (bytes.length === 0) throw new IngestError("empty report");
  const isJson = bytes[0] === 0x7b; // '{', as objdiff decides
  let report: any;
  try {
    report = isJson
      ? JSON.parse(new TextDecoder().decode(bytes))
      : reportType.toObject(reportType.decode(bytes), { longs: String, defaults: true, arrays: true });
  } catch (err) {
    throw new IngestError(`not a valid objdiff report: ${(err as Error).message}`);
  }
  if (typeof report !== "object" || report === null || Array.isArray(report)) {
    throw new IngestError("not a valid objdiff report: expected an object");
  }
  const format = isJson ? "json" : "protobuf";
  const units: any[] = Array.isArray(report.units) ? report.units : [];

  // Legacy JSON: measures at the top level, no version.
  if (!("measures" in report) && "total_code" in report) {
    const measures: Measures = {
      code: count(report.matched_code, report.total_code, "/code"),
      functions: count(report.matched_functions, report.total_functions, "/functions"),
      data: count(report.matched_data, report.total_data, "/data"),
      linked: null,
      fuzzy_percent: percent(report.fuzzy_match_percent),
    };
    measures.linked = linkedFromUnits(units, measures.code.total, true);
    return { measures, categories: [], format };
  }

  // decomp.dev's per-project JSON carries objdiff measures without a version,
  // plus the commit they came from and a report_categories list.
  const decompDev = typeof report.commit === "object" && report.commit !== null && "sha" in report.commit;
  const version = decompDev ? OBJDIFF_REPORT_VERSION : int(report.version, "/version");
  if (version > OBJDIFF_REPORT_VERSION) {
    throw new IngestError(
      `objdiff report version ${version} is newer than supported (${OBJDIFF_REPORT_VERSION}); Decompendium needs an update`,
    );
  }
  const measures = objdiffMeasures(report.measures, "/measures", version >= 1);
  if (version === 0) measures.linked = linkedFromUnits(units, measures.code.total, false);

  const categoryList = Array.isArray(report.categories) ? report.categories : Array.isArray(report.report_categories) ? report.report_categories : null;
  const categories: Category[] =
    version >= 1 && categoryList
      ? categoryList.map((c: any, i: number) => ({
          id: String(c?.id ?? ""),
          name: String(c?.name || c?.id || ""),
          ...objdiffMeasures(c?.measures, `/categories/${i}/measures`, true),
        }))
      : [];
  return {
    measures,
    categories,
    format,
    ...(decompDev && /^[0-9a-f]{7,64}$/.test(String(report.commit.sha)) ? { commit: String(report.commit.sha) } : {}),
    ...(decompDev && typeof report.commit.timestamp === "string" ? { commit_at: report.commit.timestamp } : {}),
  };
}

/** Parse a Decompendium progress file (schema/progress.schema.json). */
export function parseDecompendium(bytes: Uint8Array): Parsed {
  let report: any;
  try {
    report = JSON.parse(new TextDecoder().decode(bytes));
  } catch (err) {
    throw new IngestError(`not valid JSON: ${(err as Error).message}`);
  }
  const errors = progressErrors(report);
  if (errors.length) throw new IngestError(`invalid progress file: ${errors.slice(0, 3).join("; ")}`);
  const measuresOf = (m: any): Measures => ({
    code: m.code,
    functions: m.functions ?? null,
    data: m.data ?? null,
    linked: null,
    fuzzy_percent: null,
  });
  return {
    measures: measuresOf(report),
    categories: (report.categories ?? []).map((c: any) => ({ id: c.id, name: c.name, ...measuresOf(c) })),
    commit: report.commit,
    commit_at: report.commit_at,
    format: "json",
  };
}

/** Problems that make measures unusable: totals of zero, matched above total. */
export function sanityErrors(measures: Measures): string[] {
  const errors: string[] = [];
  if (measures.code.total === 0) errors.push("code total is 0");
  for (const key of ["code", "functions", "data", "linked"] as const) {
    const c = measures[key];
    if (c && c.matched > c.total) errors.push(`${key}: matched (${c.matched}) exceeds total (${c.total})`);
  }
  return errors;
}
