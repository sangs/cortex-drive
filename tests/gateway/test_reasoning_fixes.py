import requests
import json

# Configuration
GATEWAY_URL = "http://localhost:3000/query"
API_KEY = "cortex_trial_key_2024"

def test_reasoning_fixes():
    print("=== Starting Reasoning Fix Verification ===")
    
    headers = {
        "Content-Type": "application/json",
        "x-api-key": API_KEY
    }

    # Test 1: List Episodes
    print("\nTest 1: Asking 'What are the various available episodes?'")
    payload1 = {
        "question": "What are the various available episodes?"
    }
    
    response1 = requests.post(GATEWAY_URL, json=payload1, headers=headers)
    data1 = response1.json()
    answer1 = data1.get("answer", "")
    tool_used1 = data1.get("tool_used", "")
    
    print(f"Tool Used: {tool_used1}")
    print(f"Answer: {answer1}")

    # Test 2: Thematic Search
    print("\nTest 2: Asking 'What are the various discussions around vector databases?'")
    payload2 = {
        "question": "What are the various discussions around vector databases?"
    }
    
    response2 = requests.post(GATEWAY_URL, json=payload2, headers=headers)
    data2 = response2.json()
    answer2 = data2.get("answer", "")
    tool_used2 = data2.get("tool_used", "")
    
    print(f"Tool Used: {tool_used2}")
    print(f"Answer Excerpt: {answer2[:500]}...")

    print("\n=== Test Complete ===")

if __name__ == "__main__":
    test_reasoning_fixes()
