"""
Phase B document-parser eval harness — L1 StructureParser bake-off.

Scores candidate parsers against a user-reviewed answer key. NOT part of the production ingestion
pipeline, and touches no service (no Neo4j, gateway or MCP). Design and decision rule:
documents/architecture/document-parser-eval-design-2026-09-29.md (local-only docs; the eval set
lives under documents/eval/, which is git-ignored).

Candidates:
  local, free    : pymupdf, docling
  paid, L1       : documentai (Layout Parser, deterministic), llamaparse (parse_page_without_llm)
  paid, L2 (VLM) : claude, gemini. Same prompt and JSON schema, one page per call, 3 runs each.
Paid calls go through CostMeter: every call is priced from actual usage, and a call is refused if
spent + that vendor's worst-case per-call reserve would pass --budget-usd (default 15).
Supersedes the method of scripts/compare_document_ingestion_vendors.py (open prompt, graded by eye).

Usage:
    .venv/bin/python scripts/eval_document_parsers.py                               # local parsers
    .venv/bin/python scripts/eval_document_parsers.py --parsers documentai llamaparse claude gemini
"""
import argparse
import base64
import difflib
import json
import os
import re
import statistics
import subprocess
import sys
import time
import unicodedata
import zipfile
from dataclasses import asdict, dataclass, field
from datetime import datetime
from pathlib import Path

import pymupdf

DEFAULT_EVAL_DIR = Path("documents/eval/parser-eval-2026-09-30")
LOCAL_PARSERS = ["pymupdf", "docling"]
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
# Sliding-window step for line_accuracy = expected-line length // this.
LINE_WINDOW_STEP_DIVISOR = 4
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

# --- Paid vendors. Prices checked 2026-09-30 (vendor price pages); USD. ------------------------
DEFAULT_BUDGET_USD = 15.0
RUNS_PER_PARSER = {"documentai": 2, "claude": 3, "gemini": 3}   # 2 = determinism check; 3 = VLM variance
PRICE_PER_MTOK = {"claude": (4.00, 20.00), "gemini": (2.00, 12.00)}   # (input, output incl. thinking)
PRICE_PER_PAGE = {"documentai": 0.010, "llamaparse": 0.0}            # llamaparse: within free monthly credits
# Worst-case cost of ONE call, reserved before calling so the budget can't be overshot.
CALL_RESERVE_USD = {"claude": 0.40, "gemini": 0.25, "documentai": 0.15, "llamaparse": 0.0}
VLM_MAX_OUTPUT_TOKENS = 16000
# A dead connection must fail fast. 2026-09-30: a Claude run blocked ~10 h on an SSL read after the
# laptop slept; the per-request timeout plus a bounded retry count prevents that.
VLM_REQUEST_TIMEOUT_SECONDS = 180
VLM_MAX_RETRIES = 2

GCP_PROJECT = "cortex-drive-496915"
DOCUMENTAI_LOCATION = "us"
DOCUMENTAI_PROCESSOR = "projects/377406326936/locations/us/processors/4add215827cc526e"  # Layout Parser, created 2026-09-30
DOCUMENTAI_HEADING_PREFIXES = ("heading", "title")
LLAMAPARSE_MODE = "parse_page_without_llm"   # L1 rule: no generative step (chart->table fabrication, 2026-09-28)

CLAUDE_MODEL = "claude-opus-5-5"
CLAUDE_EFFORT = "medium"
GEMINI_MODEL = "gemini-3.1-pro-preview"
GEMINI_LOCATION = "global"                   # the only region that served this model (2026-09-28)
# Anthropic Workload Identity Federation (no static key), as verified 2026-09-28.
ANTHROPIC_WIF = {
    "impersonate": "cortex-mcp-worker@cortex-drive-496915.iam.gserviceaccount.com",
    "federation_rule_id": "fdrl_01N1X4hshN918sM4c612aiys",
    "organization_id": "dadbadf4-d114-46f7-aeda-7df9ffe82a40",
    "service_account_id": "svac_01CZuaCMKodSs6C83o8R5MUX",
    "workspace_id": "wrkspc_01BWWNZfUikYXfLwu3uCec43",
}

VLM_PROMPT = """You are a document parser. Extract the content of this single page as JSON matching the schema.
Rules:
- text: transcribe ALL visible text exactly as printed, in natural reading order (finish a column before the next). Do not correct spelling, grammar or numbering. Omit struck-through (crossed-out) text.
- headings: the page's titles and section headings, exactly as printed.
- tables: only real tables (a grid of rows and columns). Side-by-side columns whose rows correspond to each other ARE a table, even when each cell is drawn as a separate box. Stand-alone cards, bullet lists, flow diagrams and charts are NOT tables. Never convert a chart into a table.
- figures: every chart, diagram or photo. Skip logos, small icons and decorative backgrounds. kind is chart, diagram, photo or other. title and visible_text: only words and numbers literally printed in the figure. Never estimate or infer values that are not printed. description: what the figure shows, in one or two sentences.
- checkboxes: every checkbox or radio button with its label and whether it is checked.
If something is not present, return an empty list."""

VLM_SCHEMA = {
    "type": "object", "additionalProperties": False,
    "required": ["text", "headings", "tables", "figures", "checkboxes"],
    "properties": {
        "text": {"type": "string"},
        "headings": {"type": "array", "items": {"type": "string"}},
        "tables": {"type": "array", "items": {
            "type": "object", "additionalProperties": False, "required": ["rows"],
            "properties": {"rows": {"type": "array", "items": {"type": "array", "items": {"type": "string"}}}}}},
        "figures": {"type": "array", "items": {
            "type": "object", "additionalProperties": False,
            "required": ["kind", "title", "visible_text", "description"],
            "properties": {"kind": {"type": "string", "enum": ["chart", "diagram", "photo", "other"]},
                           "title": {"type": "string"},
                           "visible_text": {"type": "array", "items": {"type": "string"}},
                           "description": {"type": "string"}}}},
        "checkboxes": {"type": "array", "items": {
            "type": "object", "additionalProperties": False, "required": ["label", "checked"],
            "properties": {"label": {"type": "string"}, "checked": {"type": "boolean"}}}},
    },
}


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


# ---------------------------------------------------------------------------------------------
# Paid vendors: cost guard + adapters
# ---------------------------------------------------------------------------------------------

class BudgetExceeded(Exception):
    pass


class CostMeter:
    """Actual spend from reported usage. reserve() is called before every paid call and refuses it
    if the vendor's worst-case cost for that call could push the total past the budget."""

    def __init__(self, budget_usd: float):
        self.budget = budget_usd
        self.spent = 0.0
        self.by_vendor = {}

    def reserve(self, vendor: str):
        if self.spent + CALL_RESERVE_USD[vendor] > self.budget:
            raise BudgetExceeded(f"{vendor}: spent ${self.spent:.2f}; next call could exceed the ${self.budget:.2f} cap")

    def add(self, vendor: str, usd: float):
        self.spent += usd
        self.by_vendor[vendor] = self.by_vendor.get(vendor, 0.0) + usd

    def add_tokens(self, vendor: str, input_tokens: int, output_tokens: int):
        price_in, price_out = PRICE_PER_MTOK[vendor]
        self.add(vendor, (input_tokens * price_in + output_tokens * price_out) / 1_000_000)


def single_page_pdfs(path: Path) -> list:
    """Each page of a sample PDF as its own PDF (bytes): VLMs get one page per call."""
    src = pymupdf.open(path)
    out = []
    for i in range(src.page_count):
        one = pymupdf.open()
        one.insert_pdf(src, from_page=i, to_page=i)
        out.append(one.tobytes())
    return out


class DocumentAIParser:
    name = "documentai"
    formats = {"pdf"}

    def __init__(self, meter: CostMeter):
        from google.api_core.client_options import ClientOptions
        from google.cloud import documentai_v1 as dai
        self.dai, self.meter = dai, meter
        self.client = dai.DocumentProcessorServiceClient(
            client_options=ClientOptions(api_endpoint=f"{DOCUMENTAI_LOCATION}-documentai.googleapis.com"))

    def parse(self, path: Path, fmt: str, pages: list) -> dict:
        dai = self.dai
        self.meter.reserve(self.name)
        request = dai.ProcessRequest(
            name=DOCUMENTAI_PROCESSOR,
            raw_document=dai.RawDocument(content=path.read_bytes(), mime_type="application/pdf"),
            process_options=dai.ProcessOptions(layout_config=dai.ProcessOptions.LayoutConfig(return_images=True)))
        document = self.client.process_document(request=request).document
        self.meter.add(self.name, PRICE_PER_PAGE[self.name] * len(pages))
        out = {}

        def page_of(block, inherited):
            # A child's own page wins: section headings contain paragraphs that run onto later pages.
            if block.page_span.page_start:
                return pages[block.page_span.page_start - 1]
            return inherited if inherited is not None else pages[0]

        def walk(blocks, inherited=None):
            for block in blocks:
                page = page_of(block, inherited)
                target = out.setdefault(page, PageOutput())
                kind = block._pb.WhichOneof("block")
                if kind == "text_block":
                    tb = block.text_block
                    target.text += "\n" + tb.text
                    if tb.type_.startswith(DOCUMENTAI_HEADING_PREFIXES):
                        target.headings.append(tb.text)
                    walk(tb.blocks, page)
                elif kind == "table_block":
                    rows = list(block.table_block.header_rows) + list(block.table_block.body_rows)
                    grid = [[" ".join(b.text_block.text for b in cell.blocks) for cell in row.cells] for row in rows]
                    target.tables.append(grid)
                    target.text += "\n" + "\n".join(" | ".join(r) for r in grid)
                elif kind == "list_block":
                    for entry in block.list_block.list_entries:
                        walk(entry.blocks, page)
                elif kind == "image_block":
                    target.figures += 1
        walk(document.document_layout.blocks)
        return out


class LlamaParseParser:
    name = "llamaparse"
    formats = {"pdf", "docx", "pptx"}

    def __init__(self, meter: CostMeter):
        from dotenv import load_dotenv
        from llama_cloud_services import LlamaParse
        load_dotenv(".env")
        self.meter = meter
        self.parser = LlamaParse(api_key=os.environ["LLAMA_CLOUD_API_KEY"], parse_mode=LLAMAPARSE_MODE,
                                 extract_charts=False, verbose=False)

    def parse(self, path: Path, fmt: str, pages: list) -> dict:
        self.meter.reserve(self.name)
        result = self.parser.parse(str(path))
        out = {}
        for page in result.pages:
            key = WHOLE_DOC_KEY if fmt == "docx" else (pages[page.page - 1] if fmt == "pdf" else page.page)
            target = out.setdefault(key, PageOutput())
            page_area = (page.width or 0) * (page.height or 0)
            for item in page.items or []:
                if item.type == "table" and item.rows:
                    grid = [[str(c) for c in row] for row in item.rows]
                    target.tables.append(grid)
                    target.text += "\n" + "\n".join(" | ".join(r) for r in grid)
                    continue
                value = getattr(item, "value", "") or ""
                if item.type == "heading":
                    target.headings.append(value)
                target.text += "\n" + value
            for image in page.images or []:
                area = (getattr(image, "width", 0) or 0) * (getattr(image, "height", 0) or 0)
                if not page_area or area >= MIN_FIGURE_AREA_FRACTION * page_area:
                    target.figures += 1
        self.meter.add(self.name, PRICE_PER_PAGE[self.name] * len(result.pages))
        return out


class VisionLLMParser:
    """One page per call, identical prompt and JSON schema for every VLM. A refusal or unparseable
    reply scores that page as empty; nothing falls back to another model."""
    formats = {"pdf"}

    def parse(self, path: Path, fmt: str, pages: list) -> dict:
        out = {}
        for original_page, pdf_bytes in zip(pages, single_page_pdfs(path)):
            self.meter.reserve(self.name)
            data = self.call(pdf_bytes)
            out[original_page] = self.to_page_output(data)
        return out

    @staticmethod
    def to_page_output(data: dict) -> PageOutput:
        if not data:
            return PageOutput()
        figures = [f for f in data.get("figures", []) if f.get("kind") != "other"]
        figure_text = "\n".join(
            "\n".join([f.get("title", "")] + list(f.get("visible_text", [])) + [f.get("description", "")]) for f in figures)
        return PageOutput(
            text=(data.get("text", "") or "") + "\n" + figure_text,
            tables=[t.get("rows", []) for t in data.get("tables", [])],
            figures=len(figures),
            headings=list(data.get("headings", [])),
            checkboxes={c["label"]: bool(c["checked"]) for c in data.get("checkboxes", []) if "label" in c},
        )


class ClaudeParser(VisionLLMParser):
    name = "claude"

    def __init__(self, meter: CostMeter):
        from anthropic import Anthropic, WorkloadIdentityCredentials
        self.meter = meter
        self.client = Anthropic(credentials=WorkloadIdentityCredentials(
            identity_token_provider=self._identity_token,
            federation_rule_id=ANTHROPIC_WIF["federation_rule_id"],
            organization_id=ANTHROPIC_WIF["organization_id"],
            service_account_id=ANTHROPIC_WIF["service_account_id"],
            workspace_id=ANTHROPIC_WIF["workspace_id"],
        ), timeout=VLM_REQUEST_TIMEOUT_SECONDS, max_retries=VLM_MAX_RETRIES)

    @staticmethod
    def _identity_token() -> str:
        return subprocess.run(
            ["gcloud", "auth", "print-identity-token", f"--impersonate-service-account={ANTHROPIC_WIF['impersonate']}",
             "--audiences=https://api.anthropic.com", "--include-email"],
            capture_output=True, text=True, check=True).stdout.strip()

    def call(self, pdf_bytes: bytes) -> dict:
        message = self.client.messages.create(
            model=CLAUDE_MODEL, max_tokens=VLM_MAX_OUTPUT_TOKENS,
            output_config={"effort": CLAUDE_EFFORT, "format": {"type": "json_schema", "schema": VLM_SCHEMA}},
            messages=[{"role": "user", "content": [
                {"type": "document", "source": {"type": "base64", "media_type": "application/pdf",
                                                "data": base64.standard_b64encode(pdf_bytes).decode()}},
                {"type": "text", "text": VLM_PROMPT}]}],
        )
        self.meter.add_tokens(self.name, message.usage.input_tokens, message.usage.output_tokens)
        if message.stop_reason == "refusal":
            return {}
        text = "".join(b.text for b in message.content if b.type == "text")
        try:
            return json.loads(text)
        except json.JSONDecodeError:
            return {}


class GeminiParser(VisionLLMParser):
    name = "gemini"

    def __init__(self, meter: CostMeter):
        from google import genai
        from google.genai import types
        self.meter, self.types = meter, types
        self.client = genai.Client(
            vertexai=True, project=GCP_PROJECT, location=GEMINI_LOCATION,
            http_options=types.HttpOptions(timeout=VLM_REQUEST_TIMEOUT_SECONDS * 1000,
                                           retry_options=types.HttpRetryOptions(attempts=VLM_MAX_RETRIES + 1)))

    def call(self, pdf_bytes: bytes) -> dict:
        types = self.types
        response = self.client.models.generate_content(
            model=GEMINI_MODEL,
            contents=[types.Part.from_bytes(data=pdf_bytes, mime_type="application/pdf"), VLM_PROMPT],
            config=types.GenerateContentConfig(response_mime_type="application/json",
                                               response_json_schema=VLM_SCHEMA,
                                               max_output_tokens=VLM_MAX_OUTPUT_TOKENS),
        )
        usage = response.usage_metadata
        self.meter.add_tokens(self.name, usage.prompt_token_count or 0,
                              (usage.candidates_token_count or 0) + (usage.thoughts_token_count or 0))
        try:
            return json.loads(response.text or "")
        except json.JSONDecodeError:
            return {}


class DoclingProdParser:
    """The production L1 parser (src/mcp_server/parsing/docling_parser.py, Phase B M1), scored with the
    same answer key as the eval's Docling baseline. Regression gate: Phase B PDF-only overall >= 0.85."""
    name = "docling_prod"
    formats = {"pdf", "docx", "pptx"}
    MIME_BY_FORMAT = {"pdf": "application/pdf",
                      "docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
                      "pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation"}

    def __init__(self):
        sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "src" / "mcp_server"))
        from parsing.docling_parser import DoclingParser
        from parsing.structure_parser import VISUAL_ELEMENT_TYPES, ELEMENT_TYPE_TABLE, ELEMENT_TYPE_HEADING, ELEMENT_TYPE_CHECKBOX
        self.parser = DoclingParser()
        self.visual, self.table, self.heading, self.checkbox = VISUAL_ELEMENT_TYPES, ELEMENT_TYPE_TABLE, ELEMENT_TYPE_HEADING, ELEMENT_TYPE_CHECKBOX

    def parse(self, path: Path, fmt: str, pages: list) -> dict:
        parsed = self.parser.parse(path.read_bytes(), self.MIME_BY_FORMAT[fmt], path.name)
        out = {}
        for e in parsed.elements:
            if fmt == "docx" or e.page is None:
                key = WHOLE_DOC_KEY
            else:
                key = pages[e.page - 1] if fmt == "pdf" else e.page   # pdf: sample page index → original page
            target = out.setdefault(key, PageOutput())
            if e.type == self.table:
                target.tables.append(e.cells or [])
            if e.type in self.visual:
                size = parsed.page_sizes.get(e.page)
                if not size or not e.bbox or e.bbox.area >= MIN_FIGURE_AREA_FRACTION * size[0] * size[1]:
                    target.figures += 1
            if e.type == self.heading:
                target.headings.append(e.text)
            if e.type == self.checkbox:
                target.checkboxes[e.text] = bool(e.checked)
            if e.text:
                target.text += "\n" + e.text
        return out


PARSERS = {"pymupdf": PyMuPDFParser, "docling": DoclingParser, "docling_prod": DoclingProdParser, "documentai": DocumentAIParser,
           "llamaparse": LlamaParseParser, "claude": ClaudeParser, "gemini": GeminiParser}
PAID_PARSERS = {"documentai", "llamaparse", "claude", "gemini"}


# ---------------------------------------------------------------------------------------------
# Scoring
# ---------------------------------------------------------------------------------------------

def in_range(value: int, bounds) -> bool:
    return bounds is None or bounds[0] <= value <= bounds[1]


def best_window_ratio(expected: str, haystack: str) -> float:
    """Best similarity of `expected` against any same-length window of `haystack`, so the score
    doesn't depend on how a parser broke lines (one VLM returns a whole page as a single line)."""
    if not haystack:
        return 0.0
    size = len(expected)
    if len(haystack) <= size:
        return difflib.SequenceMatcher(None, expected, haystack).ratio()
    step = max(1, size // LINE_WINDOW_STEP_DIVISOR)
    return max(difflib.SequenceMatcher(None, expected, haystack[i:i + size]).ratio()
               for i in range(0, len(haystack) - size + 1, step))


def line_accuracy(expected_lines: list, text: str) -> float:
    """Mean best-window similarity of each expected line against the whole normalized output."""
    if not expected_lines:
        return None
    haystack = normalize(text)
    scores = [best_window_ratio(normalize(e), haystack) for e in expected_lines]
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
    # The page list is part of the name: a targeted re-test must never reuse a sample built for a
    # different page list (2026-10-01: that shifted every page after the first mismatch by one).
    out_path = work_dir / f"{source.stem}__p{'-'.join(str(p) for p in pages)}.pdf"
    if not out_path.exists():
        src, out = pymupdf.open(source), pymupdf.open()
        for p in pages:
            out.insert_pdf(src, from_page=p - 1, to_page=p - 1)
        out.save(out_path)
    return out_path


def select_pages(key: dict, selectors: list) -> dict:
    """Restrict the answer key to "file.pdf:3,9" selectors, for targeted re-tests."""
    picked = {}
    for selector in selectors:
        filename, _, page_list = selector.partition(":")
        spec = dict(key[filename])
        wanted = {p.strip() for p in page_list.split(",") if p.strip()}
        spec["pages"] = {p: e for p, e in spec["pages"].items() if p in wanted}
        picked[filename] = spec
    return picked


def run(eval_dir: Path, parser_names: list, budget_usd: float = DEFAULT_BUDGET_USD,
        pages_filter: list = None, runs_override: int = None) -> dict:
    key = json.loads((eval_dir / ANSWER_KEY_PATH).read_text())["docs"]
    if pages_filter:
        key = select_pages(key, pages_filter)
    results_dir = eval_dir / RESULTS_SUBDIR
    results_dir.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    meter = CostMeter(budget_usd)
    summary = {"run": stamp, "budget_usd": budget_usd, "parsers": {}}

    for name in parser_names:
        parser = PARSERS[name](meter) if name in PAID_PARSERS else PARSERS[name]()
        runs = runs_override or RUNS_PER_PARSER.get(name, 1)
        per_run, raw_runs, stopped = [], [], None
        for run_no in range(1, runs + 1):
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
                except BudgetExceeded as e:
                    stopped = str(e)
                    break
                except Exception as e:                      # a crash scores 0 for that document, never aborts the run
                    outputs, error = {}, f"{type(e).__name__}: {e}"
                timings[filename] = round(time.time() - started, 2)
                raw[filename] = {"error": error, "seconds": timings[filename], "pages": {}}
                for page_key, expect in expected_pages.items():
                    got = outputs.get(page_key, PageOutput())
                    s = score_page(expect, got, reference_numbers_for(fmt, source, expect))
                    page_scores[scope].append({**s, "doc": filename, "page": page_key})
                    raw[filename]["pages"][str(page_key)] = asdict(got)   # full text: re-scoring never needs a paid re-run
                print(f"[{name} run {run_no}] {filename}: {timings[filename]}s  spent ${meter.spent:.4f}"
                      f"{' ERROR ' + error if error else ''}", flush=True)
                # Persist after every document: a stopped run keeps what it finished, and spend is known.
                (results_dir / f"{stamp}_{name}_raw.partial.json").write_text(
                    json.dumps(raw_runs + [raw], indent=1, default=str))
                with (results_dir / f"{stamp}_ledger.jsonl").open("a") as ledger:
                    ledger.write(json.dumps({"time": datetime.now().isoformat(timespec="seconds"), "parser": name,
                                             "run": run_no, "doc": filename, "error": error,
                                             "spent_total_usd": round(meter.spent, 4),
                                             "spent_by_vendor_usd": {k: round(v, 4) for k, v in meter.by_vendor.items()}}) + "\n")
            if stopped:
                print(f"[{name}] STOPPED: {stopped}", flush=True)
                break                                       # an incomplete run is discarded, never scored
            raw_runs.append(raw)
            per_run.append({"phase_b": weighted(page_scores[SCOPE_PHASE_B]),
                            "phase_c_preview": weighted(page_scores[SCOPE_PHASE_C]),
                            "seconds_total": round(sum(timings.values()), 1), "pages": page_scores})

        (results_dir / f"{stamp}_{name}_raw.json").write_text(json.dumps(raw_runs, indent=1, default=str))
        if not per_run:
            summary["parsers"][name] = {"stopped": stopped, "runs_completed": 0}
            continue
        overall = [r["phase_b"]["overall"] for r in per_run if r["phase_b"]["overall"] is not None]
        summary["parsers"][name] = {
            **per_run[0],                                   # run 1 in full; others summarized below
            "runs_completed": len(per_run), "stopped": stopped,
            "phase_b_overall_by_run": overall,
            "phase_b_overall_stdev": round(statistics.pstdev(overall), 4) if len(overall) > 1 else None,
            "cost_usd": round(meter.by_vendor.get(name, 0.0), 4),
            "other_runs": [{k: r[k] for k in ("phase_b", "phase_c_preview", "seconds_total")} for r in per_run[1:]],
        }

    summary["cost_usd_total"] = round(meter.spent, 4)
    (results_dir / f"{stamp}_scores.json").write_text(json.dumps(summary, indent=1, default=str))
    return summary


# Raw files written before full text was kept (2026-09-30 17:49 and earlier) cut page text here.
LEGACY_RAW_TEXT_CHARS = 1500


def rescore(eval_dir: Path, raw_path: Path) -> dict:
    """Re-score a saved <stamp>_<parser>_raw.json with the current scoring code, with no vendor
    calls. Pages whose saved text was cut at LEGACY_RAW_TEXT_CHARS are flagged, because their
    text metrics may be understated."""
    key = json.loads((eval_dir / ANSWER_KEY_PATH).read_text())["docs"]
    runs = json.loads(raw_path.read_text())
    per_run = []
    for raw in runs:
        page_scores = {SCOPE_PHASE_B: [], SCOPE_PHASE_C: []}
        for filename, spec in key.items():
            fmt, scope = spec["format"], spec["scope"]
            source = eval_dir / SOURCE_SUBDIR / filename
            expected_pages = {WHOLE_DOC_KEY: spec["whole_doc"]} if "whole_doc" in spec else \
                {int(p): e for p, e in spec["pages"].items()}
            doc_raw = raw.get(filename, {})
            for page_key, expect in expected_pages.items():
                if doc_raw.get("unsupported"):
                    page_scores[scope].append({**unsupported_score(expect), "doc": filename, "page": page_key, "unsupported": True})
                    continue
                saved = doc_raw.get("pages", {}).get(str(page_key))
                got = PageOutput(**saved) if saved else PageOutput()
                s = score_page(expect, got, reference_numbers_for(fmt, source, expect))
                s["text_possibly_truncated"] = len(got.text) == LEGACY_RAW_TEXT_CHARS
                page_scores[scope].append({**s, "doc": filename, "page": page_key})
        per_run.append({"phase_b": weighted(page_scores[SCOPE_PHASE_B]),
                        "phase_c_preview": weighted(page_scores[SCOPE_PHASE_C]), "pages": page_scores})
    return {"rescored_from": str(raw_path), "runs": per_run}


def print_summary(summary: dict) -> None:
    def fmt(v):
        return "—" if v is None else (f"{v:.2f}" if isinstance(v, float) else str(v))
    print("\nparser    scope     overall elements tbl_cells text  struct traps  unverified#  secs")
    for name, r in summary["parsers"].items():
        if not r.get("runs_completed"):
            print(f"{name:<9} no complete run ({r.get('stopped')})")
            continue
        for scope in ("phase_b", "phase_c_preview"):
            w = r[scope]
            print(f"{name:<9} {scope:<9} {fmt(w['overall']):>7} {fmt(w['elements']):>8} {fmt(w['table_cells']):>9} "
                  f"{fmt(w['text']):>5} {fmt(w['structure']):>6} {w['traps_passed']:>6} {w['unverified_numbers_total']:>11} "
                  f"{r['seconds_total'] if scope == 'phase_b' else '':>5}")
        print(f"{'':<9} runs={r['runs_completed']} overall_by_run={r['phase_b_overall_by_run']} "
              f"stdev={r['phase_b_overall_stdev']} cost=${r['cost_usd']}")
    print(f"TOTAL COST: ${summary['cost_usd_total']:.2f} of ${summary['budget_usd']:.2f} budget")


if __name__ == "__main__":
    cli = argparse.ArgumentParser(description=__doc__.split("\n")[1])
    cli.add_argument("--eval-dir", type=Path, default=DEFAULT_EVAL_DIR)
    cli.add_argument("--parsers", nargs="+", default=LOCAL_PARSERS, choices=list(PARSERS))
    cli.add_argument("--budget-usd", type=float, default=DEFAULT_BUDGET_USD)
    cli.add_argument("--rescore", type=Path, help="re-score a saved *_raw.json with no vendor calls")
    cli.add_argument("--pages", nargs="+", help='targeted re-test, e.g. "02_chai_ai.pdf:3,9" "09_slides.pdf:3,7"')
    cli.add_argument("--runs", type=int, help="override runs per parser")
    args = cli.parse_args()
    if args.rescore:
        result = rescore(args.eval_dir, args.rescore)
        out = args.rescore.with_name(args.rescore.stem.replace("_raw", "") + "_rescored.json")
        out.write_text(json.dumps(result, indent=1, default=str))
        for i, r in enumerate(result["runs"], 1):
            print(f"run {i}: phase_b overall={r['phase_b']['overall']:.3f}  phase_c overall={r['phase_c_preview']['overall']:.3f}  "
                  f"phase_c text={r['phase_c_preview']['text']}")
    else:
        print_summary(run(args.eval_dir, args.parsers, args.budget_usd, args.pages, args.runs))
