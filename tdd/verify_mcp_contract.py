import ast
import os
import re
import json

def get_gateway_tool_definitions(gateway_path):
    with open(gateway_path, 'r') as f:
        content = f.read()
    
    # Simple regex to extract the JSON-ish array
    match = re.search(r'const mcpToolsDefinitions = (\[.*?\]);', content, re.DOTALL)
    if not match:
        raise ValueError("Could not find mcpToolsDefinitions in gateway index.js")
    
    # Node.js JS isn't perfect JSON (missing quotes on keys, etc), so we'll do an approximation 
    # Or better: just look for function names and their parameter keys
    
    tools = {}
    # Find all function blocks
    tool_blocks = re.findall(r'name: "(\w+)",.*?properties: \{(.*?)\}', content, re.DOTALL)
    for name, props_block in tool_blocks:
        params = re.findall(r'(\w+): \{', props_block)
        tools[name] = params
    
    # Catch tools with no params
    no_param_tools = re.findall(r'name: "(\w+)",.*?parameters: \{ type: "object", properties: \{\}, required: \[\] \}', content, re.DOTALL)
    for name in no_param_tools:
        if name not in tools:
            tools[name] = []
            
    return tools

def get_sse_server_signatures(sse_path):
    with open(sse_path, 'r') as f:
        tree = ast.parse(f.read())
    
    signatures = {}
    for node in ast.walk(tree):
        if isinstance(node, ast.AsyncFunctionDef):
            # Check if it has the @mcp.tool() decorator
            is_tool = any(isinstance(dec, (ast.Call, ast.Attribute, ast.Name)) for dec in node.decorator_list)
            if is_tool:
                args = [arg.arg for arg in node.args.args]
                signatures[node.name] = args
    return signatures

def main():
    workspace_root = os.getcwd()
    gateway_path = os.path.join(workspace_root, 'cortex-gateway/index.js')
    sse_path = os.path.join(workspace_root, 'src/mcp_server/cortex_os_mentalmodel_server_sse.py')
    
    print(f"--- MCP Contract Verification ---")
    
    try:
        gateway_tools = get_gateway_tool_definitions(gateway_path)
        sse_signatures = get_sse_server_signatures(sse_path)
        
        errors = []
        for tool_name, expected_params in gateway_tools.items():
            if tool_name not in sse_signatures:
                # Some names might be slightly different or handled differently?
                # For now assume exact matches or check if suffixed with _tool
                if f"{tool_name}_tool" in sse_signatures:
                    actual_params = sse_signatures[f"{tool_name}_tool"]
                else:
                    print(f"⚠️ Warning: Tool '{tool_name}' defined in Gateway not found in SSE Server AST.")
                    continue
            else:
                actual_params = sse_signatures[tool_name]
            
            for param in expected_params:
                if param not in actual_params:
                    errors.append(f"❌ MISMATCH: Tool '{tool_name}' expects parameter '{param}' in Gateway, but missing in SSE Server signature.")
        
        if errors:
            print("\n".join(errors))
            print("\n[RED] Contract Verification FAILED.")
            exit(1)
        else:
            print("[GREEN] All Gateway parameters are present in SSE Server signatures.")
            
    except Exception as e:
        print(f"❌ Error during verification: {e}")
        exit(1)

if __name__ == "__main__":
    main()
