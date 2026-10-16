# Decompendium

A public directory of **matching** decompilations: projects whose build
reproduces the original game binary byte for byte. Projects are grouped by
game, so you can see what already exists before starting something new, and
progress comes from each project's own CI output.

The site is live at [decompendium.com](https://decompendium.com).

## Status

| Milestone | State |
| --- | --- |
| M0: policy, schemas, validation | Done |
| M1: ingestion (objdiff and Decompendium progress files) | Done |
| M2: static site | Done |
| M3: API and badges | Done |
| M4: submission flow (issue forms and bot) | Done |
| M5: seed catalog and launch | In progress |

## How listing works

- Read [POLICY.md](POLICY.md): what counts as matching, duplicates, and
  how opting out works.
- Anyone can submit a qualifying project. Maintainers can de-emphasize or
  remove their entry at any time.
- Owners edit their own entry with a PR to `catalog/projects/<id>.yaml`.
  CI checks that only owner-editable fields changed.

To add a project, use the [submission form](https://github.com/kDylanHayes/decompendium/issues/new?template=submit-project.yml).
A bot checks the repo, identifies the game, tries its progress report and
posts a draft catalog entry on the issue within minutes. A catalog maintainer
then comments `/approve`, which opens a PR with that entry; merging it lists
the project. Maintainers can also change or opt out of an entry with the
change and opt-out forms linked from every project page.

## Layout

```
catalog/games/<game>.yaml        one file per game
catalog/projects/<project>.yaml  one file per project, targets inline
schema/                          JSON Schemas for the files above and the progress format
config.yaml                      platforms, allowed hosts, opt-outs, limits
src/                             validation, review, ingestion and the site's data model
site/                            Astro pages, layout and styles
tests/                           tests, fixture catalog (fictional), objdiff report fixtures
```

Ingestion runs every 6 hours and writes to the `data` branch:

```
snapshots/<project>/<target>.jsonl  append-only progress history
reports/<project>/<target>.json     latest full report (off for now; see config.yaml)
health.json                         fetch state, errors and repo activity per target
```

Only successful `push` runs on a repo's default branch are ingested; reports
from pull requests, forks or other branches are ignored.

Example entries are in [tests/fixtures/catalog](tests/fixtures/catalog).

## Finding projects

`pnpm discover` searches GitHub for repositories that look like matching
decomps and aren't listed yet. Nothing is added to the catalog; it produces a
list for a maintainer to review.

1. **Search** (repository and code search). A weekly run adds wide searches
   such as every repo with "decomp" in its name.
2. **Triage, free.** Search results alone rule out listed and opted-out repos,
   repos in `excluded` in `config.yaml`, unstarred forks, empty repos, tools,
   and recomps or ports that never mention decompilation. These decisions are
   remade each run at no cost, so they aren't stored.
3. **Inspect** the rest, most promising first, within a budget of API calls:
   objdiff report artifacts, decomp-toolkit `build.sha1` files, ROM hash files,
   decomp tooling and README wording count for a repo; recomp, port and tool
   wording counts against it. Weak, stale hits are deferred, not ruled out.
4. **Deep check** for anything not clearly settled: read its CI workflows and
   build scripts for a hash comparison or objdiff step.

Every inspected repo goes into a ledger (`discover.json` on the data branch)
as likely, possible (a person should look) or excluded, with the reason.
Decided repos aren't inspected again unless their name, description or topics
change, or they are pushed again after 30 days (likely, possible) or 180 days
(excluded). To stop suggesting a repo for good, add it to `excluded` in
`config.yaml`.

To measure the finder against a list of projects you know are matching (one
GitHub URL per line; the list is only read, never stored):

```sh
GITHUB_TOKEN=$(gh auth token) pnpm discover --ledger /tmp/discover.json --evaluate known-good.txt
```

## API and badges

Everything on the site is also static JSON under
[`/api/v1/`](https://decompendium.com/api/v1/index.json) (CC0): games, projects
with their latest measures, and each target's full history. Every target has
README badges at `/badges/<project>/<target>/<code|linked|functions>.svg` and a
[shields.io endpoint](https://shields.io/badges/endpoint-badge) at
`/api/v1/shields/<project>/<target>/<measure>.json`. Badge colour shows
freshness (blue current, grey stale or no data), not progress.

## Progress format for non-objdiff projects

Projects that don't use objdiff can publish a small JSON file that follows
[schema/progress.schema.json](schema/progress.schema.json):

```json
{
  "schema": "decompendium-progress/1",
  "commit": "4f1c2a9e0b7d3c5a1e2f4b6d8c0a2e4f6b8d0c2a",
  "code": { "matched": 182340, "total": 412992 },
  "functions": { "matched": 610, "total": 1544 }
}
```

`code` and `data` are bytes; `functions` counts whole matching functions.

## Development

Requires Node 24 and pnpm.

```sh
pnpm install
pnpm check        # typecheck, tests, catalog validation
pnpm validate     # catalog validation only

# The site, using a local checkout of the data branch:
git worktree add data origin/data
pnpm build && pnpm preview

# Live ingestion against real repos, into a throwaway directory:
GITHUB_TOKEN=$(gh auth token) pnpm ingest --root tests/fixtures/smoke --data /tmp/smoke-data
```

## License

Code: [MIT](LICENSE). Catalog and generated data: [CC0](LICENSE-DATA.md).
