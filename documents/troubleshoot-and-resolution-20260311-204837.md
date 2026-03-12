# Troubleshooting and Resolution: Frontend Connectivity Issue

**Date**: 2026-03-11
**Time**: 20:48:37

## Issue Description
- **Symptoms**: The CortexDrive Dashboard status indicator showed "Unhealthy" (red) and the chat input was disabled with a permanent "Connecting..." placeholder.
- **Impact**: Users were unable to type or interact with the AI assistant.
- **Root Cause**: 
    1. The frontend was attempting to connect to the MCP Server directly on port 8080, bypassing the Gateway's proxy and authentication layer.
    2. The SSE (Server-Sent Events) connection was missing the required authentication headers (Trial API Key), leading to 401 Unauthorized errors from the Gateway's proxy.
    3. **Orchestration Protocol Violation**: The `history` mapping in the Gateway was stripping `tool_calls` and `tool_call_id`. When follow-up questions were asked, OpenAI returned a 400 "Bad Request" error because the assistant's previous tool calls were missing their metadata.
    4. **Parallel Tool Calls**: The Gateway was only handling the first tool call in a message, causing subsequent turns to fail if the LLM suggested multiple tools at once.

## Fixes Applied

### 1. Unified Gateway Routing & Auth Support
... (previous points) ...

### 3. Orchestration Robustness Fix
- **File**: `cortex-gateway/index.js`
- **Change**: 
    - Updated history mapping to preserve `tool_calls`, `tool_call_id`, and `name`.
    - Refactored the tool execution loop to iterate through and execute **all** parallel tool calls.
    - Added per-tool error handling to allow the LLM to recover from specific tool failures.

## Verification Results
- **Connectivity**: Status indicator turned green (Emerald) after refreshing the browser.
- **Interaction**: Chat input became enabled.
- **Intelligence**: Follow-up questions (e.g., "What was discussed there?") now correctly resolve the episode context without needing to restate the episode name.
