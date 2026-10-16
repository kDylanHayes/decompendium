# objdiff report fixtures

| File | Source |
| --- | --- |
| `v2-melee.json` | Real report from doldecomp/melee CI (default branch, 2026-10-14), units trimmed to 2 |
| `v2-tww.json` | Real report from zeldaret/tww CI (default branch, 2026-10-14), units trimmed to 2 |
| `v2-tww.binpb` | `v2-tww.json` encoded as binary protobuf with the vendored `report.proto` |
| `v1-synthetic.json` | Hand-written, shaped like objdiff 2.x output (version 1, has `complete_code`) |
| `v0-synthetic.json` | Hand-written, version 0 (no `complete_code`; linked comes from unit metadata) |
| `legacy-synthetic.json` | Hand-written, pre-`measures` objdiff 1.x format |

Trimming units does not change the top-level measures, which are what
ingestion reads. When objdiff ships a new report version, add a real report
from it here before raising `OBJDIFF_REPORT_VERSION`.
