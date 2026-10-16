import { parseYaml, type Config, type Project } from "./catalog.ts";

/** One changed file in a pull request. Missing text means the file did not exist on that side. */
export interface Change {
  path: string;
  before?: string;
  after?: string;
}

export type Verdict =
  | "maintainer" // author is a catalog maintainer
  | "owner-change" // only owner-editable changes to the author's own projects
  | "needs-review"; // anything else: a catalog maintainer must review

export interface Classification {
  verdict: Verdict;
  notes: string[]; // why the PR needs review, or what the owner changed
  violations: string[]; // changes an owner is not allowed to make; fail the check
}

/** Fields only catalog maintainers may change (POLICY.md, spec section 4.4). */
const MAINTAINER_FIELDS = ["id", "game", "listed_at"] as const;

const PROJECT_PATH = /^catalog\/projects\/([^/]+)\.yaml$/;

/**
 * Decide how much review a pull request needs. Owners may edit or delete their
 * own project files, except the maintainer-only fields; everything else waits
 * for a catalog maintainer.
 */
export function classifyChanges(changes: Change[], author: string, config: Config): Classification {
  const isMaintainer = config.catalog_maintainers.some((m) => m.toLowerCase() === author.toLowerCase());
  if (isMaintainer) return { verdict: "maintainer", notes: [`${author} is a catalog maintainer`], violations: [] };

  const notes: string[] = [];
  const violations: string[] = [];
  let needsReview = changes.length === 0;

  for (const change of changes) {
    const match = PROJECT_PATH.exec(change.path);
    if (!match) {
      needsReview = true;
      notes.push(`${change.path}: only catalog maintainers change files outside catalog/projects/`);
      continue;
    }
    if (change.before === undefined) {
      needsReview = true;
      notes.push(`${change.path}: new project; submissions normally come through the issue form`);
      continue;
    }

    const before = safeParse(change.before) as Partial<Project> | undefined;
    const owners = (before?.owners ?? []).map((o) => o.toLowerCase());
    if (!owners.includes(author.toLowerCase())) {
      needsReview = true;
      notes.push(`${change.path}: ${author} is not listed in this project's owners`);
      continue;
    }

    if (change.after === undefined) {
      notes.push(`${change.path}: owner removed their project (opt-out; always accepted)`);
      continue;
    }

    const after = safeParse(change.after) as Partial<Project> | undefined;
    if (!after) {
      // The validate job reports the YAML error; nothing to compare here.
      needsReview = true;
      continue;
    }
    for (const field of MAINTAINER_FIELDS) {
      if (JSON.stringify(before?.[field]) !== JSON.stringify(after[field])) {
        violations.push(`${change.path}: owners cannot change "${field}"; ask a catalog maintainer in the PR`);
      }
    }
    if (before?.confirmed === true && after.confirmed !== true) {
      violations.push(`${change.path}: "confirmed" cannot be turned off; remove the project instead`);
    }
    notes.push(`${change.path}: owner edit by ${author}`);
  }

  const verdict: Verdict = needsReview || violations.length ? "needs-review" : "owner-change";
  return { verdict, notes, violations };
}

function safeParse(text: string): unknown {
  try {
    return parseYaml(text);
  } catch {
    return undefined;
  }
}
