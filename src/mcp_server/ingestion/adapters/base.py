from abc import ABC, abstractmethod
from typing import List, Any, Optional
import os
import sys

sys.path.append(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
from ingestion_engine import IngestionEngine

class BaseAdapter(ABC):
    """Abstract Base Class for all CortexDrive Ingestion Adapters."""

    @abstractmethod
    def get_unprocessed_items(self) -> List[Any]:
        """Query the source to find items that haven't been ingested yet."""
        pass

    @abstractmethod
    def process_item(self, item: Any, engine: IngestionEngine):
        """Fetch the item's content and metadata, and pass to the IngestionEngine."""
        pass

    @abstractmethod
    def fetch(self, source_ref: str) -> str:
        """Fetch and extract raw content from a remote source reference (a URL,
        connection string, etc). Returns the extracted content as a string.

        Added for Phase A (documents/architecture/phase-a-web-url-adapter-design-2026-08-19.md)
        — the FETCH-from-remote shape the original pull-from-local-directory interface
        didn't have. LocalFileAdapter's implementation is a trivial degenerate case
        (reads the local file directly) since it already has its own file-reading logic
        in process_item(); it is not the primary way LocalFileAdapter is used."""
        pass

    @abstractmethod
    def has_changed(self, source_ref: str, last_known_hash: Optional[str]) -> bool:
        """Return True if the source's content differs from last_known_hash (or if
        last_known_hash is None — first fetch). Used to skip re-ingestion when content is
        unchanged (the Iceberg-style freshness layer — see SourceSnapshot in
        schema_guard.py). LocalFileAdapter's implementation is trivially True: its own
        get_unprocessed_items() already filters out already-ingested files by querying
        Neo4j for an existing Source node, so by the time has_changed() would be called
        the file is already known to be new — "a new file appeared" is the only case."""
        pass
