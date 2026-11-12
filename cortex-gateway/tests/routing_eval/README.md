# Routing evaluation set (cross-domain discovery design 2026-11-09 §4.1, evaluation gate)

Offline (no network) evaluation of the gateway classifier: which content domains a question should search, and in
which mode. Run: `node tests/routing_eval/evaluate.js [--fails] [--gate]` from `cortex-gateway/`.

## Files
- `hand_cases.js` — hand-labelled questions (canonical Q1–Q4, P3-x, W-1, S2-78, design D1/D2, phrasing variants).
- `topics.json` — topics used by templated cases.
- `coverage_snapshot.json` — which domains the owner can see content on per topic, from the product coverage check
  (`ExpertTools.domain_coverage`): `ENABLE_DOCUMENT_DOMAIN=true .venv/bin/python scripts/generate_routing_coverage_snapshot.py`.
- `build_eval_set.js` → `routing_eval_set.json` (generated; commit it). Rebuild after the catalog or snapshot changes.
- `evaluate.js` — metrics: per-domain precision/recall of "this domain is searched", exact (domains + mode), mode
  confusion matrix; `--gate` fails below the thresholds.

## Labelling rules
| Rule | When | Label |
|---|---|---|
| G1 | explicit scope word ("episodes", "podcast(s)", "my documents", "career", "her thought leadership") | that domain, single |
| G2 | container phrase with a title ("the BERT paper", "the Apache Iceberg page", "in the KuzuDB episode") | that title's domain |
| G3 | a source title on its own | the title's domain |
| G4 | a named person + own-work words | career (another scope word too → cross) |
| G5 | a topic only, broad wording | every domain with content on it (snapshot): none → discovery, one → single, several → cross |
| G6 | influence / trace / relation wording | bridge (today's Q3 path), domains named |
| G7 | nothing recognised | discovery (Flow 4) |
| G8 | a person name matching two people, or a person pronoun with nothing to point to | clarify |
| G9 | small talk / out of scope / open discovery ("what's new") | small_talk / out_of_scope / overview (§4.5, no search) |

A name that is both a source title and a topic ("Apache Iceberg", "Graph database") is a topic unless a container
phrase is used (design §4.1 rule 1).

## Baseline (routing v1, 2026-11-10)
309 cases (98 hand, 211 templated). Exact 48.2 %, micro precision 74.0 %, micro recall 54.7 %. Gate for routing v2:
exact ≥ 85 %, recall ≥ 90 %, precision ≥ 85 %.
