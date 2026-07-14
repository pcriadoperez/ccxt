import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import * as routerClient from './tools.js';

// A tiny real HTTP fixture standing in for the order-router's own API, rather than mocking
// fetch — exercises the actual request/response path (URL construction, JSON parsing, error
// handling on non-2xx) the way the MCP server will really use it.
async function withFixture (
    handler: (path: string) => { status: number; body: unknown },
    run: (baseUrl: string) => Promise<void>,
): Promise<void> {
    const server: Server = createServer((req, res) => {
        const { status, body } = handler(req.url ?? '/');
        res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
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

test('getHealth returns the fixture body on success', async () => {
    await withFixture(
        () => ({ status: 200, body: { status: 'ok' } }),
        async (baseUrl) => {
            const result = await routerClient.getHealth({ baseUrl });
            assert.deepEqual(result, { status: 'ok' });
        },
    );
});

test('getOrderBook URL-encodes exchange and symbol', async () => {
    let capturedPath = '';
    await withFixture(
        (path) => {
            capturedPath = path;
            return { status: 200, body: { exchangeId: 'kraken', symbol: 'BTC/USDT' } };
        },
        async (baseUrl) => {
            await routerClient.getOrderBook('kraken', 'BTC/USDT', { baseUrl });
        },
    );
    assert.equal(capturedPath, '/orderbook/kraken/BTC%2FUSDT');
});

test('getBestPrice builds the correct query string', async () => {
    let capturedPath = '';
    await withFixture(
        (path) => {
            capturedPath = path;
            return { status: 200, body: { best: null } };
        },
        async (baseUrl) => {
            await routerClient.getBestPrice('ETH/USDT', 'sell', 2.5, { baseUrl });
        },
    );
    assert.equal(capturedPath, '/price/best/ETH%2FUSDT?side=sell&amount=2.5');
});

test('a non-2xx response throws with the error body message', async () => {
    await withFixture(
        () => ({ status: 404, body: { error: 'no cached order book for kraken:BTC/USDT' } }),
        async (baseUrl) => {
            await assert.rejects(
                () => routerClient.getOrderBook('kraken', 'BTC/USDT', { baseUrl }),
                /no cached order book for kraken:BTC\/USDT/,
            );
        },
    );
});

test('listSymbols and getExchangesStatus round-trip fixture data', async () => {
    await withFixture(
        (path) => {
            if (path === '/symbols') return { status: 200, body: { symbols: ['BTC/USDT'] } };
            if (path === '/exchanges/status') return { status: 200, body: { exchanges: [] } };
            return { status: 404, body: { error: 'not found' } };
        },
        async (baseUrl) => {
            assert.deepEqual(await routerClient.listSymbols({ baseUrl }), { symbols: ['BTC/USDT'] });
            assert.deepEqual(await routerClient.getExchangesStatus({ baseUrl }), { exchanges: [] });
        },
    );
});
