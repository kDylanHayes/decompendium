# Decompendium listing policy

Decompendium lists **matching** decompilations: projects whose build reproduces
the original binary byte for byte. Anyone can submit a project. Maintainers can
opt out at any time.

## 1. What counts as matching

A target qualifies when all of these hold:

1. The repository's documented build produces a binary for that target.
2. The build compares its output against a published hash (SHA-1, MD5 or
   stronger) of the original binary, and fails or warns visibly on mismatch.
3. The project's stated goal is a byte-identical rebuild. Undecompiled code may
   remain as assembly or binary blobs.
4. The repository does not contain copyrighted game assets or the original
   binary. Extracting them from a user-supplied copy at build time is fine.

A project is listed if at least one of its targets qualifies, and only
qualifying targets are listed.

Not listed: recompilations (static or dynamic), ports, PC ports built on a
decomp, functionally equivalent but non-matching decompilations, and projects
that only publish documentation or symbol maps.

## 2. Listing and opt-out

Anyone can submit a qualifying project; maintainer agreement is not required.
Maintainers keep full control over their entry.

- **Notification.** The approval PR mentions the repo's maintainers once, by
  GitHub username. Decompendium never opens issues or PRs on a listed
  project's repo.
- **Confirmed marker.** Entries start with `confirmed: false`. When a
  maintainer submits, edits or confirms the entry, it becomes `true` and the
  project page shows "Maintainer confirmed". Unconfirmed entries are listed
  normally.
- **One-click opt-out.** Every project page links to a prefilled opt-out issue
  form. A maintainer can choose de-emphasis (`show_in_index: false`) or full
  removal.
- **Earlier objections count.** If a maintainer has said publicly that they do
  not want the project tracked, the submission is declined as `opted-out`.

A maintainer is anyone with push access to the repository, or an organization
member who identifies themselves and is confirmed by a catalog maintainer.
Opt-out requests from anyone else are passed to the maintainers.

**Removal** is carried out within 48 hours, without discussion. It deletes the
catalog entry, the published pages and the stored snapshots. The repo URL is
then added to `opted_out` in `config.yaml`, so only a maintainer can bring it
back.

## 3. Forks and duplicates

A fork or second project for the same game and target is listed only if:

- it targets a version, region or platform no listed project covers, or
- the existing project for that target is archived or has had no commits for
  12 months, or
- it uses a materially different toolchain or approach that the existing
  maintainers acknowledge as separate.

Otherwise the submission is closed as `duplicate` with a pointer to the
existing project.

## 4. Neutral ordering

No default view sorts by progress. The home directory sorts by recent
activity; game pages list projects oldest first; search sorts by relevance.

## 5. Maintainer-set labels

| Field | Values |
| --- | --- |
| `ai_policy` | `unspecified` (default), `allowed`, `discouraged`, `prohibited` |
| `status` | `active` (default), `complete`, `archived` |
| `show_in_index` | `true` (default) or `false` |

"Quiet" (no commits for 180 days) is computed, never set by hand. AI policy
labels are maintainer statements; Decompendium does not verify them.

Every listed project appears on its game page, in search, on its own page and
in the API, whatever `show_in_index` says. `show_in_index: false` only removes
it from the home directory.
