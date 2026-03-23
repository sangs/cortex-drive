import os
import re
from neo4j import GraphDatabase
from dotenv import load_dotenv

def migrate():
    load_dotenv('.env', override=True)
    
    uri = os.environ.get("NEO4J_URI")
    user = os.environ.get("NEO4J_USERNAME")
    password = os.environ.get("NEO4J_PASSWORD")
    
    driver = GraphDatabase.driver(uri, auth=(user, password))
    ts_pattern = re.compile(r"\[(?:(\d{1,2}):)?(\d{1,2}):(\d{2})\]")
    
    print("Starting In-Place Chronometric Enrichment...")
    
    with driver.session() as session:
        # 1. Fetch all chunks ordered by Episode and sequence
        # We process ALL chunks across ALL tenants to ensure global health
        query = """
        MATCH (ep:Episode)-[:HAS_SOURCE]->(s)-[:CONTAINS]->(c:Chunk)
        RETURN id(c) as node_id, c.text as text, ep.number as ep_num, c.order as order
        ORDER BY ep.number, c.order
        """
        results = session.run(query)
        
        updates = []
        current_ep = None
        prev_node_id = None
        
        for record in results:
            node_id = record["node_id"]
            text = record["text"]
            ep_num = record["ep_num"]
            
            # Reset prev_node reference if we switch episodes
            if ep_num != current_ep:
                current_ep = ep_num
                prev_node_id = None
            
            # Extract startTime
            start_seconds = None
            match = ts_pattern.search(text)
            if match:
                h_str, m_str, s_str = match.groups()
                h = int(h_str) if h_str else 0
                m = int(m_str)
                s = int(s_str)
                start_seconds = h * 3600 + m * 60 + s
            
            # Prepare update for CURRENT node
            updates.append({"id": node_id, "start": start_seconds, "end": None})
            
            # Update PREVIOUS node's endTime if we just found a startTime
            if prev_node_id is not None and start_seconds is not None:
                # Find the previous entry in our list and set its end time
                for up in reversed(updates):
                    if up["id"] == prev_node_id:
                        up["end"] = start_seconds
                        break
            
            prev_node_id = node_id
            
        print(f"Calculated offsets for {len(updates)} chunks. Committing to Neo4j...")
        
        # 2. Batch Update
        batch_query = """
        UNWIND $batch as item
        MATCH (c) WHERE id(c) = item.id
        SET c.startTime = item.start, c.endTime = item.end
        """
        session.run(batch_query, batch=updates)
        
    driver.close()
    print("Migration Complete! Existing data is now 'Navigational Co-pilot' ready.")

if __name__ == "__main__":
    migrate()
