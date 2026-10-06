"""
DoclingParser — the default L1 StructureParser (Phase B M1).

Chosen by the 2026-09-30 → 10-01 parser eval (Docling 0.85 on PDF pages, 9/9 "not a table" traps,
0.99 OCR on the scanned page; documents/eval/parser-eval-2026-09-30/results/SUMMARY-final-2026-10-01.md).
Runs only inside the async ingestion worker, never in cortex-mcp (decisions P4/P5, 2026-10-06);
its dependency lives in requirements-worker.txt.

Size-agnostic: PDFs are converted in page windows of DOCLING_PAGE_WINDOW pages, so a 242-page
manual and a 2-page note go through the same code with bounded memory. Docling keeps absolute
page numbers when given a page range (verified 2026-10-06), and the heading stack is carried
across windows so section paths stay continuous.
"""
import io
from typing import Dict, List, Optional, Tuple

from parsing.structure_parser import (
    MIME_DOCX, MIME_PDF, MIME_PPTX,
    ELEMENT_TYPE_CAPTION, ELEMENT_TYPE_CHART, ELEMENT_TYPE_CHECKBOX, ELEMENT_TYPE_CODE,
    ELEMENT_TYPE_FIGURE, ELEMENT_TYPE_FOOTNOTE, ELEMENT_TYPE_FORMULA, ELEMENT_TYPE_HEADING,
    ELEMENT_TYPE_LIST_ITEM, ELEMENT_TYPE_PARAGRAPH, ELEMENT_TYPE_TABLE,
    BBox, Element, ParsedDocument, StructureParser, UnsupportedFormatError,
)

# Pages converted per Docling call for PDFs. Bounds memory on large documents; about 7 s/page on
# CPU (measured 2026-10-06), so one window is roughly 2–3 minutes of work.
DOCLING_PAGE_WINDOW = 20
# Docling's 1-based title level; section headers start at 1.
TITLE_HEADING_LEVEL = 0

# Docling item label → our element type. Labels not listed here are skipped.
DOCLING_LABEL_TO_TYPE = {
    "title": ELEMENT_TYPE_HEADING,
    "section_header": ELEMENT_TYPE_HEADING,
    "text": ELEMENT_TYPE_PARAGRAPH,
    "paragraph": ELEMENT_TYPE_PARAGRAPH,
    "reference": ELEMENT_TYPE_PARAGRAPH,
    "list_item": ELEMENT_TYPE_LIST_ITEM,
    "table": ELEMENT_TYPE_TABLE,
    "picture": ELEMENT_TYPE_FIGURE,
    "chart": ELEMENT_TYPE_CHART,
    "caption": ELEMENT_TYPE_CAPTION,
    "code": ELEMENT_TYPE_CODE,
    "formula": ELEMENT_TYPE_FORMULA,
    "footnote": ELEMENT_TYPE_FOOTNOTE,
    "checkbox_selected": ELEMENT_TYPE_CHECKBOX,
    "checkbox_unselected": ELEMENT_TYPE_CHECKBOX,
}
CHECKED_LABELS = frozenset({"checkbox_selected"})
FIGURE_LABELS = frozenset({"picture", "chart"})
# Formats other than PDF whose elements still carry a page (slide) number and bbox.
PAGED_NON_PDF_MIME_TYPES = frozenset({MIME_PPTX})


class DoclingParser(StructureParser):
    name = "docling"
    supported_mime_types = frozenset({MIME_PDF, MIME_DOCX, MIME_PPTX})

    def __init__(self, page_window: int = DOCLING_PAGE_WINDOW, converter=None):
        if page_window < 1:
            raise ValueError("page_window must be >= 1")
        self.page_window = page_window
        self._converter = converter          # injectable for tests; created lazily otherwise

    @property
    def converter(self):
        if self._converter is None:
            from docling.document_converter import DocumentConverter
            self._converter = DocumentConverter()
        return self._converter

    # ------------------------------------------------------------------ public API

    def parse(self, data: bytes, mime_type: str, filename: str,
              page_range: Optional[Tuple[int, int]] = None) -> ParsedDocument:
        if not isinstance(data, (bytes, bytearray)):
            raise TypeError("DoclingParser.parse() takes document bytes; adapters fetch, parsers never do")
        if not self.supports(mime_type):
            raise UnsupportedFormatError(f"{self.name} can't parse {mime_type!r}")

        heading_stack: List[Tuple[int, str]] = []
        elements: List[Element] = []
        page_sizes: Dict[int, Tuple[float, float]] = {}

        if mime_type != MIME_PDF:
            # DOCX has no fixed pages; PPTX slides are pages (slide number = page). Neither is windowed.
            paged = mime_type in PAGED_NON_PDF_MIME_TYPES
            document = self._convert(data, filename, None)
            elements.extend(self._elements(document, heading_stack, page_sizes, paged=paged))
            return ParsedDocument(elements=elements, mime_type=mime_type,
                                  page_count=len(page_sizes) or None, page_sizes=page_sizes)

        page_count = self._pdf_page_count(data)
        first, last = page_range if page_range else (1, page_count)
        first, last = max(1, first), min(page_count, last)
        for start in range(first, last + 1, self.page_window):
            end = min(start + self.page_window - 1, last)
            document = self._convert(data, filename, (start, end))
            elements.extend(self._elements(document, heading_stack, page_sizes, paged=True))
        return ParsedDocument(elements=elements, mime_type=mime_type,
                              page_count=page_count, page_sizes=page_sizes)

    # ------------------------------------------------------------------ internals

    def _convert(self, data: bytes, filename: str, page_range: Optional[Tuple[int, int]]):
        from docling_core.types.io import DocumentStream
        stream = DocumentStream(name=filename, stream=io.BytesIO(bytes(data)))
        if page_range:
            return self.converter.convert(stream, page_range=page_range).document
        return self.converter.convert(stream).document

    @staticmethod
    def _pdf_page_count(data: bytes) -> int:
        import pypdfium2                      # installed with Docling
        pdf = pypdfium2.PdfDocument(bytes(data))
        try:
            return len(pdf)
        finally:
            pdf.close()

    def _elements(self, document, heading_stack, page_sizes, paged: bool) -> List[Element]:
        for page_no, page in document.pages.items():
            if page.size is not None:
                page_sizes[page_no] = (page.size.width, page.size.height)

        out: List[Element] = []
        for item, _level in document.iterate_items():          # body layer; furniture (headers/footers) excluded
            label = getattr(getattr(item, "label", None), "value", "")
            element_type = DOCLING_LABEL_TO_TYPE.get(label)
            if element_type is None:
                continue
            page, bbox = self._location(document, item) if paged else (None, None)
            text = (getattr(item, "text", "") or "").strip()
            element = Element(type=element_type, text=text, page=page, bbox=bbox)

            if element_type == ELEMENT_TYPE_HEADING:
                level = TITLE_HEADING_LEVEL if label == "title" else int(getattr(item, "level", 1) or 1)
                while heading_stack and heading_stack[-1][0] >= level:
                    heading_stack.pop()
                heading_stack.append((level, text))
                element.heading_level = level
            elif element_type == ELEMENT_TYPE_TABLE:
                element.cells = self._table_cells(document, item)
                element.text = item.export_to_markdown(doc=document)
            elif label in FIGURE_LABELS:
                element.text = self._figure_text(document, item)
            elif element_type == ELEMENT_TYPE_CHECKBOX:
                element.checked = label in CHECKED_LABELS

            element.section_path = tuple(t for _, t in heading_stack)
            out.append(element)
        return out

    @staticmethod
    def _location(document, item) -> Tuple[Optional[int], Optional[BBox]]:
        prov = getattr(item, "prov", None)
        if not prov:
            return None, None
        page_no = prov[0].page_no
        page = document.pages.get(page_no)
        if page is None or page.size is None:
            return page_no, None
        box = prov[0].bbox.to_top_left_origin(page_height=page.size.height)
        return page_no, BBox(x0=box.l, y0=box.t, x1=box.r, y1=box.b)

    @staticmethod
    def _table_cells(document, item) -> List[List[str]]:
        frame = item.export_to_dataframe(doc=document)
        return [[str(c) for c in frame.columns]] + [[str(v) for v in row] for row in frame.values.tolist()]

    @staticmethod
    def _figure_text(document, item) -> str:
        """Caption plus any text Docling read inside the figure (labels, OCR'd chart text).
        This text stays on the figure element; L2 adds the description later (derived_by: vlm)."""
        parts = []
        caption = (item.caption_text(document) or "").strip()
        if caption:
            parts.append(caption)
        for child, _ in document.iterate_items(root=item, traverse_pictures=True):
            if child is item:
                continue
            text = (getattr(child, "text", "") or "").strip()
            if text and text != caption:
                parts.append(text)
        return "\n".join(parts)
