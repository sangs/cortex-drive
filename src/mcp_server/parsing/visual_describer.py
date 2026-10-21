"""L2 VisualDescriber: describes figure crops (Phase B M3', synchronous path).
Design: documents/architecture/multimodal-document-processing-pipeline-2026-08-19.md §2 (step 5) and
federated-retrieval-and-freshness-design-2026-09-29.md §1.3.8 (two-speed ingestion). The batch path
(Message Batches, 50% off) is M4' and reuses describe()'s request shape.

Swappable by design (decision: "keep the parsing engine swappable"): callers depend on the
VisualDescriber interface; ClaudeVisualDescriber is the default, Gemini is the documented swap.

Credentials (documents/architecture/anthropic-workload-identity-federation-setup-2026-09-25.md):
  - On Cloud Run (service or job): Workload Identity Federation ONLY, with an identity token from the
    metadata server. A static ANTHROPIC_API_KEY is refused there (WIF task 9's rule).
  - Locally: gcloud impersonation of the worker service account (needs the temporary grant in
    WIF doc §2.2), or an ANTHROPIC_API_KEY ONLY with the explicit opt-in
    CORTEX_L2_ALLOW_LOCAL_API_KEY=true (WIF task 8). An ambient key (e.g. the one a coding-agent
    session runs with) is never picked up silently: found 2026-10-08, it billed the wrong workspace.
    With neither, no describer is built and figures stay description_status=pending.
"""
import base64
import io
import json
import os
import subprocess
import sys
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import List, Optional

sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from schema_guard import (  # noqa: E402
    DOCUMENT_FIGURE_CROP_MARGIN_POINTS, DOCUMENT_FIGURE_RENDER_SCALE, VISUAL_DESCRIBER_EFFORT,
    VISUAL_DESCRIBER_MAX_OUTPUT_TOKENS, VISUAL_DESCRIBER_MAX_RETRIES, VISUAL_DESCRIBER_MODEL,
    VISUAL_DESCRIBER_TIMEOUT_SECONDS,
)

ANTHROPIC_AUDIENCE = "https://api.anthropic.com"
METADATA_IDENTITY_URL = "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity"
# Non-secret WIF identifiers (task 7): set with --set-env-vars, never --set-secrets.
WIF_ENV_VARS = ("ANTHROPIC_FEDERATION_RULE_ID", "ANTHROPIC_ORGANIZATION_ID",
                "ANTHROPIC_SERVICE_ACCOUNT_ID", "ANTHROPIC_WORKSPACE_ID")
WIF_LOCAL_IMPERSONATE_ENV = "ANTHROPIC_WIF_IMPERSONATE"   # local only: SA email to impersonate
LOCAL_API_KEY_OPT_IN_ENV = "CORTEX_L2_ALLOW_LOCAL_API_KEY"   # local only: "true" to use ANTHROPIC_API_KEY
FIGURE_KINDS = ["chart", "diagram", "photo", "table_image", "other"]
DECORATIVE_DESCRIPTION = "decorative"
PROMPT_PATH = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))),
                           "prompts", "document_figure_describer.md")

FIGURE_SCHEMA = {
    "type": "object", "additionalProperties": False,
    "required": ["kind", "title", "visible_text", "description"],
    "properties": {
        "kind": {"type": "string", "enum": FIGURE_KINDS},
        "title": {"type": "string"},
        "visible_text": {"type": "array", "items": {"type": "string"}},
        "description": {"type": "string"},
    },
}


@dataclass
class FigureDescription:
    kind: str
    title: str
    visible_text: List[str] = field(default_factory=list)
    description: str = ""

    @property
    def is_decorative(self) -> bool:
        return self.description.strip().lower() == DECORATIVE_DESCRIPTION

    def as_block_text(self) -> str:
        """The text stored on ContentBlock.description and embedded for search."""
        parts = [p for p in (self.title, self.description) if p]
        if self.visible_text:
            parts.append("Text in figure: " + " | ".join(self.visible_text))
        return "\n".join(parts)


class VisualDescriber(ABC):
    name = "base"

    @abstractmethod
    def describe(self, image_png: bytes, *, section_path: List[str], figure_text: str) -> Optional[FigureDescription]:
        """Describe one figure image. None on refusal or an unusable response (never raises for those)."""


def render_pdf_figure(pdf_bytes: bytes, page: int, bbox: List[float],
                      page_size: Optional[tuple] = None) -> bytes:
    """PNG crop of a figure from a PDF. `bbox` is [x0, y0, x1, y1] in points, top-left origin
    (the L1 parser's convention); `page` is 1-based."""
    import pypdfium2 as pdfium
    pdf = pdfium.PdfDocument(pdf_bytes)
    try:
        pg = pdf[page - 1]
        width, height = page_size or pg.get_size()
        m = DOCUMENT_FIGURE_CROP_MARGIN_POINTS
        x0, y0, x1, y1 = (max(bbox[0] - m, 0), max(bbox[1] - m, 0), min(bbox[2] + m, width), min(bbox[3] + m, height))
        # pypdfium2 crops are amounts to remove from (left, bottom, right, top).
        bitmap = pg.render(scale=DOCUMENT_FIGURE_RENDER_SCALE, crop=(x0, height - y1, width - x1, y0))
        out = io.BytesIO()
        bitmap.to_pil().save(out, format="PNG")
        return out.getvalue()
    finally:
        pdf.close()


def on_cloud_run() -> bool:
    return bool(os.environ.get("K_SERVICE") or os.environ.get("CLOUD_RUN_JOB"))


class ClaudeVisualDescriber(VisualDescriber):
    name = "claude"

    def __init__(self, client=None):
        self.client = client or self._build_client()
        with open(PROMPT_PATH, encoding="utf-8") as f:
            self.prompt_template = f.read()
        self.input_tokens = 0
        self.output_tokens = 0

    @staticmethod
    def _metadata_identity_token() -> str:
        import httpx
        resp = httpx.get(METADATA_IDENTITY_URL, params={"audience": ANTHROPIC_AUDIENCE, "format": "full"},
                         headers={"Metadata-Flavor": "Google"}, timeout=10.0)
        resp.raise_for_status()
        return resp.text.strip()

    @staticmethod
    def _impersonated_identity_token() -> str:
        return subprocess.run(
            ["gcloud", "auth", "print-identity-token",
             f"--impersonate-service-account={os.environ[WIF_LOCAL_IMPERSONATE_ENV]}",
             f"--audiences={ANTHROPIC_AUDIENCE}", "--include-email"],
            capture_output=True, text=True, check=True).stdout.strip()

    @classmethod
    def _build_client(cls):
        from anthropic import Anthropic, WorkloadIdentityCredentials
        common = dict(timeout=VISUAL_DESCRIBER_TIMEOUT_SECONDS, max_retries=VISUAL_DESCRIBER_MAX_RETRIES)
        if on_cloud_run():
            if os.environ.get("ANTHROPIC_API_KEY"):
                raise RuntimeError("ANTHROPIC_API_KEY must not be set on Cloud Run; WIF only (WIF task 9).")
            provider = cls._metadata_identity_token
        elif os.environ.get(WIF_LOCAL_IMPERSONATE_ENV):
            provider = cls._impersonated_identity_token
        elif cls._local_api_key_opted_in():
            return Anthropic(**common)          # local only, explicit opt-in (WIF task 8)
        else:
            raise RuntimeError("No L2 credentials: set up WIF impersonation, or opt in to a local API key "
                               f"with {LOCAL_API_KEY_OPT_IN_ENV}=true.")
        missing = [v for v in WIF_ENV_VARS if not os.environ.get(v)]
        if missing:
            raise RuntimeError(f"WIF identifiers missing: {', '.join(missing)}")
        return Anthropic(credentials=WorkloadIdentityCredentials(
            identity_token_provider=provider,
            federation_rule_id=os.environ["ANTHROPIC_FEDERATION_RULE_ID"],
            organization_id=os.environ["ANTHROPIC_ORGANIZATION_ID"],
            service_account_id=os.environ["ANTHROPIC_SERVICE_ACCOUNT_ID"],
            workspace_id=os.environ["ANTHROPIC_WORKSPACE_ID"],
        ), **common)

    @staticmethod
    def _local_api_key_opted_in() -> bool:
        return os.environ.get(LOCAL_API_KEY_OPT_IN_ENV, "").lower() == "true" and bool(os.environ.get("ANTHROPIC_API_KEY"))

    @staticmethod
    def available() -> bool:
        """True when some credential path is configured (see the module docstring)."""
        if on_cloud_run():
            return all(os.environ.get(v) for v in WIF_ENV_VARS)
        if os.environ.get(WIF_LOCAL_IMPERSONATE_ENV):
            return all(os.environ.get(v) for v in WIF_ENV_VARS)
        return ClaudeVisualDescriber._local_api_key_opted_in()

    def request_params(self, image_png: bytes, *, section_path: List[str], figure_text: str) -> dict:
        """The Messages API request for one figure: used as-is by describe() (synchronous) and as
        the `params` of each Message Batch request (M4'), so both paths send identical requests."""
        prompt = (self.prompt_template
                  .replace("{section_path}", " > ".join(section_path) or "(document root)")
                  .replace("{figure_text}", figure_text or ""))
        return dict(
            model=VISUAL_DESCRIBER_MODEL, max_tokens=VISUAL_DESCRIBER_MAX_OUTPUT_TOKENS,
            output_config={"effort": VISUAL_DESCRIBER_EFFORT, "format": {"type": "json_schema", "schema": FIGURE_SCHEMA}},
            messages=[{"role": "user", "content": [
                {"type": "image", "source": {"type": "base64", "media_type": "image/png",
                                             "data": base64.standard_b64encode(image_png).decode()}},
                {"type": "text", "text": prompt}]}],
        )

    @staticmethod
    def parse_message(message) -> Optional[FigureDescription]:
        """A Messages API response → FigureDescription; None on refusal, truncation or bad JSON."""
        if message.stop_reason in ("refusal", "max_tokens"):
            return None
        text = "".join(b.text for b in message.content if b.type == "text")
        try:
            data = json.loads(text)
        except json.JSONDecodeError:
            return None
        return FigureDescription(kind=data.get("kind", "other"), title=data.get("title", ""),
                                 visible_text=list(data.get("visible_text", [])),
                                 description=data.get("description", ""))

    def describe(self, image_png: bytes, *, section_path: List[str], figure_text: str) -> Optional[FigureDescription]:
        message = self.client.messages.create(
            **self.request_params(image_png, section_path=section_path, figure_text=figure_text))
        self.input_tokens += message.usage.input_tokens
        self.output_tokens += message.usage.output_tokens
        return self.parse_message(message)

    # ---- Message Batches (M4', 50% price; results within 24 h, kept 29 days) -------------------------

    def submit_batch(self, requests: List[tuple]) -> str:
        """requests: [(custom_id, params)], custom_id = the figure block's node_id. Returns the batch id."""
        batch = self.client.messages.batches.create(
            requests=[{"custom_id": cid, "params": params} for cid, params in requests])
        return batch.id

    def batch_status(self, batch_id: str) -> dict:
        b = self.client.messages.batches.retrieve(batch_id)
        c = b.request_counts
        return {"processing_status": b.processing_status, "succeeded": c.succeeded, "errored": c.errored,
                "expired": c.expired, "canceled": c.canceled, "processing": c.processing}

    def batch_results(self, batch_id: str):
        """Yields (custom_id, FigureDescription | None, result_type, input_tokens, output_tokens).
        result_type: succeeded | errored | expired | canceled."""
        for item in self.client.messages.batches.results(batch_id):
            kind = item.result.type
            if kind == "succeeded":
                message = item.result.message
                yield (item.custom_id, self.parse_message(message), kind,
                       message.usage.input_tokens, message.usage.output_tokens)
            else:
                yield item.custom_id, None, kind, 0, 0
