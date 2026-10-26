'use strict';
const { documentDomainEnabled } = require('./feature_flags');

/**
 * Which MCP tools the chat LLM may be offered and may call in one turn (S2-20, AP-26; 2026-10-19).
 *
 * Restrictions are enforced here in code, not by prompt: a guest share-link turn is offered only
 * GUEST_ALLOWED_TOOLS, and every tool call is checked against the turn's offered list before it
 * runs, so a model that names a tool it wasn't given (hallucinated or prompt-injected) is refused.
 * run_cypher_query is not in the chat tool list at all (owner-only, read-only, MCP-direct only).
 */

// Read-only retrieval tools a guest (verified share link, req.guestAuth) may use. Every one of them
// applies the per-request allowlist in Cypher (ExpertTools._get_security_clause). Not included:
// explore_graph_schema (schema introspection) and get_tool_statistics (tenant-wide counts).
const GUEST_ALLOWED_TOOLS = new Set([
    'get_context',
    'find_episodes_by_people',
    'find_episodes_by_concept',
    'find_episodes_by_topic',
    'find_episodes_by_technology',
    'find_episodes_by_reference',
    'find_episodes_by_mentions',
    'search_episodes_gds_by_question_tool',
    'search_episodes_by_question_tool',
    'get_people_by_episode_tool',
    'hybrid_discovery_tool',
    'get_node_details',
    'search_enterprise_graph',
    'get_cluster_context',
    'get_episodes_with_cast',
    'query_relevant_chunks_hybrid_tool',
    'connect_knowledge_on_demand',
    'infer_context_on_demand',
]);

// Never offered to the chat LLM, for anyone (raw query tools: AP-26).
const CHAT_EXCLUDED_TOOLS = new Set(['run_cypher_query']);

// Phase B M5: offered only when ENABLE_DOCUMENT_DOMAIN is on. Not in GUEST_ALLOWED_TOOLS (M5-9:
// guest-link chats get no document passages until reviewed with S2-19).
const DOCUMENT_TOOLS = new Set(['search_document_blocks']);
const DOCUMENT_DOMAIN_INTENT = 'document';

/** search_enterprise_graph without the `document` domain_intent (flag off). Returns a copy. */
function _withoutDocumentIntent(def) {
    const props = def.function.parameters && def.function.parameters.properties;
    const di = props && props.domain_intent;
    if (!di || !Array.isArray(di.enum) || !di.enum.includes(DOCUMENT_DOMAIN_INTENT)) return def;
    const copy = JSON.parse(JSON.stringify(def));
    copy.function.parameters.properties.domain_intent.enum = di.enum.filter(v => v !== DOCUMENT_DOMAIN_INTENT);
    return copy;
}

/**
 * The tool definitions to offer the LLM this turn.
 * documentDomain: defaults to the ENABLE_DOCUMENT_DOMAIN flag. Off → no document tool and no
 * `document` domain_intent, so the offered list is exactly what it was before M5.
 */
function toolsOfferedFor({ isGuest, documentDomain = documentDomainEnabled() }, toolDefinitions) {
    return toolDefinitions.filter(t => {
        const name = t.function.name;
        if (CHAT_EXCLUDED_TOOLS.has(name)) return false;
        if (DOCUMENT_TOOLS.has(name) && !documentDomain) return false;
        return !isGuest || GUEST_ALLOWED_TOOLS.has(name);
    }).map(t => (documentDomain ? t : _withoutDocumentIntent(t)));
}

/** Names of the offered tools, for the per-call check. */
function offeredToolNames(offeredTools) {
    return new Set(offeredTools.map(t => t.function.name));
}

/** The tool message returned to the LLM when it calls a tool it wasn't offered. */
function refusedToolMessage(toolCall) {
    return {
        role: 'tool',
        tool_call_id: toolCall.id,
        name: toolCall.function.name,
        content: JSON.stringify({ error: `Tool '${toolCall.function.name}' is not available in this conversation.` }),
    };
}

module.exports = { GUEST_ALLOWED_TOOLS, CHAT_EXCLUDED_TOOLS, DOCUMENT_TOOLS, toolsOfferedFor, offeredToolNames, refusedToolMessage };
