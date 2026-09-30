"""
Phase B document-parser eval harness — L1 StructureParser bake-off.

Scores candidate parsers against a user-reviewed answer key. NOT part of the production ingestion
pipeline, and touches no service (no Neo4j, gateway or MCP). Design and decision rule:
documents/architecture/document-parser-eval-design-2026-09-29.md (local-only docs; the eval set
lives under documents/eval/, which is git-ignored).

This first version runs only the free, local, deterministic candidates (PyMuPDF, Docling). Paid
candidates (Document AI, LlamaParse, Claude/Gemini as L2 describers) get their own adapters in a
separate, separately-approved change. Supersedes the method of
scripts/compare_document_ingestion_vendors.py (open chat prompt, graded by eye).

Usage:
    .venv/bin/python scripts/eval_document_parsers.py                      # all local parsers
    .venv/bin/python scripts/eval_document_parsers.py --parsers pymupdf
"""
import argparse
import difflib
import json
import re
import time
import unicodedata
import zipfile
from dataclasses import asdict, dataclass, field
from datetime import datetime
from pathlib import Path

import pymupdf

DEFAULT_EVAL_DIR = Path("documents/eval/parser-eval-2026-09-30")
SOURCE_SUBDIR = "source_docs"
ANSWER_KEY_PATH = "answer_key/answer_key.json"
RESULTS_SUBDIR = "results"
WORK_SUBDIR = "results/_work"          # sample-page PDFs, identical input for every parser

WHOLE_DOC_KEY = "doc"
SCOPE_PHASE_B = "B"
SCOPE_PHASE_C = "C"
NOT_A_TABLE_TRAPS = {"chart_not_table", "cards_not_table", "diagram_not_table"}

# An image smaller than this share of the page is treated as an icon/logo, not a figure.
MIN_FIGURE_AREA_FRACTION = 0.02
# Max chars of per-page parser text kept in the raw-output file (full text is used for scoring).
RAW_TEXT_PREVIEW_CHARS = 1500
NUMBER_PATTERN = re.compile(r"\d[\d,]*(?:\.\d+)?")
# Expected table cells this long may match as a substring of a predicted cell (cells often hold
# several bullets); shorter ones (e.g. a quantity "2") must match exactly, or "2" would match "$290.00".
MIN_SUBSTRING_CELL_CHARS = 6

# Weighted overall score, adapted from the design doc §5 for the lighter answer key (no bboxes):
# element counts replace element F1/IoU; headings replace the section tree.
SCORE_WEIGHTS = {"elements": 0.40, "table_cells": 0.30, "text": 0.20, "structure": 0.10}

DOCLING_FIGURE_LABELS = {"picture", "chart"}
DOCLING_HEADING_LABELS = {"title", "section_header"}
DOCLING_CHECKBOX_LABELS = {"checkbox_selected": True, "checkbox_unselected": False}


@dataclass
class PageOutput:
    text: str = ""
    tables: list = field(default_factory=list)       # list of grids: list[list[str]]
    figures: int = 0
    headings: list = field(default_factory=list)
    checkboxes: dict = field(default_factory=dict)   # label text -> checked


def normalize(text: str) -> str:
    """NFKC (ligatures like 'ﬁ'), straight quotes, no zero-width spaces, collapsed whitespace."""
    text = unicodedata.normalize("NFKC", text or "")
    for src, dst in (("’", "'"), ("‘", "'"), ("“", '"'), ("”", '"'), ("​", "")):
        text = text.replace(src, dst)
    return re.sub(r"\s+", " ", text).strip()


def numbers_in(text: str) -> set:
    return {n.replace(",", "") for n in NUMBER_PATTERN.findall(text or "")}


# ---------------------------------------------------------------------------------------------
# Parsers. Each returns {page_number_or_WHOLE_DOC_KEY: PageOutput}. `pages` lists the page numbers
# of the ORIGINAL file that `path` (a sample-page PDF) contains, in order.
# ---------------------------------------------------------------------------------------------

class PyMuPDFParser:
    name = "pymupdf"
    formats = {"pdf"}

    def parse(self, path: Path, fmt: str, pages: list) -> dict:
        doc = pymupdf.open(path)
        out = {}
        for idx, original_page in enumerate(pages):
            page = doc[idx]
            page_area = page.rect.width * page.rect.height
            figures = sum(
                1 for info in page.get_image_info()
                if pymupdf.Rect(info["bbox"]).get_area() >= MIN_FIGURE_AREA_FRACTION * page_area
            )
            tables = [[[c or "" for c in row] for row in t.extract()] for t in page.find_tables().tables]
            out[original_page] = PageOutput(text=page.get_text(), tables=tables, figures=figures)
        return out


class DoclingParser:
    name = "docling"
    formats = {"pdf", "docx", "pptx"}

    def __init__(self):
        from docling.document_converter import DocumentConverter
        self.converter = DocumentConverter()

    def parse(self, path: Path, fmt: str, pages: list) -> dict:
        document = self.converter.convert(path).document
        out = {}

        def slot(item) -> PageOutput:
            if fmt == "docx" or not getattr(item, "prov", None):
                key = WHOLE_DOC_KEY
            else:
                page_no = item.prov[0].page_no
                key = pages[page_no - 1] if fmt == "pdf" else page_no   # pptx page_no = slide number
            return out.setdefault(key, PageOutput())

        # traverse_pictures: Docling nests text it extracted inside regions it labels as pictures
        # (slides, code blocks, a whole web-article box); the default iteration would hide it.
        for item, _level in document.iterate_items(traverse_pictures=True):
            label = getattr(getattr(item, "label", None), "value", "")
            target = slot(item)
            if label == "table":
                df = item.export_to_dataframe(doc=document)
                grid = [[str(c) for c in df.columns]] + [[str(v) for v in row] for row in df.values.tolist()]
                target.tables.append(grid)
                target.text += "\n" + "\n".join(" | ".join(r) for r in grid)
                continue
            if label in DOCLING_FIGURE_LABELS and self._is_figure_sized(document, item):
                target.figures += 1
            text = getattr(item, "text", "") or ""
            if label in DOCLING_HEADING_LABELS:
                target.headings.append(text)
            if label in DOCLING_CHECKBOX_LABELS:
                target.checkboxes[text] = DOCLING_CHECKBOX_LABELS[label]
            if text:
                target.text += "\n" + text
        return out


    @staticmethod
    def _is_figure_sized(document, item) -> bool:
        """Same rule as PyMuPDFParser: pictures under MIN_FIGURE_AREA_FRACTION of the page are
        logos/icons, not figures. Items without a page box (DOCX) are counted."""
        prov = getattr(item, "prov", None)
        page = document.pages.get(prov[0].page_no) if prov else None
        if not prov or page is None or page.size is None:
            return True
        page_area = page.size.width * page.size.height
        return prov[0].bbox.area() >= MIN_FIGURE_AREA_FRACTION * page_area


PARSERS = {"pymupdf": PyMuPDFParser, "docling": DoclingParser}


# ---------------------------------------------------------------------------------------------
# Scoring
# ---------------------------------------------------------------------------------------------

def in_range(value: int, bounds) -> bool:
    return bounds is None or bounds[0] <= value <= bounds[1]


def line_accuracy(expected_lines: list, text: str) -> float:
    """Mean best-match similarity of each expected line against the output's lines (and pairs of
    adjacent lines, since OCR often splits one written line in two)."""
    lines = [normalize(l) for l in (text or "").splitlines() if normalize(l)]
    candidates = lines + [f"{a} {b}" for a, b in zip(lines, lines[1:])]
    if not expected_lines:
        return None
    if not candidates:
        return 0.0
    scores = [max(difflib.SequenceMatcher(None, normalize(e), c).ratio() for c in candidates)
              for e in expected_lines]
    return sum(scores) / len(scores)


def cell_matches(expected: str, predicted_row: list) -> bool:
    if expected in predicted_row:
        return True
    return len(expected) >= MIN_SUBSTRING_CELL_CHARS and any(expected in cell for cell in predicted_row)


def unsupported_score(expect: dict) -> dict:
    """A parser that can't open the format scores zero on everything that page is keyed for."""
    s = score_page(expect, PageOutput(), set())
    zeroed = {k: (0.0 if isinstance(v, float) else v) for k, v in s.items()}
    zeroed.update(elements_score=0.0, trap_passed=False if s["trap_passed"] is not None else None,
                  headings_ok=False if s["headings_ok"] is not None else None)
    return zeroed


def table_cell_accuracy(expected_tables: list, predicted_tables: list) -> float:
    """For each expected table: pick the predicted table that matches best; per expected row, pick
    the predicted row containing the most of that row's cells (normalized exact match). Empty
    expected cells are not scored. Returns matched / expected cells over all expected tables."""
    total = matched = 0
    for expected in expected_tables:
        cells = sum(1 for row in expected for c in row if c)
        total += cells
        best = 0
        for predicted in predicted_tables:
            pred_rows = [[normalize(c) for c in row] for row in predicted]
            hits = sum(max((sum(1 for c in row if c and cell_matches(normalize(c), pr)) for pr in pred_rows), default=0)
                       for row in expected)
            best = max(best, hits)
        matched += best
    return matched / total if total else None


def score_page(expect: dict, got: PageOutput, reference_numbers: set) -> dict:
    text_norm = normalize(got.text)
    n_tables, n_figures = len(got.tables), got.figures
    element_checks = [in_range(n_tables, expect.get("tables")), in_range(n_figures, expect.get("figures"))]
    if "tables_plus_figures" in expect:
        element_checks.append(in_range(n_tables + n_figures, expect["tables_plus_figures"]))
    trap = expect.get("trap")
    trap_ok = (n_tables == 0) if trap in NOT_A_TABLE_TRAPS else None

    must = expect.get("must_contain", [])
    must_recall = (sum(1 for s in must if normalize(s) in text_norm) / len(must)) if must else None
    ocr = expect.get("ocr_strings", [])
    ocr_recall = (sum(1 for s in ocr if normalize(s).lower() in text_norm.lower()) / len(ocr)) if ocr else None
    ref_acc = line_accuracy(expect.get("reference_text", []), got.text)
    cells = table_cell_accuracy(expect.get("table_cells", []), got.tables) if expect.get("table_cells") else None
    headings_ok = in_range(len(got.headings), expect["headings"]) if "headings" in expect else None

    checkbox_acc = None
    if expect.get("checkboxes"):
        found = {normalize(k): v for k, v in got.checkboxes.items()}
        checkbox_acc = sum(1 for k, v in expect["checkboxes"].items() if found.get(normalize(k)) == v) / len(expect["checkboxes"])

    struck = expect.get("struck_through", [])
    struck_leaked = [s for s in struck if normalize(s) in text_norm]

    allowed = reference_numbers | numbers_in(" ".join(expect.get("allowed_numbers", [])))
    unverified = sorted(numbers_in(got.text) - allowed)

    text_parts = [v for v in (must_recall, ref_acc) if v is not None]
    return {
        "tables_found": n_tables, "figures_found": n_figures,
        "elements_score": sum(element_checks) / len(element_checks),
        "trap": trap, "trap_passed": trap_ok,
        "must_contain_recall": must_recall, "image_text_recall": ocr_recall,
        "reference_text_accuracy": ref_acc, "table_cell_accuracy": cells,
        "headings_found": len(got.headings), "headings_ok": headings_ok,
        "checkbox_accuracy": checkbox_acc, "struck_through_leaked": struck_leaked,
        "text_score": (sum(text_parts) / len(text_parts)) if text_parts else None,
        "unverified_numbers": unverified[:40], "unverified_number_count": len(unverified),
    }


OFFICE_TEXT_PATTERN = re.compile(r"<(?:w|a):t[^>]*>([^<]*)</(?:w|a):t>")


def source_text(fmt: str, source: Path) -> str:
    """The document's own stored text (whole document): the PDF text layer, or the text runs
    inside the DOCX/PPTX XML. Empty for scanned/handwritten pages."""
    if fmt == "pdf":
        return "\n".join(page.get_text() for page in pymupdf.open(source))
    with zipfile.ZipFile(source) as z:
        parts = [n for n in z.namelist() if n.endswith(".xml") and (n.startswith("word/") or n.startswith("ppt/slides/"))]
        return "\n".join(" ".join(OFFICE_TEXT_PATTERN.findall(z.read(n).decode("utf-8", "ignore"))) for n in parts)


def reference_numbers_for(fmt: str, source: Path, expect: dict) -> set:
    """Numbers that legitimately exist in the document: its own stored text (the whole document, since
    parsers may attach a paragraph that crosses a page break to either page; also with line breaks
    removed, since wrapped URLs/IDs get re-joined), plus every number in the answer key for the page."""
    text = source_text(fmt, source)
    return numbers_in(text) | numbers_in(text.replace("\n", "")) | numbers_in(json.dumps(expect))


def weighted(scores: list) -> dict:
    def mean(key):
        vals = [s[key] for s in scores if s.get(key) is not None]
        return (sum(vals) / len(vals)) if vals else None
    parts = {
        "elements": mean("elements_score"),
        "table_cells": mean("table_cell_accuracy"),
        "text": mean("text_score"),
        "structure": (lambda v: None if v is None else float(v))(mean("headings_ok")),
    }
    present = {k: v for k, v in parts.items() if v is not None}
    weight_sum = sum(SCORE_WEIGHTS[k] for k in present)
    overall = sum(SCORE_WEIGHTS[k] * v for k, v in present.items()) / weight_sum if weight_sum else None
    traps = [s["trap_passed"] for s in scores if s.get("trap_passed") is not None]
    return {**parts, "overall": overall,
            "traps_passed": f"{sum(traps)}/{len(traps)}" if traps else "n/a",
            "unverified_numbers_total": sum(s["unverified_number_count"] for s in scores),
            "pages_scored": len(scores)}


# ---------------------------------------------------------------------------------------------
# Runner
# ---------------------------------------------------------------------------------------------

def build_sample_pdf(source: Path, pages: list, work_dir: Path) -> Path:
    """Sample pages only, so a 242-page manual isn't fully converted, and every parser sees the
    byte-identical input."""
    work_dir.mkdir(parents=True, exist_ok=True)
    out_path = work_dir / f"{source.stem}__sample.pdf"
    if not out_path.exists():
        src, out = pymupdf.open(source), pymupdf.open()
        for p in pages:
            out.insert_pdf(src, from_page=p - 1, to_page=p - 1)
        out.save(out_path)
    return out_path


def run(eval_dir: Path, parser_names: list) -> dict:
    key = json.loads((eval_dir / ANSWER_KEY_PATH).read_text())["docs"]
    results_dir = eval_dir / RESULTS_SUBDIR
    results_dir.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    summary = {"run": stamp, "parsers": {}}

    for name in parser_names:
        parser = PARSERS[name]()
        raw, page_scores, timings = {}, {SCOPE_PHASE_B: [], SCOPE_PHASE_C: []}, {}
        for filename, spec in key.items():
            fmt, scope = spec["format"], spec["scope"]
            source = eval_dir / SOURCE_SUBDIR / filename
            expected_pages = {WHOLE_DOC_KEY: spec["whole_doc"]} if "whole_doc" in spec else \
                {int(p): e for p, e in spec["pages"].items()}
            if fmt not in parser.formats:
                raw[filename] = {"unsupported": True}
                for page_key, expect in expected_pages.items():
                    page_scores[scope].append({**unsupported_score(expect), "doc": filename, "page": page_key, "unsupported": True})
                continue
            pages = sorted(p for p in expected_pages if p != WHOLE_DOC_KEY)
            parse_input = build_sample_pdf(source, pages, eval_dir / WORK_SUBDIR) if fmt == "pdf" else source
            started = time.time()
            try:
                outputs = parser.parse(parse_input, fmt, pages)
                error = None
            except Exception as e:                      # a crash scores 0 for that document, never aborts the run
                outputs, error = {}, f"{type(e).__name__}: {e}"
            timings[filename] = round(time.time() - started, 2)
            raw[filename] = {"error": error, "seconds": timings[filename], "pages": {}}
            for page_key, expect in expected_pages.items():
                got = outputs.get(page_key, PageOutput())
                s = score_page(expect, got, reference_numbers_for(fmt, source, expect))
                page_scores[scope].append({**s, "doc": filename, "page": page_key})
                preview = asdict(got)
                preview["text"] = got.text[:RAW_TEXT_PREVIEW_CHARS]
                raw[filename]["pages"][str(page_key)] = preview
            print(f"[{name}] {filename}: {timings[filename]}s{' ERROR ' + error if error else ''}")

        (results_dir / f"{stamp}_{name}_raw.json").write_text(json.dumps(raw, indent=1, default=str))
        summary["parsers"][name] = {
            "phase_b": weighted(page_scores[SCOPE_PHASE_B]),
            "phase_c_preview": weighted(page_scores[SCOPE_PHASE_C]),
            "seconds_total": round(sum(timings.values()), 1),
            "pages": page_scores,
        }

    (results_dir / f"{stamp}_scores.json").write_text(json.dumps(summary, indent=1, default=str))
    return summary


def print_summary(summary: dict) -> None:
    def fmt(v):
        return "—" if v is None else (f"{v:.2f}" if isinstance(v, float) else str(v))
    print("\nparser    scope     overall elements tbl_cells text  struct traps  unverified#  secs")
    for name, r in summary["parsers"].items():
        for scope in ("phase_b", "phase_c_preview"):
            w = r[scope]
            print(f"{name:<9} {scope:<9} {fmt(w['overall']):>7} {fmt(w['elements']):>8} {fmt(w['table_cells']):>9} "
                  f"{fmt(w['text']):>5} {fmt(w['structure']):>6} {w['traps_passed']:>6} {w['unverified_numbers_total']:>11} "
                  f"{r['seconds_total'] if scope == 'phase_b' else '':>5}")


if __name__ == "__main__":
    cli = argparse.ArgumentParser(description=__doc__.split("\n")[1])
    cli.add_argument("--eval-dir", type=Path, default=DEFAULT_EVAL_DIR)
    cli.add_argument("--parsers", nargs="+", default=list(PARSERS), choices=list(PARSERS))
    args = cli.parse_args()
    print_summary(run(args.eval_dir, args.parsers))
