import { defineConfig } from "astro/config";

// Until decompendium.com points here, the site is served from
// https://kdylanhayes.github.io/decompendium/, so links need a base path.
// The deploy workflow sets SITE_URL and SITE_BASE; local builds default to /.
export default defineConfig({
  site: process.env.SITE_URL ?? "https://decompendium.com",
  base: process.env.SITE_BASE ?? "/",
  trailingSlash: "always",
  srcDir: "./site",
  publicDir: "./site/public",
  outDir: "./dist",
  build: { format: "directory" },
});
