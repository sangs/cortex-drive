import os
import json
import re
from typing import List
from neo4j import GraphDatabase
from .base import BaseAdapter
import sys

sys.path.append(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
from ingestion_engine import IngestionEngine

class LocalFileAdapter(BaseAdapter):
    """Adapter for ingesting local text transcripts from a directory."""
    
    def __init__(self, directory: str, uri: str, user: str, password: str, tenant_id: str):
        self.directory = directory
        self.tenant_id = tenant_id
        self.driver = GraphDatabase.driver(uri, auth=(user, password))
        
    def __del__(self):
        self.driver.close()

    def get_unprocessed_items(self) -> List[str]:
        if not os.path.exists(self.directory):
            print(f"Directory not found: {self.directory}")
            return []
            
        unprocessed = []
        with self.driver.session() as session:
            for filename in os.listdir(self.directory):
                if filename.endswith(".txt"):
                    # Check if this file exists in Neo4j for THIS tenant
                    query = "MATCH (s:Source {tenant_id: $tenant_id, fileName: $fileName}) RETURN count(s) as c"
                    count = session.run(query, tenant_id=self.tenant_id, fileName=filename).single()["c"]
                    
                    if count == 0:
                        unprocessed.append(os.path.join(self.directory, filename))
        return unprocessed

    def process_item(self, file_path: str, engine: IngestionEngine):
        filename = os.path.basename(file_path)
        base_name = os.path.splitext(filename)[0]
        
        # 1. Parsing Metadata
        json_path = os.path.join(os.path.dirname(file_path), f"{base_name}.json")
        
        metadata = {
            "source_type": "LocalFile",
            "fileName": filename,
            "fileSource": base_name
        }
        
        # Merge JSON metadata if perfectly adjacent
        if os.path.exists(json_path):
            try:
                with open(json_path, 'r', encoding='utf-8') as f:
                    data = json.load(f)
                    
                    def flatten_metadata(entry, target_meta):
                        # 1. Handle nested 'episode'
                        if 'episode' in entry and isinstance(entry['episode'], dict):
                            target_meta.update(entry['episode'])
                        
                        # 2. Handle nested 'podcast'
                        if 'podcast' in entry and isinstance(entry['podcast'], dict):
                            if 'title' in entry['podcast']:
                                target_meta['podcast_title'] = entry['podcast']['title']
                            if 'id' in entry['podcast']:
                                target_meta['podcast_id'] = entry['podcast']['id']
                        
                        # 3. Handle 'person' (extracting invoker/listener if present)
                        if 'person' in entry and isinstance(entry['person'], dict):
                            listeners = entry['person'].get('listeners', [])
                            if listeners and isinstance(listeners, list):
                                target_meta['invoked_by'] = listeners[0].get('name')

                        # 4. Fallback: Update with any other top-level keys (skipping dicts we flattened)
                        for k, v in entry.items():
                            if k not in ['episode', 'podcast', 'person'] and not isinstance(v, (dict, list)):
                                target_meta[k] = v

                    if isinstance(data, dict):
                        flatten_metadata(data, metadata)
                    elif isinstance(data, list):
                        # Search for the entry that matches this specific fileName
                        for entry in data:
                            chunks = entry.get('transcript_chunks', [])
                            if any(c.get('fileName') == filename for c in chunks):
                                flatten_metadata(entry, metadata)
                                break
                    
            except Exception as e:
                print(f"Could not read metadata JSON {json_path}: {e}")
        
        # If no episode number in defined metadata, extract it via Regex from filename
        if "number" not in metadata:
            match = re.search(r'\d+', filename)
            if match:
                metadata["number"] = int(match.group(0))
            else:
                # Fallback safeguard
                print(f"Warning: Could not extract episode number from {filename}. Using default 99999.")
                metadata["number"] = 99999
                
        # Fill in required Episode defaults required by SchemaGuard
        if "name" not in metadata:
            metadata["name"] = f"Episode {metadata['number']}"
        if "description" not in metadata:
            metadata["description"] = f"Local transcript from {filename}"
        if "link" not in metadata:
            metadata["link"] = f"file://{file_path}"
            
        # 2. Read Transcript text
        with open(file_path, 'r', encoding='utf-8') as f:
            transcript_text = f.read()
            
        # 3. Pass to Engine
        print(f"LocalFileAdapter passing '{filename}' (Episode {metadata['number']}) to IngestionEngine...")
        engine.process_transcript(transcript_text, metadata)
