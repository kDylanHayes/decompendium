import type { APIContext } from "astro";
import { DataStore } from "../../../../../../src/ingest/store.ts";
import { apiCount, json } from "../../../../../../src/site/api.ts";
import { site } from "../../../../../lib/data.ts";

export function getStaticPaths() {
  return site().projects.flatMap((p) => p.targets.map((t) => ({ params: { project: p.id, target: t.id } })));
}

export const GET = ({ params }: APIContext) => {
  const snapshots = new DataStore(site().dataDir).readSnapshots(params.project!, params.target!);
  return json({
    generated_at: site().builtAt,
    project: params.project,
    target: params.target,
    // Oldest first. Each line is one change in commit or measures.
    snapshots: snapshots.map((s) => ({
      taken_at: s.taken_at,
      commit: s.commit,
      commit_at: s.commit_at,
      code: apiCount(s.code),
      linked: apiCount(s.linked),
      functions: apiCount(s.functions),
      data: apiCount(s.data),
      fuzzy_percent: s.fuzzy_percent,
    })),
  });
};
