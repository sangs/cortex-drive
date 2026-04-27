import os
import sys
import json

# Add project root and mcp_server to python path so schema_guard imports correctly
project_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.append(project_root)
sys.path.append(os.path.join(project_root, "src", "mcp_server"))

from src.mcp_server.expert_tools import ExpertTools

def run_polymorphism_audit():
    print("🚀 Running TDD: Hydration Polymorphism (Progressive Unspooling)")
    tenant_id = os.getenv('TENANT_ID', 'sangs/cortex-drive')
    tools = ExpertTools(tenant_id)
    
    test_suite = [
        {
            "name": "Humanless Autocode at Scale for SRE @ JPMorgan Chase",
            "type": "Heavy Hydration (Hackathon/Project)",
            "assert_tech": False, # Expect 0 since this particular hackathon didn't attach tech securely
            "assert_urls": False,
            "assert_narrative": True,
            "assert_empty_safe": True
        },
        {
            "name": "InfoQ: Architectural Shifts for Platform Engineers in the Age of AI",
            "type": "Medium Hydration (Thought Leadership)",
            "assert_tech": True, # Actually has 3 tech tools linked dynamically!
            "assert_urls": True, 
            "assert_narrative": True,
            "assert_empty_safe": False
        },
        {
            "name": "Lead Software Engineer, VP",
            "type": "Light Hydration (Role)",
            "assert_tech": False,
            "assert_urls": False,
            "assert_narrative": True, # Connected to 3 narratives (Projects inside role)
            "assert_empty_safe": True
        },
        {
            "name": "Simplifying Lakehouse Ecosystem With DuckLake",
            "type": "Podcast Hydration (Episode)",
            "assert_tech": False, 
            "assert_urls": False, # Currently stored natively, not via ReferenceLink node
            "assert_narrative": False,
            "assert_empty_safe": True
        }
    ]

    faults = 0
    for case in test_suite:
        print(f"\\n➤ Testing: {case['type']}")
        print(f"  Target: {case['name']}")
        
        try:
            # Emulate the frontend React UI calling the progressive method
            raw_response = tools.get_node_details(node_name=case['name'])
            res = json.loads(raw_response)
            
            # If the backend returns a not found string instead of json, it crashes the JSON parser.
            if "error" in res or "message" in res:
                print(f"  ❌ FAILURE: Node not found in database or returned error: {res}")
                faults += 1
                continue
                
            tech_count = len(res.get('technologies', []))
            url_count = len(res.get('ref_urls', []))
            narrative_count = len(res.get('narratives', []))
            
            print(f"  ↳ Tech Extracted: {tech_count}")
            print(f"  ↳ URLs Extracted: {url_count}")
            print(f"  ↳ Narratives Extracted: {narrative_count}")
            
            # Assertions
            if case['assert_tech'] and tech_count == 0:
                print("  ❌ ASSERTION FAILED: Expected technologies, got 0.")
                faults += 1
            if not case['assert_tech'] and case['assert_empty_safe'] and tech_count > 0:
                print("  ❌ ASSERTION FAILED: Expected 0 technologies safely, got data.")
                faults += 1
                
            if case['assert_urls'] and url_count == 0:
                print("  ❌ ASSERTION FAILED: Expected Reference URLs, got 0.")
                faults += 1
                
            if case['assert_narrative'] and narrative_count == 0:
                print("  ❌ ASSERTION FAILED: Expected STAR narratives, got 0.")
                faults += 1
                
            if faults == 0:
                print("  ✅ PASS: Payload matches UI polymorphism expectations.")
                
        except Exception as e:
            print(f"  ❌ CRITICAL EXCEPTION: {e}")
            faults += 1

    print("\\n===")
    if faults > 0:
        print(f"🛑 TDD FAILED. Detected {faults} structural hydration violations.")
        sys.exit(1)
    else:
        print("🟩 TDD PASSED. The Progressive Hydration engine is mathematically poly-morphic.")
        sys.exit(0)

if __name__ == "__main__":
    if "NEO4J_URI" not in os.environ:
        print("⚠️ Environment variables not loaded. Run via: export $(grep -v '^#' .env | xargs) && python tdd/verify_hydration_polymorphism.py")
        sys.exit(1)
    run_polymorphism_audit()
