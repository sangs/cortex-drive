// Streamed /query answers (cross-domain mode, design 2026-11-09 §4.2): the gateway sends server-sent events —
// `progress` per domain as it finishes, then one `result` with the usual payload. Anything else is ignored.
export type QueryProgressEvent = { type: 'progress'; domain: string; status: string; count: number };

/** Parse SSE `data:` lines from a chunk buffer; returns the parsed events and the unfinished tail. */
export function parseSseChunk(buffer: string): { events: any[]; rest: string } {
    const events: any[] = [];
    const blocks = buffer.split('\n\n');
    const rest = blocks.pop() ?? '';
    for (const block of blocks) {
        const data = block.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).trim()).join('');
        if (!data) continue;
        try { events.push(JSON.parse(data)); } catch { /* skip a malformed event */ }
    }
    return { events, rest };
}

/** Read the stream to the end; report progress events; return the `result` payload. */
export async function readQueryStream(body: ReadableStream<Uint8Array>, onProgress?: (e: QueryProgressEvent) => void): Promise<any> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let result: any = null;
    for (;;) {
        const { value, done } = await reader.read();
        if (value) buffer += decoder.decode(value, { stream: true });
        const { events, rest } = parseSseChunk(done ? buffer + '\n\n' : buffer);
        buffer = rest;
        for (const e of events) {
            if (e.type === 'progress') onProgress?.(e as QueryProgressEvent);
            else if (e.type === 'result') { const { type, ...payload } = e; result = payload; }
        }
        if (done) break;
    }
    if (!result) throw new Error('The answer stream ended without a result');
    return result;
}

/** Read any gateway event stream to the end, passing every event to `onEvent`; returns the final `result` event. */
export async function readEventStream(body: ReadableStream<Uint8Array>, onEvent: (e: any) => void): Promise<any> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let result: any = null;
    for (;;) {
        const { value, done } = await reader.read();
        if (value) buffer += decoder.decode(value, { stream: true });
        const { events, rest } = parseSseChunk(done ? buffer + '\n\n' : buffer);
        buffer = rest;
        for (const e of events) {
            if (e.type === 'result') result = e;
            onEvent(e);
        }
        if (done) break;
    }
    if (!result) throw new Error('The stream ended without a result');
    return result;
}
