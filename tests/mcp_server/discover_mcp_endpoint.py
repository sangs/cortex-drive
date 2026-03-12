import requests

def discover_endpoint():
    url = "http://localhost:8080/sse"
    print(f"Connecting to {url}...")
    response = requests.get(url, stream=True)
    for line in response.iter_lines():
        if line:
            decoded_line = line.decode('utf-8')
            print(decoded_line)
            if "event: endpoint" in decoded_line:
                # The next line should be data: /messages/...
                pass
            if "data: " in decoded_line and "event: endpoint" in prev_line:
                print(f"FOUND ENDPOINT: {decoded_line}")
                break
        prev_line = line.decode('utf-8') if line else ""

if __name__ == "__main__":
    discover_endpoint()
