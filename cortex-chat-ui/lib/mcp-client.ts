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
        const gatewayBase = process.env.NEXT_PUBLIC_GATEWAY_URL || `${baseUrl.protocol}//${baseUrl.host}`;
        const healthUrl = `${gatewayBase}/health`;
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
        const baseUrl = new URL(this.serverUrl);
        const gatewayBase = process.env.NEXT_PUBLIC_GATEWAY_URL || `${baseUrl.protocol}//${baseUrl.hostname}:4000`;

        const token = await this.getToken();
        const headers: Record<string, string> = {
            "Content-Type": "application/json",
            "x-tenant-id": this.tenantId,
            "x-api-key": "cortex_trial_key_2024"
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
            if (!response.ok) throw new Error(`Tool call failed: ${response.statusText}`);
            return await response.json();
        }

        throw new Error(`Unsupported sendMessage method: ${method}`);
    }

    /**
     * Sends a natural language query to the Gateway's orchestration endpoint.
     */
    async query(question: string, history: any[] = [], forceRefresh: boolean = false, signal?: AbortSignal, conversationId?: string) {
        const baseUrl = new URL(this.serverUrl);
        const gatewayBase = process.env.NEXT_PUBLIC_GATEWAY_URL || `${baseUrl.protocol}//${baseUrl.hostname}:4000`;
        const gatewayUrl = `${gatewayBase}/query`;

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
            body: JSON.stringify({ question, history, forceRefresh, conversationId }),
        });

        if (!response.ok) {
            throw new Error(`Orchestration query failed: ${response.statusText}`);
        }

        return await response.json();
    }
}
