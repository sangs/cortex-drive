"""
L1 StructureParser interface for Phase B document ingestion.

The parser is the deterministic layer of the three-layer pipeline (L1 structure → L2 visual
describer → L3 BAML entities): bytes in, typed elements with page + bbox out, no LLM calls.
Implementations are swappable per tenant from config (Docling today; Document AI is the
managed fallback). Design: documents/architecture/federated-retrieval-and-freshness-design-2026-09-29.md
§1.3.1/§1.3.7 and multimodal-document-processing-pipeline-2026-08-19.md §2/§9.

Contract (relied on by IngestionEngine.process_document_source() in Phase B M2):
- Input is always BYTES. A parser never fetches a URL: source adapters fetch through the
  SSRF guard (validate_public_url) and hand over the bytes.
- Every element carries its 1-based page number and a top-left-origin bbox in points
  when the format has pages (PDF pages, PPTX slides); formats without fixed pages (DOCX)
  leave both None.
- Charts stay charts. A parser must never turn a chart into a table (Invariant 11; the
  2026-09-28 LlamaParse fabrication finding).
"""
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Tuple

# Element types every StructureParser emits. ContentBlock.type (M2) uses the same vocabulary.
ELEMENT_TYPE_HEADING = "heading"
ELEMENT_TYPE_PARAGRAPH = "paragraph"
ELEMENT_TYPE_LIST_ITEM = "list_item"
ELEMENT_TYPE_TABLE = "table"
ELEMENT_TYPE_FIGURE = "figure"
ELEMENT_TYPE_CHART = "chart"
ELEMENT_TYPE_CAPTION = "caption"
ELEMENT_TYPE_CODE = "code"
ELEMENT_TYPE_FORMULA = "formula"
ELEMENT_TYPE_FOOTNOTE = "footnote"
ELEMENT_TYPE_CHECKBOX = "checkbox"

ELEMENT_TYPES = frozenset({
    ELEMENT_TYPE_HEADING, ELEMENT_TYPE_PARAGRAPH, ELEMENT_TYPE_LIST_ITEM, ELEMENT_TYPE_TABLE,
    ELEMENT_TYPE_FIGURE, ELEMENT_TYPE_CHART, ELEMENT_TYPE_CAPTION, ELEMENT_TYPE_CODE,
    ELEMENT_TYPE_FORMULA, ELEMENT_TYPE_FOOTNOTE, ELEMENT_TYPE_CHECKBOX,
})
# Elements the L2 visual describer receives (two-speed ingestion, design §1.3.8).
VISUAL_ELEMENT_TYPES = frozenset({ELEMENT_TYPE_FIGURE, ELEMENT_TYPE_CHART})

MIME_PDF = "application/pdf"
MIME_DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
MIME_PPTX = "application/vnd.openxmlformats-officedocument.presentationml.presentation"


class UnsupportedFormatError(ValueError):
    """The parser can't read this MIME type."""


@dataclass(frozen=True)
class BBox:
    """Top-left origin, PDF points: (x0, y0) is the top-left corner, (x1, y1) the bottom-right."""
    x0: float
    y0: float
    x1: float
    y1: float

    @property
    def area(self) -> float:
        return max(0.0, self.x1 - self.x0) * max(0.0, self.y1 - self.y0)


@dataclass
class Element:
    type: str
    text: str
    page: Optional[int]
    bbox: Optional[BBox]
    section_path: Tuple[str, ...] = ()
    heading_level: Optional[int] = None          # headings only (0 = document title)
    cells: Optional[List[List[str]]] = None      # tables only: header row first
    checked: Optional[bool] = None               # checkboxes / radio buttons only


@dataclass
class ParsedDocument:
    elements: List[Element]
    mime_type: str
    page_count: Optional[int] = None
    # {page_number: (width, height)} in PDF points; empty for formats without fixed pages.
    page_sizes: Dict[int, Tuple[float, float]] = field(default_factory=dict)

    def elements_on_page(self, page: int) -> List[Element]:
        return [e for e in self.elements if e.page == page]


class StructureParser(ABC):
    """Deterministic L1 parser: bytes → ParsedDocument. No network, no LLM."""

    name: str = ""
    supported_mime_types: frozenset = frozenset()

    def supports(self, mime_type: str) -> bool:
        return mime_type in self.supported_mime_types

    @abstractmethod
    def parse(self, data: bytes, mime_type: str, filename: str,
              page_range: Optional[Tuple[int, int]] = None) -> ParsedDocument:
        """Parse `data`. `page_range` (1-based, inclusive) limits paged formats to a slice."""
