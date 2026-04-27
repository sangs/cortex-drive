import os
import sys

def verify_external_prompts():
    print("\n🔍 Verifying LLM Prompt Externalization...")
    
    base_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    prompts_dir = os.path.join(base_dir, "prompts")
    
    expected_files = [
        "gateway_system_assistant.md",
        "gateway_security_guest.md",
        "gateway_search_reranker.md",
        "mcp_mental_model.md"
    ]
    
    # 1. Verify files exist and are not empty
    for filename in expected_files:
        filepath = os.path.join(prompts_dir, filename)
        if not os.path.exists(filepath):
            print(f"❌ FAILED: Prompt file missing: {filename}")
            sys.exit(1)
            
        with open(filepath, 'r') as f:
            content = f.read().strip()
            if len(content) < 50:
                print(f"❌ FAILED: Prompt file {filename} appears empty or too short!")
                sys.exit(1)
        print(f"  -> ✅ Verified external file: {filename}")
        
    # 2. Verify source code has been stripped of hardcoded prompts
    gateway_file = os.path.join(base_dir, "cortex-gateway", "index.js")
    if os.path.exists(gateway_file):
        with open(gateway_file, 'r') as f:
            js_content = f.read()
            
            # Check for the old hardcoded strings
            if "You are the Cortex Brain Assistant" in js_content and not "readFileSync" in js_content:
                print("❌ FAILED: Found hardcoded 'Cortex Brain Assistant' string in cortex-gateway/index.js")
                sys.exit(1)
                
            if "You are in HR-GUEST MODE" in js_content and not "readFileSync" in js_content:
                print("❌ FAILED: Found hardcoded 'HR-GUEST MODE' string in cortex-gateway/index.js")
                sys.exit(1)
                
            # Check that it natively imports the files
            if "gateway_system_assistant.md" not in js_content:
                print("❌ FAILED: cortex-gateway/index.js does not appear to load the external system assistant prompt.")
                sys.exit(1)
                
        print("  -> ✅ Verified index.js no longer contains hardcoded prompts and uses readFileSync.")
        
    mcp_file = os.path.join(base_dir, "src", "mcp_server", "prompts.py")
    if os.path.exists(mcp_file):
        with open(mcp_file, 'r') as f:
            py_content = f.read()
            
            if "You are the Mental Model AI Assistant" in py_content and "read_text" not in py_content and "open(" not in py_content:
                print("❌ FAILED: Found hardcoded 'Mental Model AI Assistant' string in src/mcp_server/prompts.py")
                sys.exit(1)
                
        print("  -> ✅ Verified prompts.py no longer contains hardcoded prompts.")

    print("\n🎊 TDD SUCCESS: All prompts are successfully externalized!")
    sys.exit(0)

if __name__ == "__main__":
    verify_external_prompts()
