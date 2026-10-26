'use strict';
/**
 * Feature flags read at call time (so tests can toggle them).
 *
 * ENABLE_DOCUMENT_DOMAIN (Phase B M5, decision M5-10): the `document` domain — classifier routing,
 * the document domain instruction, the search_document_blocks tool and domain_intent="document" —
 * is offered only when this is "true". Off (default) = production behaviour identical to before M5,
 * until S2-19 turns documents on for users. The MCP server has the same flag (domain_registry.py).
 */
function documentDomainEnabled() {
    return String(process.env.ENABLE_DOCUMENT_DOMAIN || '').toLowerCase() === 'true';
}

module.exports = { documentDomainEnabled };
