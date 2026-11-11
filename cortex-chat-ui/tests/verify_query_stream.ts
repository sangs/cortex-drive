/**
 * Streamed /query answers (cross-domain mode, design 2026-11-09 §4.2). Run: `npm test`.
 */
import assert from 'node:assert/strict';
import { parseSseChunk, readQueryStream } from '../utils/queryStream.ts';

let passed = 0;
const eq = (a: unknown, b: unknown, m: string) => { assert.deepEqual(a, b, m); passed++; };

eq(parseSseChunk('data: {"type":"progress","domain":"podcast","status":"found","count":3}\n\ndata: {"ty'),
   { events: [{ type: 'progress', domain: 'podcast', status: 'found', count: 3 }], rest: 'data: {"ty' }, 'a split event waits for the rest');
eq(parseSseChunk('data: not json\n\n').events, [], 'malformed event skipped');

const enc = new TextEncoder();
const chunks = ['data: {"type":"progress","domain":"career","status":"searching","count":0}\n\nda',
                'ta: {"type":"progress","domain":"career","status":"found","count":2}\n\n',
                'data: {"type":"result","answer":"A","domain_signal":"cross_domain"}\n\n'];
const stream = new ReadableStream<Uint8Array>({ start(c) { chunks.forEach(x => c.enqueue(enc.encode(x))); c.close(); } });
const seen: string[] = [];
const result = await readQueryStream(stream, e => seen.push(`${e.domain}:${e.status}`));
eq(seen, ['career:searching', 'career:found'], 'progress in order, across chunk boundaries');
eq(result, { answer: 'A', domain_signal: 'cross_domain' }, 'result payload without the event type');

const empty = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(enc.encode('data: {"type":"progress","domain":"x","status":"found","count":1}\n\n')); c.close(); } });
await assert.rejects(readQueryStream(empty), /without a result/); passed++;

console.log(`verify_query_stream: ${passed} checks passed`);
