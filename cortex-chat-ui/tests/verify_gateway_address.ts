// The UI reads the gateway's address in exactly one place: lib/gateway.ts (Invariant 1).
// This fails if any other source file reads the build setting or repeats the local address.
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const SOURCE_DIRS = ['app', 'components', 'hooks', 'lib', 'utils'];
const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx']);
const OWNER_FILE = path.join('lib', 'gateway.ts');
const FORBIDDEN = [/NEXT_PUBLIC_GATEWAY_URL/, /NEXT_PUBLIC_MCP_SERVER_URL/, /localhost:4000/];

function sourceFiles(dir: string): string[] {
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) return sourceFiles(full);
        return SOURCE_EXTENSIONS.has(path.extname(entry.name)) ? [full] : [];
    });
}

let failed = 0;
const check = (ok: boolean, label: string) => {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
    if (!ok) failed += 1;
};

const files = SOURCE_DIRS.flatMap((d) => sourceFiles(path.join(ROOT, d)));
check(files.length > 0, `source files found (${files.length})`);

const offenders: string[] = [];
let importers = 0;
for (const file of files) {
    const rel = path.relative(ROOT, file);
    const text = fs.readFileSync(file, 'utf-8');
    if (rel === OWNER_FILE) continue;
    if (FORBIDDEN.some((p) => p.test(text))) offenders.push(rel);
    if (/from ['"](@\/lib\/gateway|\.\/gateway)['"]/.test(text)) importers += 1;
}
check(offenders.length === 0, `gateway address read only in ${OWNER_FILE}${offenders.length ? ` — also in: ${offenders.join(', ')}` : ''}`);
check(importers > 0, `other files import the shared constant (${importers})`);

const owner = fs.readFileSync(path.join(ROOT, OWNER_FILE), 'utf-8');
check(/export const GATEWAY_URL = process\.env\.NEXT_PUBLIC_GATEWAY_URL \|\| LOCAL_GATEWAY_URL;/.test(owner), 'lib/gateway.ts exports GATEWAY_URL from the build setting with the local fallback');

if (failed) { console.error(`\n${failed} check(s) failed`); process.exit(1); }
console.log('\nAll gateway-address checks passed');
