import { fetchEventSource } from "@microsoft/fetch-event-source";

export class MCPClient {
    private serverUrl: string;
    private messageUrl: string | null = null;
    private tenantId: string;
    private getToken: () => Promise<string | null>;
    private onMessageCallback: (msg: any) => void;

    constructor(serverUrl: string, tenantId: string, getToken: () => Promise<string | null>, onMessage: (msg: any) => void) {
        this.serverUrl = serverUrl;
        this.tenantId = tenantId;
        this.getToken = getToken;
        this.onMessageCallback = onMessage;
    }

    async connect() {
        console.log("Connecting to MCP Server...", this.serverUrl);
        const token = await this.getToken();

        return new Promise<void>((resolve, reject) => {
            const headers: Record<string, string> = {
                "x-tenant-id": this.tenantId,
                "x-api-key": "cortex_trial_key_2024" // Support Gateway auth during connection
            };
            if (token) {
                headers["Authorization"] = `Bearer ${token}`;
            }

            fetchEventSource(this.serverUrl, {
                headers,
                onopen: async (res) => {
                    if (res.ok) {
                        console.log("SSE Connection opened");
                    } else {
                        reject(new Error(`Failed to open SSE: ${res.statusText}`));
                    }
                },
                onmessage: (ev) => {
                    if (ev.event === "endpoint") {
                        const relativePath = ev.data;
                        const baseUrl = new URL(this.serverUrl);
                        this.messageUrl = `${baseUrl.origin}${relativePath}`;
                        console.log("Message endpoint received:", this.messageUrl);
                        resolve(); // Resolve promise once we have the message endpoint
                    } else if (ev.event === "message") {
                        try {
                            const data = JSON.parse(ev.data);
                            this.onMessageCallback(data);
                        } catch (e) {
                            console.error("Failed to parse message", e);
                        }
                    }
                },
                onerror: (err) => {
                    console.error("SSE Connection Error:", err);
                    reject(err);
                },
            });
        });
    }

    async sendMessage(method: string, params: any = {}) {
        if (!this.messageUrl) {
            throw new Error("Cannot send message: no endpoint URL received yet.");
        }

        const id = Math.floor(Math.random() * 100000);
        const body = {
            jsonrpc: "2.0",
            id,
            method,
            params,
        };

        const response = await fetch(this.messageUrl, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "x-tenant-id": this.tenantId,
                "x-api-key": "cortex_trial_key_2024"
            },
            body: JSON.stringify(body),
        });

        if (!response.ok) {
            throw new Error(`Failed to send message: ${response.statusText}`);
        }

        return id;
    }

    /**
     * Sends a natural language query to the Gateway's orchestration endpoint.
     */
    async query(question: string, history: any[] = [], forceRefresh: boolean = false, isContextualFusion: boolean = false, signal?: AbortSignal) {
        // Gateway URL is typically on port 4000
        const baseUrl = new URL(this.serverUrl);
        // Note: The /api prefix from serverUrl (if present) should be stripped to hit the root /query
        const isProxyUrl = this.serverUrl.includes("/api");
        const gatewayUrl = isProxyUrl 
            ? `${baseUrl.protocol}//${baseUrl.hostname}:4000/query`
            : `${baseUrl.protocol}//${baseUrl.hostname}:4000/query`;

        console.log(`Sending orchestration query to: ${gatewayUrl} (ForceRefresh: ${forceRefresh})`);
        const token = await this.getToken();
        
        const headers: Record<string, string> = {
            "Content-Type": "application/json",
            "x-tenant-id": this.tenantId,
            "x-api-key": "cortex_trial_key_2024" // Fallback trial key for local dev
        };
        if (token) {
            headers["Authorization"] = `Bearer ${token}`;
        }

        const response = await fetch(gatewayUrl, {
            method: "POST",
            headers,
            signal,
            body: JSON.stringify({ 
                question, 
                history, 
                forceRefresh, 
                is_contextual_fusion_on: isContextualFusion 
            }),
        });

        if (!response.ok) {
            throw new Error(`Orchestration query failed: ${response.statusText}`);
        }

        return await response.json();
    }
}
