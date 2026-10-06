"""
Phase B M2 entity-extraction check: scores document_extract.baml (GPT-4o) against a user-reviewed
entity key. Parses each document with the production DoclingParser, builds the same text
IngestionEngine sends to BAML, extracts, and scores:
  - recall of "must find" entities (case-insensitive, aliases accepted)   target >= 0.80 per doc
  - invented People / ReferenceLinks (not present in the document text)    target 0
  - trap hits ("must NOT appear")                                           target 0
No Neo4j writes. Cost: one GPT-4o extraction per document (a few cents).

    .venv/bin/python scripts/eval_entity_extraction.py
Key: documents/eval/entity-extraction-check-2026-10-06/entity_key.json (built from ENTITY_KEY_REVIEW.md
after the user's review). Results are written next to the key.
"""
import json
import re
import sys
import unicodedata
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "src" / "mcp_server"))

CHECK_DIR = ROOT / "documents" / "eval" / "entity-extraction-check-2026-10-06"
KEY_PATH = CHECK_DIR / "entity_key.json"
RECALL_TARGET = 0.80
TYPE_FIELDS = {"Person": "people", "Technology": "technologies", "Concept": "concepts"}


def norm(s: str) -> str:
    s = unicodedata.normalize("NFKC", s or "").lower().strip()
    return re.sub(r"\s+", " ", re.sub(r"^https?://", "", s)).rstrip("/")


def main() -> None:
    from dotenv import load_dotenv
    load_dotenv(ROOT / ".env")
    from ingestion_engine import IngestionEngine
    from parsing.docling_parser import DoclingParser
    from parsing.structure_parser import MIME_PDF

    key = json.loads(KEY_PATH.read_text())
    parser = DoclingParser()
    results = {"run": datetime.now().isoformat(timespec="seconds"), "docs": {}}
    for doc in key["docs"]:
        data = (ROOT / doc["path"]).read_bytes()
        parsed = parser.parse(data, MIME_PDF, Path(doc["path"]).name,
                              page_range=tuple(doc["page_range"]) if doc.get("page_range") else None)
        text = IngestionEngine._document_text(parsed)
        extraction = IngestionEngine._extract_document_entities(text, doc["title"])
        found = {t: {norm(x.name) for x in getattr(extraction, f)} for t, f in TYPE_FIELDS.items()}
        found["ReferenceLink"] = {norm(x.url) for x in extraction.reference_links}
        all_found = set().union(*found.values())
        text_n = norm(text)

        must, hits, misses = 0, [], []
        for item in doc["must_find"]:
            names = {norm(item["name"])} | {norm(a) for a in item.get("aliases", [])}
            must += 1
            (hits if names & all_found else misses).append(item["name"])
        invented = sorted(n for n in found["Person"] | found["ReferenceLink"] if n and n not in text_n)
        traps = sorted(t for t in doc.get("must_not", []) if norm(t) in all_found)
        recall = len(hits) / must if must else None
        results["docs"][doc["id"]] = {
            "recall": recall, "passed": (recall or 0) >= RECALL_TARGET and not invented and not traps,
            "missed": misses, "invented_people_or_links": invented, "trap_hits": traps,
            "extracted": {t: sorted(v) for t, v in found.items()},
        }
        print(f"{doc['id']}: recall {recall:.2f} ({len(hits)}/{must}) | invented {invented} | traps {traps}")
        if misses:
            print(f"   missed: {misses}")
    out = CHECK_DIR / f"results-{datetime.now().strftime('%Y%m%d-%H%M%S')}.json"
    out.write_text(json.dumps(results, indent=1))
    print(f"ALL PASSED: {all(d['passed'] for d in results['docs'].values())}  →  {out.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
