"""
One-off comparison test for Phase B's document-parsing vendor decision.
NOT part of the production ingestion pipeline (ingestion_engine.py / adapters) — a standalone
script per documents/architecture/document-ingestion-comparison-test-plan-2026-09-22.md, which
this script implements.

4 candidates: Claude native PDF endpoint (via WIF impersonation, no static key), Gemini 3 Pro
(via Vertex AI, existing GCP project), LlamaParse+gpt-4o, dots.mocr (via a paid HF Inference
Endpoint, provisioned separately — see scripts/_provision_dots_mocr_endpoint.py).

Same PDF artifact used for both phases and across all 4 candidates for direct comparability
(Phase 1: rendered Wikipedia "Moore's law" page; Phase 2: the user's Google Drive PDF).
"""
import base64
import json
import subprocess
import time
from dataclasses import dataclass, asdict
from pathlib import Path

import os
from dotenv import load_dotenv

load_dotenv(".env")

TEST_DIR = Path("/tmp/vendor_compare_test")

EXTRACTION_PROMPT = """Analyze this document and report, in this exact structure:

1. TEXT SUMMARY: A brief summary of the main textual content (2-4 sentences).
2. DIAGRAMS: List each diagram found, with a description of what it shows. If none, say "None found."
3. CHARTS: List each chart found, describe its type (line/bar/scatter/etc) and the key data/trend it shows. If none, say "None found."
4. TABLES: List each table found, including its column headers and a sample of its data (first few rows). If none, say "None found."
5. AUDIO/VIDEO: State yes/no whether any embedded audio or video content is detected (not transcribed, just detected).

Be specific and reference actual content you can see in the document — do not guess or hallucinate content that isn't there."""


@dataclass
class VendorResult:
    candidate: str
    phase: str
    raw_output: str = ""
    latency_seconds: float = 0.0
    cost_note: str = ""
    error: str = ""


def save_result(result: VendorResult) -> None:
    out_path = TEST_DIR / f"{result.candidate}__{result.phase}.json"
    out_path.write_text(json.dumps(asdict(result), indent=2))
    status = "ERROR" if result.error else "OK"
    print(f"[{status}] {result.candidate} / {result.phase} -> {out_path} ({result.latency_seconds:.1f}s)")


# ---------------------------------------------------------------------------
# Claude native PDF endpoint — via WIF impersonation, no static ANTHROPIC_API_KEY.
# Requires roles/iam.serviceAccountTokenCreator on cortex-mcp-worker granted to the
# operator's own gcloud identity for the duration of this test (see the plan's Step 2 note).
# ---------------------------------------------------------------------------

def _claude_identity_token() -> str:
    result = subprocess.run(
        [
            "gcloud", "auth", "print-identity-token",
            "--impersonate-service-account=cortex-mcp-worker@cortex-drive-496915.iam.gserviceaccount.com",
            "--audiences=https://api.anthropic.com",
            "--include-email",
        ],
        capture_output=True, text=True, check=True,
    )
    return result.stdout.strip()


def run_claude(pdf_path: Path, phase: str) -> VendorResult:
    from anthropic import Anthropic, WorkloadIdentityCredentials

    client = Anthropic(
        credentials=WorkloadIdentityCredentials(
            identity_token_provider=_claude_identity_token,
            federation_rule_id="fdrl_01N1X4hshN918sM4c612aiys",
            organization_id="dadbadf4-d114-46f7-aeda-7df9ffe82a40",
            service_account_id="svac_01CZuaCMKodSs6C83o8R5MUX",
            workspace_id="wrkspc_01BWWNZfUikYXfLwu3uCec43",
        ),
    )
    pdf_b64 = base64.standard_b64encode(pdf_path.read_bytes()).decode()

    start = time.time()
    try:
        message = client.messages.create(
            model="claude-opus-5",
            max_tokens=4096,
            messages=[{
                "role": "user",
                "content": [
                    {"type": "document", "source": {"type": "base64", "media_type": "application/pdf", "data": pdf_b64}},
                    {"type": "text", "text": EXTRACTION_PROMPT},
                ],
            }],
        )
        latency = time.time() - start
        text = "".join(b.text for b in message.content if b.type == "text")
        u = message.usage
        return VendorResult(
            candidate="claude_native_pdf", phase=phase, raw_output=text, latency_seconds=latency,
            cost_note=f"input_tokens={u.input_tokens} output_tokens={u.output_tokens}",
        )
    except Exception as e:
        return VendorResult(candidate="claude_native_pdf", phase=phase, error=str(e), latency_seconds=time.time() - start)


# ---------------------------------------------------------------------------
# Gemini 3 Pro — via Vertex AI on the existing cortex-drive-496915 project, ADC auth.
# ---------------------------------------------------------------------------

def run_gemini(pdf_path: Path, phase: str) -> VendorResult:
    from google import genai
    from google.genai import types

    client = genai.Client(vertexai=True, project="cortex-drive-496915", location="global")
    pdf_bytes = pdf_path.read_bytes()

    start = time.time()
    try:
        response = client.models.generate_content(
            model="gemini-3.1-pro-preview",
            contents=[
                types.Part.from_bytes(data=pdf_bytes, mime_type="application/pdf"),
                EXTRACTION_PROMPT,
            ],
        )
        latency = time.time() - start
        usage = response.usage_metadata
        return VendorResult(
            candidate="gemini_3_pro", phase=phase, raw_output=response.text, latency_seconds=latency,
            cost_note=f"prompt_tokens={usage.prompt_token_count} candidates_tokens={usage.candidates_token_count}",
        )
    except Exception as e:
        return VendorResult(candidate="gemini_3_pro", phase=phase, error=str(e), latency_seconds=time.time() - start)


# ---------------------------------------------------------------------------
# LlamaParse + gpt-4o — structural extraction (LlamaParse) + a vision pass on the
# rendered page image (gpt-4o) for diagram/chart interpretation, matching this repo's
# existing two-stage Phase B design (multimodal-document-processing-pipeline-2026-08-19.md).
# ---------------------------------------------------------------------------

def _image_content_blocks(page_image_paths: list[Path]) -> list[dict]:
    blocks = []
    for p in page_image_paths:
        img_b64 = base64.standard_b64encode(p.read_bytes()).decode()
        blocks.append({"type": "image_url", "image_url": {"url": f"data:image/png;base64,{img_b64}"}})
    return blocks


def run_llamaparse(pdf_path: Path, phase: str, page_image_paths: list[Path] | None = None) -> VendorResult:
    from llama_cloud_services import LlamaParse
    from openai import OpenAI

    start = time.time()
    try:
        parser = LlamaParse(api_key=os.environ["LLAMA_CLOUD_API_KEY"], result_type="markdown")
        result = parser.parse(str(pdf_path))
        markdown = result.get_markdown()
        if isinstance(markdown, list):
            markdown = "\n\n---\n\n".join(markdown)

        vision_note = ""
        if page_image_paths:
            openai_client = OpenAI(api_key=os.environ["OPENAI_API_KEY"])
            content = [{"type": "text", "text": "Describe any diagrams or charts visible in these page images, focused specifically on visual/graphical elements (not body text)."}]
            content.extend(_image_content_blocks(page_image_paths))
            vision_resp = openai_client.chat.completions.create(
                model="gpt-4o",
                messages=[{"role": "user", "content": content}],
                max_tokens=1024,
            )
            vision_note = vision_resp.choices[0].message.content

        latency = time.time() - start
        combined = f"=== LlamaParse structural extraction ===\n{markdown}\n\n=== gpt-4o vision pass (diagrams/charts) ===\n{vision_note}"
        return VendorResult(
            candidate="llamaparse_gpt4o", phase=phase, raw_output=combined, latency_seconds=latency,
            cost_note=f"job_id={result.job_id} status={result.status}",
        )
    except Exception as e:
        return VendorResult(candidate="llamaparse_gpt4o", phase=phase, error=str(e), latency_seconds=time.time() - start)


# ---------------------------------------------------------------------------
# dots.mocr — via the provisioned HF Inference Endpoint's OpenAI-compatible API.
# ---------------------------------------------------------------------------

def run_dots_mocr(pdf_path: Path, phase: str, endpoint_url: str, page_image_paths: list[Path]) -> VendorResult:
    from openai import OpenAI

    client = OpenAI(base_url=f"{endpoint_url}/v1", api_key=os.environ["HF_RUNTIME_TOKEN"])
    content = [{"type": "text", "text": EXTRACTION_PROMPT}]
    content.extend(_image_content_blocks(page_image_paths))

    start = time.time()
    try:
        response = client.chat.completions.create(
            model="dots-studio/dots.mocr",
            messages=[{"role": "user", "content": content}],
            max_tokens=4096,
        )
        latency = time.time() - start
        text = response.choices[0].message.content
        return VendorResult(candidate="dots_mocr", phase=phase, raw_output=text, latency_seconds=latency,
                             cost_note="HF Inference Endpoint, nvidia-l4, ~$0.80/hr while running")
    except Exception as e:
        return VendorResult(candidate="dots_mocr", phase=phase, error=str(e), latency_seconds=time.time() - start)


MAX_VISION_PAGES = 8  # representative subset for vision-only candidates; Claude/Gemini get the full PDF natively


if __name__ == "__main__":
    import sys

    phase = sys.argv[1] if len(sys.argv) > 1 else "phase1_website"
    candidates = sys.argv[2:] if len(sys.argv) > 2 else ["claude", "gemini", "llamaparse"]

    doc_name = "moores_law" if phase == "phase1_website" else "drive_doc"
    pdf_path = TEST_DIR / f"{doc_name}.pdf"
    pages_dir = TEST_DIR / f"{doc_name}_pages"
    page_images = sorted(pages_dir.glob("page_*.png"), key=lambda p: int(p.stem.split("_")[1]))[:MAX_VISION_PAGES]

    if "claude" in candidates:
        save_result(run_claude(pdf_path, phase))
    if "gemini" in candidates:
        save_result(run_gemini(pdf_path, phase))
    if "llamaparse" in candidates:
        save_result(run_llamaparse(pdf_path, phase, page_images))
    if "dots_mocr" in candidates:
        endpoint_url = os.environ.get("DOTS_MOCR_ENDPOINT_URL")
        if not endpoint_url:
            print("DOTS_MOCR_ENDPOINT_URL not set, skipping dots_mocr")
        else:
            save_result(run_dots_mocr(pdf_path, phase, endpoint_url, page_images))
