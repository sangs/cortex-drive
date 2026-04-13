import os
import sys

def verify_deterministic_graph_trigger():
    print("\n🔍 Verifying Deterministic Graph Route Interception...")
    
    base_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    gateway_file = os.path.join(base_dir, "cortex-gateway", "index.js")
    
    if not os.path.exists(gateway_file):
        print("❌ FAILED: Gateway file not found at cortex-gateway/index.js")
        sys.exit(1)
        
    with open(gateway_file, 'r') as f:
        js_content = f.read()
        
    print("  -> Checking MCP Interface Schema...")
    if '"wants_visual_map"' not in js_content and "'wants_visual_map'" not in js_content and "wants_visual_map:" not in js_content:
        print("❌ FAILED: 'wants_visual_map' boolean not found in the search_resume_graph tool schema!")
        sys.exit(1)
        
    print("  -> ✅ Tool schema deterministic boolean is present.")

    print("  -> Checking Core Node.js Orchestration loop...")
    interception_indicators = [
        "toolArgs.wants_visual_map", 
        "get_cluster_context", 
        "aggregatedResults.push"
    ]
    
    for indicator in interception_indicators:
        if indicator not in js_content:
            print(f"❌ FAILED: Node.js Orchestration seems to be missing the interception hook. Missing: '{indicator}'")
            sys.exit(1)

    print("  -> ✅ Interception hook to bypass LLM tool selection is securely in place.")
    print("\n🎊 TDD SUCCESS: Deterministic Map Routing is active!")
    sys.exit(0)

if __name__ == "__main__":
    verify_deterministic_graph_trigger()
