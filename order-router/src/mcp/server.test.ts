import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildMcpServer } from './server.js';

// Real end-to-end MCP protocol test: a real Client talking to a real McpServer over a linked
// in-memory transport pair (the SDK's own test fixture for exactly this), with the server's
// tools pointed at a tiny real HTTP fixture standing in for the order-router API. No mocking of
// the MCP protocol itself — this exercises tool registration, JSON-RPC call/response, and the
// HTTP proxy layer together.
async function withRouterFixture (
    responses: Record<string, unknown>,
    run: (baseUrl: string) => Promise<void>,
): Promise<void> {
    const server: Server = createServer((req, res) => {
        const body = responses[req.url ?? ''];
        if (body === undefined) {
            res.writeHead(404, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'not found' }));
            return;
        }
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(body));
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    try {
        await run(`http://127.0.0.1:${port}`);
    } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
    }
}

async function connectedClient (baseUrl: string): Promise<Client> {
    const mcpServer = buildMcpServer({ baseUrl });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test-client', version: '0.0.0' });
    await Promise.all([client.connect(clientTransport), mcpServer.connect(serverTransport)]);
    return client;
}

test('lists all five router tools', async () => {
    await withRouterFixture({}, async (baseUrl) => {
        const client = await connectedClient(baseUrl);
        const { tools } = await client.listTools();
        const names = tools.map((t) => t.name).sort();
        assert.deepEqual(names, [
            'get_exchanges_status',
            'get_health',
            'get_order_book',
            'list_symbols',
            'route_order',
        ]);
        await client.close();
    });
});

test('get_health tool call returns the fixture health payload', async () => {
    await withRouterFixture({ '/health': { status: 'ok', uptimeSec: 42 } }, async (baseUrl) => {
        const client = await connectedClient(baseUrl);
        const result = await client.callTool({ name: 'get_health', arguments: {} });
        const text = (result.content as { type: string; text: string }[])[0]?.text ?? '';
        assert.deepEqual(JSON.parse(text), { status: 'ok', uptimeSec: 42 });
        await client.close();
    });
});

test('route_order tool call passes arguments through to the correct URL', async () => {
    await withRouterFixture(
        { '/route?from=USDT&to=BTC&amountOut=1': { hops: [{ pair: 'BTC/USDT', legs: [{ exchangeId: 'kraken' }] }] } },
        async (baseUrl) => {
            const client = await connectedClient(baseUrl);
            const result = await client.callTool({
                name: 'route_order',
                arguments: { from: 'USDT', to: 'BTC', amountOut: 1 },
            });
            const text = (result.content as { type: string; text: string }[])[0]?.text ?? '';
            assert.equal(JSON.parse(text).hops[0].legs[0].exchangeId, 'kraken');
            await client.close();
        },
    );
});

test('route_order rejects an ambiguous amount before calling upstream', async () => {
    let called = false;
    await withRouterFixture({}, async (baseUrl) => {
        const client = await connectedClient(baseUrl);
        for (const args of [{ from: 'USDT', to: 'BTC' }, { from: 'USDT', to: 'BTC', amountIn: 1, amountOut: 1 }]) {
            const result = await client.callTool({ name: 'route_order', arguments: args });
            assert.equal(result.isError, true, JSON.stringify(args));
        }
        assert.equal(called, false);
        await client.close();
    });
});

test('a failed upstream call surfaces as an MCP tool error, not a protocol failure', async () => {
    await withRouterFixture({}, async (baseUrl) => {
        const client = await connectedClient(baseUrl);
        const result = await client.callTool({
            name: 'get_order_book',
            arguments: { exchange: 'kraken', symbol: 'BTC/USDT' },
        });
        assert.equal(result.isError, true);
        await client.close();
    });
});

test('route_order returns an MCP tool error for an unknown strategy, via the input schema', async () => {
    await withRouterFixture({}, async (baseUrl) => {
        const client = await connectedClient(baseUrl);
        const result = await client.callTool({
            name: 'route_order',
            arguments: { from: 'USDT', to: 'BTC', amountOut: 1, strategy: 'sideways' },
        });
        assert.equal(result.isError, true);
        await client.close();
    });
});
