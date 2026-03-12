import asyncio
from mcp import ClientSession
from mcp.client.sse import sse_client
import sys

async def test_server():
    print("Testing connection to Cortex Model SSE Server")
    headers = {"x-clerk-org-id": "test_org_123"}
    
    url = "http://127.0.0.1:8080/sse"
    
    print(f"Connecting to {url} with headers {headers}")
    try:
        async with sse_client(url, headers=headers) as (read_stream, write_stream):
            async with ClientSession(read_stream, write_stream) as session:
                await session.initialize()
                print("Server initialized successfully!")
                
                tools = await session.list_tools()
                print("Available tools:")
                for tool in tools.tools:
                    print(f" - {tool.name}")
                    
                print("\nTest completed successfully!")
    except Exception as e:
        print(f"Connection failed:")
        import traceback
        traceback.print_exc()

if __name__ == "__main__":
    asyncio.run(test_server())
