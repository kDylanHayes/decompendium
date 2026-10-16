import { apiGameSummary, json } from "../../../../src/site/api.ts";
import { apiUrls, site } from "../../../lib/data.ts";

export const GET = () => {
  const urls = apiUrls();
  return json({ generated_at: site().builtAt, games: site().games.map((g) => apiGameSummary(g, urls)) });
};
