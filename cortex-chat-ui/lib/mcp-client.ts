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
        const baseUrl = new URL(this.serverUrl);
        const healthUrl = `${baseUrl.protocol}//${baseUrl.host}/health`;
        console.log("Verifying gateway connection via:", healthUrl);

        const token = await this.getToken();
        const headers: Record<string, string> = {
            "x-api-key": "cortex_trial_key_2024"
        };
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
        // Route tool calls through the gateway's /query endpoint.
        // The orchestrator will select and execute the appropriate MCP tool.
        const baseUrl = new URL(this.serverUrl);
        const gatewayUrl = `${baseUrl.protocol}//${baseUrl.hostname}:4000/query`;

        const token = await this.getToken();
        const headers: Record<string, string> = {
            "Content-Type": "application/json",
            "x-tenant-id": this.tenantId,
            "x-api-key": "cortex_trial_key_2024"
        };
        if (token) headers["Authorization"] = `Bearer ${token}`;

        if (method === "tools/call" && params.name) {
            // Translate a direct tool call into a natural-language proxy request
            // so the gateway can authenticate and forward to the MCP server.
            const response = await fetch(
                `${baseUrl.protocol}//${baseUrl.hostname}:4000/api/${params.name}`,
                {
                    method: "POST",
                    headers,
                    body: JSON.stringify(params.arguments || {}),
                }
            );
            if (!response.ok) throw new Error(`Tool call failed: ${response.statusText}`);
            return await response.json();
        }

        throw new Error(`Unsupported sendMessage method: ${method}`);
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
