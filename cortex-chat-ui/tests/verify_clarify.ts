/**
 * Clarifying questions in the chat (routing v2, cross-domain design 2026-11-09 §4.5). Run: `npm test`.
 * - helpers: a person option sends that person; "Both" sends every listed person; malformed payloads are ignored;
 * - the dashboard shows options only under the latest answer, sends the original question with the choice, and
 *   shows the chosen label as the user's reply; the client forwards clarify_choice.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { clarifyChoiceFor, readClarify } from '../utils/clarify.ts';

let passed = 0;
const ok = (c: unknown, m: string) => { assert.ok(c, m); passed++; };
const eq = (a: unknown, b: unknown, m: string) => { assert.deepEqual(a, b, m); passed++; };

const clarify = { question: 'Which David?', options: [
    { label: 'David Hughes', entity: { kind: 'person' as const, name: 'David Hughes' } },
    { label: 'David Soria Parra', entity: { kind: 'person' as const, name: 'David Soria Parra' } },
    { label: 'Both', entity: null },
] };
eq(clarifyChoiceFor(clarify.options[1], clarify), { kind: 'person', name: 'David Soria Parra' }, 'one person');
eq(clarifyChoiceFor(clarify.options[2], clarify), { kind: 'person', names: ['David Hughes', 'David Soria Parra'] }, 'Both → every person');
eq(readClarify(clarify), clarify, 'valid payload kept');
eq(readClarify({ question: 'x', options: [] }), null, 'no options → ignored');
eq(readClarify(undefined), null, 'missing → ignored');

const page = readFileSync(new URL('../app/dashboard/page.tsx', import.meta.url), 'utf8');
ok(/msg\.clarify && i === messages\.length - 1 && !isProcessing/.test(page), 'options only under the latest answer, not while busy');
ok(/executeQuery\(question, \[\.\.\.messages\], false, conversationId, choice, option\.label\)/.test(page), 'original question + choice; label shown');
ok(/clarifyFor: userMsg/.test(page), 'the question a clarification is about is kept with it');
const client = readFileSync(new URL('../lib/mcp-client.ts', import.meta.url), 'utf8');
ok(/clarify_choice: clarifyChoice/.test(client), 'client forwards clarify_choice');

console.log(`verify_clarify: ${passed} checks passed`);
