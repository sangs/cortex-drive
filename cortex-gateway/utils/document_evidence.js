'use strict';
/**
 * Phase B M5 gateway helpers for the document evidence tool (design §1.3.4). Pure functions so they can
 * be unit-tested without starting the gateway.
 *   - buildDocumentEvidenceContent: compact numbered evidence for the LLM, never the raw payload (AP-4)
 *   - documentEvidenceUrls: cite_url + uri of every block, so auditResponseUrls() keeps them (AP-15)
 *   - documentResultHasEvidence: true only with >= 1 block (AP-25 empty-evidence backstop)
 */
const DOCUMENT_SEARCH_TOOL = 'search_document_blocks';

/**
 * Phase B M5 (AP-4): compact, numbered evidence list for search_document_blocks — never the raw
 * payload. One line per block: [n] citation label + text (already capped at 800 chars by the tool).
 * Deduplicated per source::page::text.
 */
function buildDocumentEvidenceContent(toolContent) {
    let parsed;
    try { parsed = JSON.parse(toolContent); } catch { return String(toolContent).slice(0, 500); }
    if (parsed && parsed.error) return `Document search failed: ${parsed.error}`;
    const blocks = (parsed && Array.isArray(parsed.blocks)) ? parsed.blocks : [];
    if (blocks.length === 0) return 'Document search returned 0 evidence blocks.';
    const seen = new Set();
    const lines = [];
    for (const b of blocks) {
        const c = b.citation || {};
        const key = `${c.source_id}::${c.page}::${(b.text || '').slice(0, 80)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const where = [`${c.source_name || 'document'}`, c.revision_date ? `version ${String(c.revision_date).slice(0, 10)}` : null,
            c.page ? `p. ${c.page}` : null, c.section ? `section "${c.section}"` : null].filter(Boolean).join(', ');
        const label = b.label ? ` (${b.label})` : '';
        // No [n] numbering: the LLM copied the numbers instead of the citation (M5 step 9 finding).
        lines.push(`- Cite as: [${where}](${c.cite_url || ''})${label}\n  ${b.text || ''}`);
    }
    return `Document search returned ${lines.length} evidence block(s). Cite every fact with the "Cite as" text and link exactly as given (never a number):\n${lines.join('\n\n')}`;
}


function documentEvidenceUrls(parsed) {
    const urls = [];
    if (parsed && Array.isArray(parsed.blocks)) parsed.blocks.forEach(b => {
        const c = b && b.citation;
        if (c && c.cite_url) urls.push(c.cite_url);
        if (c && c.uri) urls.push(c.uri);
    });
    return urls;
}

/**
 * AP-25 for document turns (M5 step 9 finding): only passages support a document answer. A graph result
 * (the DocumentSource node and its terms) alone must not count, or the LLM fills the gap from training data.
 */
function countsAsEvidenceOnTurn(domainSignal, toolName) {
    return domainSignal !== 'document' || toolName === DOCUMENT_SEARCH_TOOL;
}

function documentResultHasEvidence(parsed) {
    return Boolean(parsed && !parsed.error && Array.isArray(parsed.blocks) && parsed.blocks.length > 0);
}

module.exports = { DOCUMENT_SEARCH_TOOL, buildDocumentEvidenceContent, documentEvidenceUrls, documentResultHasEvidence, countsAsEvidenceOnTurn };
