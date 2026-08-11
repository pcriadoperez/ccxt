import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { logger } from '../logger.js';
import { extractApiKey, resolveApiKey, safeCompare } from '../api/auth.js';
import { FixedWindowRateLimiter } from '../api/rateLimiter.js';
import * as routerClient from './tools.js';
import type { RouterClientOptions } from './tools.js';

const API_BASE_URL = process.env['ORDER_ROUTER_API_URL'] ?? 'http://localhost:8080';
const MCP_PORT = Number(process.env['ORDER_ROUTER_MCP_PORT'] ?? 8081);
const MCP_HOST = process.env['ORDER_ROUTER_MCP_HOST'] ?? '0.0.0.0';
const MCP_RATE_LIMIT_MAX = Number(process.env['ORDER_ROUTER_RATE_LIMIT_MAX'] ?? 600);
const MCP_RATE_LIMIT_WINDOW_MS = Number(process.env['ORDER_ROUTER_RATE_LIMIT_WINDOW_MS'] ?? 60_000);

function textResult (data: unknown) {
    return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
}

function errorResult (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { content: [{ type: 'text' as const, text: message }], isError: true };
}

// A fresh McpServer per request, matching the SDK's documented stateless pattern — this is a
// read-only proxy over public endpoints, so there's no session state worth keeping across
// requests, and stateless mode avoids needing session-id bookkeeping entirely.
export function buildMcpServer (clientOptions: RouterClientOptions): McpServer {
    const server = new McpServer({ name: 'order-router-mcp', version: '0.1.0' });

    server.registerTool(
        'get_health',
        { title: 'Router health', description: 'Liveness check for the order-router service.' },
        async () => {
            try {
                return textResult(await routerClient.getHealth(clientOptions));
            } catch (err) {
                return errorResult(err);
            }
        },
    );

    server.registerTool(
        'get_exchanges_status',
        {
            title: 'Exchange connection status',
            description: 'Per-exchange WS health: connected, last update age, update/reconnect counts.',
        },
        async () => {
            try {
                return textResult(await routerClient.getExchangesStatus(clientOptions));
            } catch (err) {
                return errorResult(err);
            }
        },
    );

    server.registerTool(
        'list_symbols',
        { title: 'List cached symbols', description: 'Unified symbols currently cached by the router.' },
        async () => {
            try {
                return textResult(await routerClient.listSymbols(clientOptions));
            } catch (err) {
                return errorResult(err);
            }
        },
    );

    server.registerTool(
        'get_order_book',
        {
            title: 'Get order book',
            description: 'Cached L2 order book snapshot for one exchange and symbol.',
            inputSchema: {
                exchange: z.string().describe('ccxt exchange id, e.g. "kraken"'),
                symbol: z.string().describe('Unified symbol, e.g. "BTC/USDT"'),
            },
        },
        async ({ exchange, symbol }) => {
            try {
                return textResult(await routerClient.getOrderBook(exchange, symbol, clientOptions));
            } catch (err) {
                return errorResult(err);
            }
        },
    );

    server.registerTool(
        'get_best_price',
        {
            title: 'Get best execution price',
            description: 'Book-walked, fee-adjusted best execution price across exchanges for a given order size.',
            inputSchema: {
                symbol: z.string().describe('Unified symbol, e.g. "BTC/USDT"'),
                side: z.enum(['buy', 'sell']).describe('Order side'),
                amount: z.number().positive().describe('Order size in base currency units'),
            },
        },
        async ({ symbol, side, amount }) => {
            try {
                return textResult(await routerClient.getBestPrice(symbol, side, amount, clientOptions));
            } catch (err) {
                return errorResult(err);
            }
        },
    );

    return server;
}

async function handleMcpRequest (req: IncomingMessage, res: ServerResponse, apiKey: string): Promise<void> {
    const server = buildMcpServer({ baseUrl: API_BASE_URL, apiKey });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => {
        void transport.close();
        void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res);
}

async function main (): Promise<void> {
    const { apiKey, isDefault } = resolveApiKey();
    if (isDefault) {
        logger.warn(
            'ORDER_ROUTER_API_KEY is not set — MCP server is using the well-known development key '
            + 'for both inbound auth and upstream calls. Set ORDER_ROUTER_API_KEY before exposing it.',
        );
    }

    const limiter = new FixedWindowRateLimiter(MCP_RATE_LIMIT_MAX, MCP_RATE_LIMIT_WINDOW_MS);

    const httpServer = createServer((req, res) => {
        if (req.url === '/mcp' && req.method === 'POST') {
            // The MCP endpoint proxies privileged router data, so it authenticates its own callers
            // with the same key it uses upstream — otherwise it would be an open bypass around the
            // router's auth.
            const provided = extractApiKey(req.headers as Record<string, unknown>);
            const keyIsValid = provided !== undefined && safeCompare(provided, apiKey);

            // Rate limit BEFORE returning the auth verdict, and bucket by key only when the key is
            // valid. Without this the MCP port is a second, equivalent brute-force door: the
            // router's limiter lives in a different process on a different port and does not cover
            // it, so unlimited key guessing here would defeat the fix applied there.
            const bucketKey = keyIsValid ? (provided as string) : (req.socket.remoteAddress ?? 'unknown');
            const decision = limiter.consume(bucketKey);
            if (!decision.allowed) {
                res.writeHead(429, {
                    'content-type': 'application/json',
                    'retry-after': String(decision.resetSeconds),
                    'x-ratelimit-limit': String(decision.limit),
                    'x-ratelimit-remaining': String(decision.remaining),
                }).end(
                    JSON.stringify({ jsonrpc: '2.0', error: { code: -32002, message: 'rate limit exceeded' }, id: null }),
                );
                return;
            }

            if (!keyIsValid) {
                res.writeHead(401, { 'content-type': 'application/json' }).end(
                    JSON.stringify({ jsonrpc: '2.0', error: { code: -32001, message: 'unauthorized' }, id: null }),
                );
                return;
            }
            void handleMcpRequest(req, res, apiKey).catch((err) => {
                logger.error({ err }, 'MCP request handling failed');
                if (!res.headersSent) {
                    res.writeHead(500, { 'content-type': 'application/json' }).end(
                        JSON.stringify({ jsonrpc: '2.0', error: { code: -32603, message: 'internal error' }, id: null }),
                    );
                }
            });
            return;
        }
        if (req.url === '/health' && req.method === 'GET') {
            res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ status: 'ok' }));
            return;
        }
        res.writeHead(404).end();
    });

    httpServer.listen(MCP_PORT, MCP_HOST, () => {
        logger.info({ port: MCP_PORT, apiBaseUrl: API_BASE_URL }, 'order-router MCP server listening');
    });
}

// Only auto-start when run directly (`node dist/mcp/server.js`) — importing buildMcpServer for
// tests should never open a port as a side effect.
if (import.meta.url === `file://${process.argv[1]}`) {
    main().catch((err) => {
        logger.error({ err }, 'fatal MCP server startup error');
        process.exit(1);
    });
}
