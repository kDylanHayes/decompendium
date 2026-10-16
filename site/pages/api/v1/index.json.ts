import { apiIndex, json } from "../../../../src/site/api.ts";
import { apiUrls, site } from "../../../lib/data.ts";

export const GET = () => json(apiIndex(site(), apiUrls()));
