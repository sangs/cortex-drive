from abc import ABC, abstractmethod
from typing import List, Any
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
