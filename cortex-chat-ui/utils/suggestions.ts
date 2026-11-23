/**
 * Suggested questions in the chat (S2-102, architecture/question-suggestions-design-2026-11-23.md §3.3).
 * The gateway builds them (templates × titles the user can open; no LLM); the UI only validates and shows them.
 */
export type Starter = { question: string; kind: string };

const MAX_QUESTION_CHARS = 300;

/** Questions from a gateway payload: strings only, trimmed, de-duplicated, bounded. Anything else is ignored. */
export function readSuggestions(value: unknown): string[] {
    if (!Array.isArray(value)) return [];
    const out: string[] = [];
    for (const v of value) {
        if (typeof v !== 'string') continue;
        const q = v.trim();
        if (q && q.length <= MAX_QUESTION_CHARS && !out.includes(q)) out.push(q);
    }
    return out;
}

/** Starters from GET /api/suggestions/starters. */
export function readStarters(value: unknown): Starter[] {
    const list = value && typeof value === 'object' ? (value as { questions?: unknown }).questions : null;
    if (!Array.isArray(list)) return [];
    const out: Starter[] = [];
    for (const s of list) {
        const q = s && typeof s === 'object' ? (s as Starter).question : null;
        if (typeof q === 'string' && q.trim() && q.length <= MAX_QUESTION_CHARS && !out.some(o => o.question === q)) {
            out.push({ question: q.trim(), kind: typeof (s as Starter).kind === 'string' ? (s as Starter).kind : '' });
        }
    }
    return out;
}

/**
 * The answer text without its "You could ask" list when the same questions are shown as buttons. The gateway writes
 * that list from the same array (utils/routing_v2.js), so only exact lines are removed; the rest of the text is kept.
 */
export function withoutSuggestionList(text: string, suggestions: string[]): string {
    if (!suggestions.length || typeof text !== 'string') return text;
    const bullets = new Set(suggestions.map(s => `- ${s}`));
    const lines = text.split('\n').filter(l => !bullets.has(l.trim()));
    const heading = /^\s*(\*\*You could ask\*\*|You could ask:)\s*$/;
    return lines.filter(l => !heading.test(l)).join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** Graph links Cortex-Drive inferred for this session (gold dashed, never saved): the legend counts them. */
export function inferredLinkCount(links: { isVirtual?: boolean }[] | undefined): number {
    return (links || []).filter(l => l && l.isVirtual).length;
}
