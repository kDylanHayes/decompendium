import type { APIContext } from "astro";
import { BADGE_MEASURES, json, type BadgeMeasure } from "../../../../../../../src/site/api.ts";
import { badgeContent, shieldsPayload } from "../../../../../../../src/site/badge.ts";
import type { TargetView } from "../../../../../../../src/site/model.ts";
import { site } from "../../../../../../lib/data.ts";

export function getStaticPaths() {
  return site().projects.flatMap((p) =>
    p.targets.flatMap((t) => BADGE_MEASURES.map((measure) => ({ params: { project: p.id, target: t.id, measure }, props: { target: t } }))),
  );
}

export const GET = ({ params, props }: APIContext<{ target: TargetView }>) =>
  json(shieldsPayload(badgeContent(props.target, params.measure as BadgeMeasure)));
