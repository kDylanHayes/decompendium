# Decompendium

A public directory of **matching** decompilations: projects whose build
reproduces the original game binary byte for byte. Projects are grouped by
game, so you can see what already exists before starting something new, and
progress comes from each project's own CI output.

The site is live at [kdylanhayes.github.io/decompendium](https://kdylanhayes.github.io/decompendium/)
and will move to [decompendium.com](https://decompendium.com).

## Status

| Milestone | State |
| --- | --- |
| M0: policy, schemas, validation | Done |
| M1: ingestion (objdiff and Decompendium progress files) | Done |
| M2: static site | Done |
| M3: API and badges | Next |
| M4: submission flow (issue forms and bot) | Planned |
| M5: seed catalog and launch | Planned |

## How listing works

- Read [POLICY.md](POLICY.md): what counts as matching, the fork rule, and
  how opting out works.
- Anyone can submit a qualifying project. Maintainers can de-emphasize or
  remove their entry at any time.
- Owners edit their own entry with a PR to `catalog/projects/<id>.yaml`.
  CI checks that only owner-editable fields changed.

The submission form arrives with M4. Until then, open an issue.

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
