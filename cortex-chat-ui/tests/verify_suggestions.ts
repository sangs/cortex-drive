/**
 * Suggested questions in the chat (S2-102, architecture/question-suggestions-design-2026-11-23.md §3.3, §3.5).
 * Run: `npm test`.
 * - helpers: payloads validated; the "You could ask" list is removed from the text only when shown as buttons;
 * - the dashboard shows starters on an empty chat, "Try asking" afterwards, buttons under the latest answer only,
 *   and the Links legend + a one-time note when gold dashed links appear; the starter component calls the gateway.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { inferredLinkCount, readStarters, readSuggestions, withoutSuggestionList } from '../utils/suggestions.ts';

let passed = 0;
const ok = (c: unknown, m: string) => { assert.ok(c, m); passed++; };
const eq = (a: unknown, b: unknown, m: string) => { assert.deepEqual(a, b, m); passed++; };

eq(readSuggestions(['A?', ' A? ', 3, '', 'B?']), ['A?', 'B?'], 'strings only, trimmed, de-duplicated');
eq(readSuggestions(undefined), [], 'missing → none');
eq(readSuggestions(['x'.repeat(301)]), [], 'too long → ignored');
eq(readStarters({ questions: [{ question: "What's in Cortex-Drive for me?", kind: 'overview' }, { question: 7 }, null] }),
   [{ question: "What's in Cortex-Drive for me?", kind: 'overview' }], 'starters validated');
eq(readStarters({}), [], 'no list → none');

const small = 'Hello! I answer from your organization\'s knowledge in Cortex-Drive.\n\nYou could ask:\n- A?\n- B?';
eq(withoutSuggestionList(small, ['A?', 'B?']), "Hello! I answer from your organization's knowledge in Cortex-Drive.", 'greeting list removed');
const overview = "Here is what's in Cortex-Drive for you:\n\n- **Podcasts**: 6 items\n\n**You could ask**\n- A?\n- B?";
eq(withoutSuggestionList(overview, ['A?', 'B?']), "Here is what's in Cortex-Drive for you:\n\n- **Podcasts**: 6 items", 'overview keeps its content');
eq(withoutSuggestionList(overview, []), overview, 'no buttons → text unchanged');
eq(withoutSuggestionList('- **Podcasts**: 6 items', ['Podcasts']), '- **Podcasts**: 6 items', 'only exact suggestion lines are removed');
eq(inferredLinkCount([{ isVirtual: true }, {}, { isVirtual: false }, { isVirtual: true }]), 2, 'inferred links counted');

const page = readFileSync(new URL('../app/dashboard/page.tsx', import.meta.url), 'utf8');
ok(/messages\.length === 0 && !isProcessing && \(\s*<StarterQuestions/.test(page), 'starters on an empty chat');
ok(page.includes("'Try asking'"), '"Try asking" after the conversation starts');
ok(page.includes('msg.suggestions && i === messages.length - 1'), 'answer buttons under the latest answer only');
ok(page.includes('withoutSuggestionList(result.answer, suggestions)'), 'list shown once, as buttons');
ok(page.includes('Recorded link (saved in the graph)') && page.includes('Shown for this session only; nothing is saved'), 'Links legend');
ok(page.includes('inferredNoteShown.current = true'), 'one-time note per page session');
ok(!page.includes('Federated bridge'), 'jargon label replaced');
const comp = readFileSync(new URL('../components/StarterQuestions.tsx', import.meta.url), 'utf8');
ok(comp.includes('/api/suggestions/starters?page=') && comp.includes('Authorization: `Bearer ${token}`'), 'starters from the gateway, signed in');
ok(comp.includes('More ideas'), 'More ideas');

console.log(`verify_suggestions: ${passed} checks passed`);
