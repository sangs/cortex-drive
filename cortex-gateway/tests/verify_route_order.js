'use strict';
/**
 * Startup guard (2026-11-23): candidate gateway-00169 failed to start because routes were registered before
 * `const app = express()` ("Cannot access 'app' before initialization"). Unit tests don't load index.js, so this
 * checks the source: every app.<method>( / app.use( call comes after the app is created.
 * Run: node tests/verify_route_order.js (npm test).
 */
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
const created = src.indexOf('const app = express()');
if (created < 0) { console.error('verify_route_order FAILED: app creation not found'); process.exit(1); }
const early = [...src.matchAll(/^\s*app\.(get|post|put|patch|delete|use|all)\(/gm)].filter(m => m.index < created);
if (early.length) {
    const line = i => src.slice(0, i).split('\n').length;
    console.error(`verify_route_order FAILED: ${early.length} route(s) before the app exists, e.g. line ${line(early[0].index)}`);
    process.exit(1);
}
console.log('verify_route_order: every route after app creation');
