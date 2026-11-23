/**
 * Settings → People (S2-50 build 2b). Run: `npm test`.
 * - payload validated; preview wording from counts; member vs collaborator routes;
 * - Remove always previews first (confirm:false), then confirms inline (confirm:true); no browser dialogs.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { previewLines, readPeople } from '../utils/people.ts';

let passed = 0;
const ok = (c: unknown, m: string) => { assert.ok(c, m); passed++; };
const eq = (a: unknown, b: unknown, m: string) => { assert.deepEqual(a, b, m); passed++; };

eq(readPeople([{ userSub: 'user_abc', name: 'Bo', kind: 'member' }, { userSub: 'x' }, null, { userSub: 'user_def', kind: 'weird' }]),
   [{ userSub: 'user_abc', name: 'Bo', kind: 'member' }, { userSub: 'user_def', name: null, kind: 'collaborator' }], 'people validated');
eq(previewLines('collaborator', { shares: 2, groups: 1 }),
   ['2 shares you gave them will be revoked', 'They leave 1 group you created', 'Nothing else changes; their account stays'], 'collaborator preview');
const m = previewLines('member', { owned_nodes: 1, access_tuples: 3, org_conversations: 2 });
ok(m[0].startsWith('1 item they added transfer to you') && m.some(l => l.includes('2 chats')), 'member preview');
ok(m.at(-1)!.includes('account and personal history stay'), 'member keeps the account');

const page = readFileSync(new URL('../app/settings/people/page.tsx', import.meta.url), 'utf8');
ok(page.includes("{ confirm: false }") && page.includes("{ confirm: true }"), 'preview first, then confirm');
ok(page.includes("'remove-member'") && page.includes("'remove-collaborator'"), 'route by kind');
ok(page.includes('role="alertdialog"') && !/window\.confirm|alert\(/.test(page), 'inline confirmation only');
const sharing = readFileSync(new URL('../app/settings/sharing/page.tsx', import.meta.url), 'utf8');
ok(sharing.includes('href="/settings/people"'), 'linked from Sharing & Access');

console.log(`verify_people: ${passed} checks passed`);
