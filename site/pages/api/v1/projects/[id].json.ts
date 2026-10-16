import type { APIContext } from "astro";
import { apiProject, json } from "../../../../../src/site/api.ts";
import type { ProjectView } from "../../../../../src/site/model.ts";
import { apiUrls, site } from "../../../../lib/data.ts";

export function getStaticPaths() {
  return site().projects.map((project) => ({ params: { id: project.id }, props: { project } }));
}

export const GET = ({ props }: APIContext<{ project: ProjectView }>) =>
  json({ generated_at: site().builtAt, project: apiProject(props.project, apiUrls()) });
