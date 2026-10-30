/**
 * Unified shares phase 2 (2026-10-29): "Shared with me" on the dashboard. Source checks; behaviour is
 * tested in the gateway (verify_received_shares.js: list, permissions re-check, question routing).
 * Run: `npm test`.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

let passed = 0;
const ok = (cond: unknown, msg: string) => { assert.ok(cond, msg); passed++; };
const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

const comp = read('components/SharedWithMe.tsx');
ok(/\/api\/share\/received/.test(comp), 'reads the received shares from the gateway');
ok(/addEventListener\('focus', load\)/.test(comp), 'refreshes when the window regains focus (new shares appear, revoked disappear)');
ok(/Nothing has been shared with you yet/.test(comp), 'empty state for people with nothing shared');
ok(/item\.questions\.map/.test(comp) && !/openai|gpt|llm/i.test(comp), 'suggested questions come from the server; nothing generated here');

const dash = read('app/dashboard/page.tsx');
ok(/<SharedWithMe onAsk=\{askSuggested\} onOpen=\{openSharedItem\}/.test(dash), 'dashboard shows Shared with me');
ok(/showEmptyState=\{!caps\.addSource\}/.test(dash), 'empty-state hint only for people who cannot add sources (collaborators)');
ok(/await executeQuery\(question, \[\.\.\.messages\], false, conversationId\)/.test(dash), 'a suggested question is asked like a typed one');

console.log(`verify_shared_with_me: ${passed} checks passed`);
