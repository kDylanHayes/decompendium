import { defineConfig } from "astro/config";

// Served at the root of https://decompendium.com. SITE_URL and SITE_BASE can
// override this, e.g. to preview a build under a subpath.
export default defineConfig({
  site: process.env.SITE_URL ?? "https://decompendium.com",
  base: process.env.SITE_BASE ?? "/",
  trailingSlash: "always",
  srcDir: "./site",
  publicDir: "./site/public",
  outDir: "./dist",
  build: { format: "directory" },
});
