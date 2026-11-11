'use strict';
/**
 * Grounding guard (Invariant 11, AP-25; user decision 2026-11-10). The LLM must not answer a new question from its
 * general knowledge. A new question (no conversation history) that is not small talk must call a data tool before the
 * answer: the first LLM call uses tool_choice "required", and an answer that still arrives with no data-tool call is
 * replaced with "No data found". Follow-ups (history present) may answer from the earlier turn's evidence, as before.
 * Found by the routing v2 production test: "What is self-attention?" was answered from general knowledge, 0 tools.
 */
const CFG = require('../config/intent_keywords.js');
const SMALL_TALK_RE = CFG.smallTalkPatternSource ? new RegExp(CFG.smallTalkPatternSource, 'i') : null;

function isSmallTalk(question) {
    return Boolean(SMALL_TALK_RE && SMALL_TALK_RE.test(String(question || '')));
}

/** True when this turn must be answered from a data tool. */
function mustGround(question, history) {
    return !(Array.isArray(history) && history.length) && !isSmallTalk(question);
}

/** tool_choice for loop iteration `n` (1-based). */
function toolChoiceFor(n, grounded) {
    return n === 1 && grounded ? 'required' : 'auto';
}

module.exports = { isSmallTalk, mustGround, toolChoiceFor };
