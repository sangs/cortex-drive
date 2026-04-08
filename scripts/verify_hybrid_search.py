import os
import json
from typing import List, Dict, Any
from src.mcp_server.expert_tools import ExpertTools
from dotenv import load_dotenv

# Load environment
load_dotenv()

TENANT_ID = os.environ.get("TENANT_ID", "org_3AacpFBbt39hPmDKyZyNBQuuM6t")
expert = ExpertTools(tenant_id=TENANT_ID)

TEST_QUERIES = [
    # Professional Portfolio
    "What are Sangeetha's most recent high-impact achievements at JPMorgan Chase?",
    "How has Sangeetha helped modernize infrastructure while delivering cost savings?",
    "Tell me about Sangeetha's experience with AI Agents and Vector Databases.",
    
    # Podcast Knowledge
    "What are the key takeaways of the in-memory graph database discussion?",
    "What challenges are solved by Apache Iceberg as discussed in this episode?",
    "In which podcast episode did David Soria Parra appear?",
    "What did Ryan Blue say about serializable consistency?"
]

def run_test_suite():
    print(f"--- Running Hybrid Search & Contextual Fusion Test Suite ---")
    print(f"Tenant: {TENANT_ID}\n")
    
    results = {}
    
    for query in TEST_QUERIES:
        print(f"Testing Query: '{query}'")
        try:
            # We call the hybrid method directly
            hybrid_results = expert.query_relevant_chunks_hybrid(query, top_k=5)
            
            # Formatted results for the artifact
            results[query] = []
            for i, res in enumerate(hybrid_results):
                results[query].append({
                    "rank": i + 1,
                    "rrf_score": res.get("rrf_score", 0),
                    "episode": res.get("episode_name"),
                    "text_preview": res.get("text")[:150] + "..."
                })
                
            print(f"  -> Found {len(hybrid_results)} high-fidelity chunks.")
        except Exception as e:
            print(f"  !! Error testing query '{query}': {e}")
            results[query] = {"error": str(e)}
            
    # Save results to a temporary JSON for the artifact generator to read
    with open("/tmp/hybrid_test_output.json", "w") as f:
        json.dump(results, f, indent=2)
    
    print("\n--- Test Suite Complete. Results saved to /tmp/hybrid_test_output.json ---")

if __name__ == "__main__":
    try:
        run_test_suite()
    finally:
        expert.close()
