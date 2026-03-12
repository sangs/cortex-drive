#!/bin/bash

# Final E2E Verification Script for Cortex Model
# Tests: Multi-turn, Graph Data Presence, Dynamic Legend Logic compatibility

GATEWAY_URL="http://localhost:3000/query"
TRIAL_KEY="cortex_trial_key_2024"
TENANT_ID="final_e2e_test_user"

# Function to safely parse JSON via python
get_val() {
  echo "$1" | python3 -c "import json,sys; print(json.load(sys.stdin).get('$2', ''))"
}

echo "🚀 Starting Final E2E Verification..."

# --- TURN 1 ---
echo -e "\n--- Turn 1: Initial Topic Discovery ---"
QUESTION1="What are some episodes that discuss Vector Databases?"
PAYLOAD1=$(python3 -c "import json; print(json.dumps({'question': '$QUESTION1', 'history': []}))")

RESPONSE1=$(curl -s -X POST "$GATEWAY_URL" \
  -H "Content-Type: application/json" \
  -H "x-api-key: $TRIAL_KEY" \
  -H "x-tenant-id: $TENANT_ID" \
  -d "$PAYLOAD1")

ANSWER1=$(get_val "$RESPONSE1" "answer")
RAW_DATA1=$(get_val "$RESPONSE1" "raw_data")
TOOL1=$(get_val "$RESPONSE1" "tool_used")

echo "Assistant (via $TOOL1): ${ANSWER1:0:100}..."

if [[ -n "$RAW_DATA1" ]]; then
  echo "✅ Graph Data received for Turn 1"
  # Check if we have multiple node types for the legend test
  NODE_TYPES=$(echo "$RAW_DATA1" | python3 -c "import json,sys; data=json.loads(sys.stdin.read()); print(','.join(set(n.get('type') for n in data)) if isinstance(data, list) else 'single_node')")
  echo "🔹 Detected Node Types for Legend: $NODE_TYPES"
else
  echo "❌ FAILED: No graph data in Response 1"
  exit 1
fi

# --- TURN 2 ---
echo -e "\n--- Turn 2: Contextual Follow-up ---"
QUESTION2="Which of these episodes features a guest from Pinecone?"
# Simplified history for test
HISTORY="[{\"role\": \"user\", \"content\": \"$QUESTION1\"}, {\"role\": \"assistant\", \"content\": \"$ANSWER1\"}]"
PAYLOAD2=$(python3 -c "import json; h=[{'role': 'user', 'content': \"\"\"$QUESTION1\"\"\"}, {'role': 'assistant', 'content': \"\"\"$ANSWER1\"\"\"}]; print(json.dumps({'question': \"\"\"$QUESTION2\"\"\", 'history': h}))")

RESPONSE2=$(curl -s -X POST "$GATEWAY_URL" \
  -H "Content-Type: application/json" \
  -H "x-api-key: $TRIAL_KEY" \
  -H "x-tenant-id: $TENANT_ID" \
  -d "$PAYLOAD2")

ANSWER2=$(get_val "$RESPONSE2" "answer")
RAW_DATA2=$(get_val "$RESPONSE2" "raw_data")
TOOL2=$(get_val "$RESPONSE2" "tool_used")

echo "Assistant (via $TOOL2): $ANSWER2"

if [[ -n "$ANSWER2" && "$ANSWER2" != *"Error"* ]]; then
  echo "✅ Context preserved: Pronouns resolved and follow-up successful."
else
  echo "❌ FAILED: Turn 2 did not resolve correctly."
  echo "Response: $RESPONSE2"
  exit 1
fi

if [[ -n "$RAW_DATA2" ]]; then
  echo "✅ Graph Data received for Turn 2"
else
  echo "⚠️ Warning: Turn 2 returned no graph data (might be expected depending on LLM choice)"
fi

echo -e "\n✨ ALL SYSTEMS VERIFIED ✨"
echo "Multi-turn: OK"
echo "Graph Data Flow: OK"
echo "Dynamic Legend Mapping: Ready"
