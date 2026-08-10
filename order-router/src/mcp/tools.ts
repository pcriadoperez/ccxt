// Thin proxies over the order-router's own public REST endpoints — the MCP server is just
// another consumer of the public API, not a second implementation of the routing logic. Kept
// separate from src/mcp/server.ts (the MCP wiring) so these can be unit tested by pointing
// `baseUrl` at a local HTTP fixture, without needing a real MCP client/transport.

export interface RouterClientOptions {
    baseUrl: string;
    // Forwarded upstream as X-API-Key. The MCP server authenticates its own callers separately;
    // this is the credential it uses to call the router on their behalf.
    apiKey?: string;
    fetchImpl?: typeof fetch;
}

async function getJson (path: string, options: RouterClientOptions): Promise<unknown> {
    const fetchImpl = options.fetchImpl ?? fetch;
    const headers: Record<string, string> = {};
    if (options.apiKey) {
        headers['x-api-key'] = options.apiKey;
    }
    const response = await fetchImpl(`${options.baseUrl}${path}`, { headers });
    const body = await response.json();
    if (!response.ok) {
        const message = typeof body === 'object' && body && 'error' in body ? String((body as { error: unknown }).error) : response.statusText;
        throw new Error(`order-router API ${response.status}: ${message}`);
    }
    return body;
}

export function getHealth (options: RouterClientOptions): Promise<unknown> {
    return getJson('/health', options);
}

export function getExchangesStatus (options: RouterClientOptions): Promise<unknown> {
    return getJson('/exchanges/status', options);
}

export function listSymbols (options: RouterClientOptions): Promise<unknown> {
    return getJson('/symbols', options);
}

export function getOrderBook (exchange: string, symbol: string, options: RouterClientOptions): Promise<unknown> {
    const path = `/orderbook/${encodeURIComponent(exchange)}/${encodeURIComponent(symbol)}`;
    return getJson(path, options);
}

export function getBestPrice (
    symbol: string,
    side: 'buy' | 'sell',
    amount: number,
    options: RouterClientOptions,
): Promise<unknown> {
    const path = `/price/best/${encodeURIComponent(symbol)}?side=${side}&amount=${amount}`;
    return getJson(path, options);
}
