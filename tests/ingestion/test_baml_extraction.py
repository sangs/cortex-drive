import os
import sys
from dotenv import load_dotenv

# Add src/mcp_server to path for imports
sys.path.append(os.path.join(os.getcwd(), "src", "mcp_server"))

load_dotenv()

def test_baml_extraction():
    try:
        from baml_client import b
        from baml_client.types import GraphExtraction
        
        print("🚀 Testing BAML Extraction...")
        
        transcript = """
        In this episode, we talk to Adam from Boundary ML about BAML. 
        BAML is a new language for structured LLM data extraction. 
        It solves the brittle parsing issues found in standard JSON Schema approaches.
        We also touched on LangChain and how it differs from BAML's Schema-Aligned Parsing.
        """
        
        result = b.ExtractGraph(transcript=transcript)
        
        print("\n✅ Extraction Successful!")
        print(f"Nodes Extracted: {len(result.topics)} Topics, {len(result.people)} People, {len(result.technologies)} Technologies")
        
        print("\n--- Topics ---")
        for t in result.topics:
            print(f"- {t.name}: {t.description}")
            
        print("\n--- People ---")
        for p in result.people:
            print(f"- {p.name} ({p.role})")
            
        print("\n--- Technologies ---")
        for tech in result.technologies:
            print(f"- {tech.name}: {tech.description}")
            
        print("\n--- Links ---")
        for link in result.links:
            print(f"- {link.text}: {link.url}")
            
    except Exception as e:
        print(f"❌ Extraction Failed: {e}")
        sys.exit(1)

if __name__ == "__main__":
    test_baml_extraction()
