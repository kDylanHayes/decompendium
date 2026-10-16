import { apiProject, byId, json } from "../../../../src/site/api.ts";
import { apiUrls, site } from "../../../lib/data.ts";

export const GET = () => {
  const urls = apiUrls();
  return json({ generated_at: site().builtAt, projects: byId(site().projects).map((p) => apiProject(p, urls)) });
};
