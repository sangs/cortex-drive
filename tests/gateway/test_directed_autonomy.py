import requests
import json

# Configuration
GATEWAY_URL = "http://localhost:3000/query"
API_KEY = "cortex_trial_key_2024"

def test_directed_autonomy():
    print("=== Starting Directed Autonomy Verification Test ===")
    
    headers = {
        "Content-Type": "application/json",
        "x-api-key": API_KEY
    }

    # Turn 1: Discovery
    print("\nStep 1: Discovering the KuzuDB episode...")
    payload1 = {
        "question": "What is the KuzuDB episode about?"
    }
    
    response1 = requests.post(GATEWAY_URL, json=payload1, headers=headers)
    data1 = response1.json()
    answer1 = data1.get("answer", "")
    print(f"Turn 1 Answer: {answer1[:200]}...")

    # Prepare Turn 2
    history = [
        {"role": "user", "content": "What is the KuzuDB episode about?"},
        {"role": "assistant", "content": answer1}
    ]
    
    # Turn 2: Surgical Follow-up
    print("\nStep 2: Asking for surgical detail about the guest...")
    payload2 = {
        "question": "Tell me everything you have on that specific guest.",
        "history": history
    }
    
    response2 = requests.post(GATEWAY_URL, json=payload2, headers=headers)
    data2 = response2.json()
    answer2 = data2.get("answer", "")
    tool_used = data2.get("tool_used", "")
    
    print(f"Turn 2 Tool Used: {tool_used}")
    print(f"Turn 2 Answer Excerpt: {answer2[:300]}...")

    # Verification
    # Expected: The LLM should prefer get_node_details or run_cypher_query 
    # since it already knows the guest's name from Turn 1 context.
    agentic_tools = ["get_node_details", "run_cypher_query"]
    if any(t in tool_used for t in agentic_tools):
        print(f"✅ Success: LLM used agentic tool '{tool_used}' for context bridging.")
    else:
        print(f"⚠️ Note: LLM used tool '{tool_used}'. If it was hybrid_discovery_tool, it may have anchored internally or fallen back.")

    print("\n=== Test Complete ===")

if __name__ == "__main__":
    test_directed_autonomy()
