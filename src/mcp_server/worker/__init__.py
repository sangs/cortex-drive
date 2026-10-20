"""Phase B ingestion worker (M3'). Runs as a Cloud Run job under the cortex-mcp-worker identity
(decision P1); cortex-mcp only validates and enqueues (decision P4). Keep this package's import
light: cortex-mcp imports worker.status and worker.enqueue, which must not pull in Docling."""
