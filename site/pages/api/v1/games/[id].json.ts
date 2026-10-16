import type { APIContext } from "astro";
import { apiGameSummary, apiProject, json } from "../../../../../src/site/api.ts";
import type { GameView } from "../../../../../src/site/model.ts";
import { apiUrls, site } from "../../../../lib/data.ts";

export function getStaticPaths() {
  return site().games.map((game) => ({ params: { id: game.id }, props: { game } }));
}

export const GET = ({ props }: APIContext<{ game: GameView }>) => {
  const urls = apiUrls();
  const { game } = props;
  // Listing order, oldest first, as on the game page.
  return json({ generated_at: site().builtAt, game: apiGameSummary(game, urls), projects: game.projects.map((p) => apiProject(p, urls)) });
};
