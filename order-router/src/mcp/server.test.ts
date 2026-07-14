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
            'get_best_price',
            'get_exchanges_status',
            'get_health',
            'get_order_book',
            'list_symbols',
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

test('get_best_price tool call passes arguments through to the correct URL', async () => {
    await withRouterFixture(
        { '/price/best/BTC%2FUSDT?side=buy&amount=1': { symbol: 'BTC/USDT', best: { exchangeId: 'kraken' } } },
        async (baseUrl) => {
            const client = await connectedClient(baseUrl);
            const result = await client.callTool({
                name: 'get_best_price',
                arguments: { symbol: 'BTC/USDT', side: 'buy', amount: 1 },
            });
            const text = (result.content as { type: string; text: string }[])[0]?.text ?? '';
            assert.equal(JSON.parse(text).best.exchangeId, 'kraken');
            await client.close();
        },
    );
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

test('get_best_price returns an MCP tool error for an invalid side, via the input schema', async () => {
    await withRouterFixture({}, async (baseUrl) => {
        const client = await connectedClient(baseUrl);
        const result = await client.callTool({
            name: 'get_best_price',
            arguments: { symbol: 'BTC/USDT', side: 'sideways', amount: 1 },
        });
        assert.equal(result.isError, true);
        await client.close();
    });
});
