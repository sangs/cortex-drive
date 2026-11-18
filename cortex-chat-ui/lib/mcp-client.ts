import type { ClarifyChoice } from '../utils/clarify';
import { readEventStream, readQueryStream } from '../utils/queryStream';
import type { QueryProgressEvent } from '../utils/queryStream';
import { GATEWAY_URL } from './gateway';

/**
 * The gateway's message for a failed request, when it is one of its safe ones: the owner's pause ({paused: true, error})
 * or a classified failure ({error, code}, S2-90: fixed text by class, never a raw cause). Otherwise the fallback.
 */
async function gatewayErrorMessage(response: Response, fallback: string): Promise<string> {
    const body = await response.clone().json().catch(() => null);
    const safe = body && typeof body.error === "string" && (body.paused === true || typeof body.code === "string");
    return safe ? body.error : fallback;
}

export class MCPClient {
    private tenantId: string;
    private getToken: () => Promise<string | null>;
    private onMessageCallback: (msg: any) => void;

    constructor(tenantId: string, getToken: () => Promise<string | null>, onMessage: (msg: any) => void) {
        this.tenantId = tenantId;
        this.getToken = getToken;
        this.onMessageCallback = onMessage;
    }

    async connect() {
        const gatewayBase = GATEWAY_URL;
        const healthUrl = `${gatewayBase}/health`;
        console.log("Verifying gateway connection via:", healthUrl);

        const token = await this.getToken();
        // No x-api-key: the dashboard is sign-in only, so the Clerk token is the sole credential.
        const headers: Record<string, string> = {};
        if (token) {
            headers["Authorization"] = `Bearer ${token}`;
        }

        const res = await fetch(healthUrl, { headers });
        if (!res.ok) {
            throw new Error(`Gateway health check failed: ${res.status} ${res.statusText}`);
        }
        console.log("Gateway connection established.");
    }

    async sendMessage(method: string, params: any = {}): Promise<any> {
        const gatewayBase = GATEWAY_URL;

        const token = await this.getToken();
        const headers: Record<string, string> = {
            "Content-Type": "application/json",
            "x-tenant-id": this.tenantId,
        };
        if (token) headers["Authorization"] = `Bearer ${token}`;

        if (method === "tools/call" && params.name) {
            const response = await fetch(
                `${gatewayBase}/api/${params.name}`,
                {
                    method: "POST",
                    headers,
                    body: JSON.stringify(params.arguments || {}),
                }
            );
            if (!response.ok) throw new Error(await gatewayErrorMessage(response, `Tool call failed: ${response.statusText}`));
            return await response.json();
        }

        throw new Error(`Unsupported sendMessage method: ${method}`);
    }

    /**
     * Bento panel bridges on one streamed request (design 2026-11-09 §4.2, step 4c): `progress`, a `partial` per
     * domain, then `result`. Every event goes to `onEvent`; resolves with the final result.
     */
    async streamBridges(body: Record<string, unknown>, onEvent: (e: any) => void, signal?: AbortSignal) {
        const gatewayBase = GATEWAY_URL;
        const token = await this.getToken();
        const headers: Record<string, string> = {
            "Content-Type": "application/json",
            "x-tenant-id": this.tenantId,
            "Accept": "text/event-stream",
        };
        if (token) headers["Authorization"] = `Bearer ${token}`;
        const response = await fetch(`${gatewayBase}/api/bridges/stream`, { method: "POST", headers, signal, body: JSON.stringify(body) });
        if (!response.ok || !response.body) throw new Error(await gatewayErrorMessage(response, `Bridge discovery failed: ${response.statusText}`));
        return await readEventStream(response.body, onEvent);
    }

    /**
     * Sends a natural language query to the Gateway's orchestration endpoint.
     */
    async query(question: string, history: any[] = [], forceRefresh: boolean = false, signal?: AbortSignal, conversationId?: string,
                clarifyChoice?: ClarifyChoice, onProgress?: (event: QueryProgressEvent) => void) {
        const gatewayBase = GATEWAY_URL;
        const gatewayUrl = `${gatewayBase}/query`;

        console.log(`Sending orchestration query to: ${gatewayUrl} (ForceRefresh: ${forceRefresh})`);
        const token = await this.getToken();

        const headers: Record<string, string> = {
            "Content-Type": "application/json",
            "x-tenant-id": this.tenantId,
            // Cross-domain answers stream per-domain progress (design 2026-11-09 §4.2); everything else stays JSON.
            "Accept": "text/event-stream, application/json",
        };
        if (token) {
            headers["Authorization"] = `Bearer ${token}`;
        }

        const response = await fetch(gatewayUrl, {
            method: "POST",
            headers,
            signal,
            // clarify_choice: the option picked in a clarifying question (routing v2, design 2026-11-09 §4.5).
            body: JSON.stringify({ question, history, forceRefresh, conversationId, ...(clarifyChoice ? { clarify_choice: clarifyChoice } : {}) }),
        });

        if (!response.ok) {
            // The owner's pause and every classified failure (S2-90) carry a safe, fixed message: show it as it is.
            throw new Error(await gatewayErrorMessage(response, `Orchestration query failed: ${response.statusText}`));
        }

        if ((response.headers.get("Content-Type") || "").includes("text/event-stream") && response.body) {
            return await readQueryStream(response.body, onProgress);
        }
        return await response.json();
    }
}
