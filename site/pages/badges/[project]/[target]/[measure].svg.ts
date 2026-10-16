import type { APIContext } from "astro";
import { BADGE_MEASURES, type BadgeMeasure } from "../../../../../src/site/api.ts";
import { badgeContent, badgeSvg } from "../../../../../src/site/badge.ts";
import type { TargetView } from "../../../../../src/site/model.ts";
import { site } from "../../../../lib/data.ts";

// One badge per target and measure, for every target, so a README never shows a broken image.
export function getStaticPaths() {
  return site().projects.flatMap((p) =>
    p.targets.flatMap((t) => BADGE_MEASURES.map((measure) => ({ params: { project: p.id, target: t.id, measure }, props: { target: t } }))),
  );
}

export const GET = ({ params, props }: APIContext<{ target: TargetView }>) =>
  new Response(badgeSvg(badgeContent(props.target, params.measure as BadgeMeasure)), {
    headers: { "content-type": "image/svg+xml" },
  });
