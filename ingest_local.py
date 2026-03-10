import os
import time
import sys
from watchdog.observers import Observer
from watchdog.events import FileSystemEventHandler
from ingestion_engine import IngestionEngine
from dotenv import load_dotenv

load_dotenv()

class TranscriptHandler(FileSystemEventHandler):
    def __init__(self, tenant_id: str):
        self.engine = IngestionEngine(tenant_id=tenant_id)

    def on_created(self, event):
        if event.is_directory:
            return
        if event.src_path.endswith('.txt'):
            self._handle_file(event.src_path)

    def _handle_file(self, file_path: str):
        print(f"New transcript detected: {file_path}")
        try:
            with open(file_path, 'r') as f:
                content = f.read()
            
            # Simple metadata inference from filename: episode_NNN.txt
            base_name = os.path.basename(file_path)
            ep_num_match = filter(str.isdigit, base_name)
            ep_num_str = "".join(ep_num_match)
            ep_number = int(ep_num_str) if ep_num_str else 0
            
            metadata = {
                'name': base_name.replace('.txt', '').replace('_', ' ').title(),
                'number': ep_number,
                'link': 'Local Ingestion',
                'file_name': base_name
            }
            
            self.engine.process_transcript(content, metadata)
            print(f"Successfully processed {file_path}")
            
        except Exception as e:
            print(f"Error processing {file_path}: {e}")

def main():
    path = os.environ.get("TRANSCRIPT_DIR", "./episode_data")
    tenant_id = os.environ.get("TENANT_ID") or os.environ.get("TEST_TENANT") or "test-tenant"
    
    if not os.path.exists(path):
        os.makedirs(path)
        print(f"Created watch directory: {path}")

    event_handler = TranscriptHandler(tenant_id=tenant_id)
    observer = Observer()
    observer.schedule(event_handler, path, recursive=False)
    
    print(f"CortexDrive Local Ingestion Watcher started.")
    print(f"Watching: {path}")
    print(f"Tenant ID: {tenant_id}")
    
    observer.start()
    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        observer.stop()
    observer.join()

if __name__ == "__main__":
    main()
