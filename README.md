# Decompendium data

Written by the ingest workflow on `main`; do not edit by hand except to
remove a bad snapshot line (say why in the commit message).

- `snapshots/<project>/<target>.jsonl`: append-only progress history
- `reports/<project>/<target>.json`: latest full report, if 5 MB or less
- `health.json`: fetch state, errors and repo activity per target

Data is dedicated to the public domain under CC0 1.0.
