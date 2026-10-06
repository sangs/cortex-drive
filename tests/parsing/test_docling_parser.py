"""
Tests for the Phase B L1 parser (src/mcp_server/parsing/).

    .venv/bin/python -m unittest tests/parsing/test_docling_parser.py -v      # fast + integration
    RUN_SLOW_TESTS=1 .venv/bin/python -m unittest tests.parsing.test_docling_parser.FullManualTest -v

Integration tests use the parser-eval documents under documents/eval/ (git-ignored, local only)
and are skipped when those files aren't present. The fast tests need no Docling models.
"""
import io
import os
import sys
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.join(ROOT, "src", "mcp_server"))

from parsing.structure_parser import (  # noqa: E402
    MIME_DOCX, MIME_PDF, MIME_PPTX, ELEMENT_TYPE_HEADING, ELEMENT_TYPE_TABLE, VISUAL_ELEMENT_TYPES,
    UnsupportedFormatError,
)
from parsing.docling_parser import DoclingParser  # noqa: E402

EVAL_DOCS = os.path.join(ROOT, "documents", "eval", "parser-eval-2026-09-30", "source_docs")
HAVE_EVAL_DOCS = os.path.isdir(EVAL_DOCS)
RUN_SLOW = os.environ.get("RUN_SLOW_TESTS") == "1"


def _blank_pdf(pages: int) -> bytes:
    import pypdfium2
    pdf = pypdfium2.PdfDocument.new()
    for _ in range(pages):
        pdf.new_page(595, 842)
    buf = io.BytesIO()
    pdf.save(buf)
    pdf.close()
    return buf.getvalue()


class _FakeDocument:
    pages = {}

    def iterate_items(self, **_kwargs):
        return iter(())


class _RecordingConverter:
    """Stands in for Docling's DocumentConverter: records the page ranges requested."""

    def __init__(self):
        self.ranges = []

    def convert(self, _stream, page_range=None):
        self.ranges.append(page_range)

        class _Result:
            document = _FakeDocument()
        return _Result()


class ContractTest(unittest.TestCase):
    """Fast checks of the StructureParser contract; no Docling models are loaded."""

    def test_rejects_non_bytes_input(self):
        with self.assertRaises(TypeError):
            DoclingParser(converter=_RecordingConverter()).parse("https://example.com/a.pdf", MIME_PDF, "a.pdf")

    def test_rejects_unsupported_format(self):
        with self.assertRaises(UnsupportedFormatError):
            DoclingParser(converter=_RecordingConverter()).parse(b"hello", "text/plain", "a.txt")

    def test_page_windows_cover_every_page_exactly_once(self):
        conv = _RecordingConverter()
        DoclingParser(page_window=20, converter=conv).parse(_blank_pdf(45), MIME_PDF, "doc.pdf")
        self.assertEqual(conv.ranges, [(1, 20), (21, 40), (41, 45)])

    def test_page_range_is_clipped_and_windowed(self):
        conv = _RecordingConverter()
        doc = DoclingParser(page_window=2, converter=conv).parse(_blank_pdf(10), MIME_PDF, "doc.pdf",
                                                                page_range=(4, 99))
        self.assertEqual(conv.ranges, [(4, 5), (6, 7), (8, 9), (10, 10)])
        self.assertEqual(doc.page_count, 10)

    def test_block_types_match_schema(self):
        import schema_guard
        from parsing.structure_parser import ELEMENT_TYPES, VISUAL_ELEMENT_TYPES
        self.assertEqual(set(schema_guard.CONTENT_BLOCK_TYPES), set(ELEMENT_TYPES))
        self.assertEqual(set(schema_guard.VISUAL_CONTENT_BLOCK_TYPES), set(VISUAL_ELEMENT_TYPES))

    def test_non_paged_formats_use_a_single_conversion(self):
        conv = _RecordingConverter()
        DoclingParser(converter=conv).parse(b"PK fake docx", MIME_DOCX, "a.docx")
        self.assertEqual(conv.ranges, [None])


@unittest.skipUnless(HAVE_EVAL_DOCS, "parser-eval documents not present (documents/ is local only)")
class DoclingIntegrationTest(unittest.TestCase):
    """Real Docling on the eval documents (the same files the answer key covers)."""

    parser = None

    @classmethod
    def setUpClass(cls):
        cls.parser = DoclingParser()

    def _read(self, name):
        with open(os.path.join(EVAL_DOCS, name), "rb") as f:
            return f.read()

    def test_chart_page_has_visual_element_and_top_left_bboxes(self):
        doc = self.parser.parse(self._read("10_sherwood_article.pdf"), MIME_PDF, "sherwood.pdf")
        self.assertTrue(any(e.type in VISUAL_ELEMENT_TYPES for e in doc.elements), "the bar chart must be found")
        self.assertFalse(any(e.type == ELEMENT_TYPE_TABLE for e in doc.elements), "a chart must never become a table")
        text = " ".join(e.text for e in doc.elements)
        self.assertIn("most watched soccer match", text)
        width, height = doc.page_sizes[1]
        for e in doc.elements:
            self.assertEqual(e.page, 1)
            self.assertIsNotNone(e.bbox)
            self.assertLessEqual(e.bbox.y0, e.bbox.y1, "top-left origin: y0 above y1")
            self.assertTrue(0 <= e.bbox.x0 <= e.bbox.x1 <= width + 1)
            self.assertTrue(0 <= e.bbox.y0 <= e.bbox.y1 <= height + 1)

    def test_tables_are_read_cell_by_cell(self):
        # File page 3 = BERT paper page 7: Tables 2, 3 and 4.
        doc = self.parser.parse(self._read("11_bert_pages_3_6_7.pdf"), MIME_PDF, "bert.pdf", page_range=(3, 3))
        tables = [e for e in doc.elements if e.type == ELEMENT_TYPE_TABLE]
        self.assertEqual(len(tables), 3)
        cells = [c for t in tables for row in t.cells for c in row]
        self.assertIn("86.6", cells)

    def test_page_windows_keep_absolute_pages_and_continuous_sections(self):
        # C-DAD manual pages 19–23 in windows of 2: (19,20) (21,22) (23,23).
        doc = DoclingParser(page_window=2).parse(self._read("04_manual.pdf"), MIME_PDF, "manual.pdf",
                                                 page_range=(19, 23))
        self.assertEqual({e.page for e in doc.elements}, {19, 20, 21, 22, 23})
        self.assertEqual(doc.page_count, 242)
        first_window_tail = [e for e in doc.elements if e.page == 20]
        second_window_head = [e for e in doc.elements if e.page == 21]
        self.assertTrue(first_window_tail and second_window_head)
        # Sections carry across windows: page 21 content without its own heading keeps the earlier path.
        self.assertTrue(any(e.section_path for e in second_window_head))

    def test_docx_has_headings_and_no_pages(self):
        doc = self.parser.parse(self._read("08_gradle.docx"), MIME_DOCX, "gradle.docx")
        headings = [e for e in doc.elements if e.type == ELEMENT_TYPE_HEADING]
        self.assertTrue(3 <= len(headings) <= 4, f"expected 3–4 headings (not 322 'Subtitle' lines), got {len(headings)}")
        self.assertTrue(all(e.page is None and e.bbox is None for e in doc.elements))
        self.assertFalse(any(e.type == ELEMENT_TYPE_TABLE for e in doc.elements))

    def test_pptx_slides_are_pages(self):
        doc = self.parser.parse(self._read("09_slides.pptx"), MIME_PPTX, "slides.pptx")
        pages = {e.page for e in doc.elements}
        self.assertTrue(pages and None not in pages, "every slide element carries its slide number")
        self.assertEqual(max(pages), 10)
        self.assertTrue(all(e.bbox is not None for e in doc.elements))
        self.assertIn("Platform tools", " ".join(e.text for e in doc.elements))


@unittest.skipUnless(HAVE_EVAL_DOCS and RUN_SLOW, "slow: set RUN_SLOW_TESTS=1 (about 30 min on CPU)")
class FullManualTest(unittest.TestCase):
    def test_full_242_page_manual(self):
        with open(os.path.join(EVAL_DOCS, "04_manual.pdf"), "rb") as f:
            doc = DoclingParser().parse(f.read(), MIME_PDF, "manual.pdf")
        pages = {e.page for e in doc.elements}
        self.assertEqual(doc.page_count, 242)
        self.assertGreaterEqual(len(pages), 230, "nearly every page should yield elements")
        self.assertTrue(any(e.type in VISUAL_ELEMENT_TYPES for e in doc.elements))


if __name__ == "__main__":
    unittest.main()
