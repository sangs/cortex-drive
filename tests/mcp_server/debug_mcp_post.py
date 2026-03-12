import requests
import json

def test_manual_post():
    # 1. Discover endpoint
    url = "http://localhost:8080/sse"
    print(f"Connecting to {url}...")
    sse_res = requests.get(url, stream=True, headers={"x-tenant-id": "test_org_123"})
    
    endpoint = None
    for line in sse_res.iter_lines():
        if line:
            l = line.decode('utf-8')
            if l.startswith("data: /messages/"):
                endpoint = l.replace("data: ", "").strip()
                break
    
    if not endpoint:
        print("Failed to find endpoint")
        return

    full_url = f"http://localhost:8080{endpoint}"
    print(f"Found endpoint: {full_url}")

    # 2. Make POST call
    payload = {
        "jsonrpc": "2.0",
        "id": 1,
        "method": "tools/call",
        "params": {
            "name": "get_tool_statistics",
            "arguments": {}
        }
    }
    
    post_res = requests.post(
        full_url, 
        json=payload, 
        headers={"x-tenant-id": "test_org_123"}
    )
    
    print(f"Status Code: {post_res.status_code}")
    print(f"Response: {post_res.text}")

if __name__ == "__main__":
    test_manual_post()
