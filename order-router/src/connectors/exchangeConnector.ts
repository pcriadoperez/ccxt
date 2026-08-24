import ccxt, { Exchange, type OrderBook } from 'ccxt';
import type { OrderBookCache } from '../cache/orderBookCache.js';
import type { FeeRegistry } from '../cache/feeRegistry.js';
import type { BookLevel } from '../types.js';
import type { Logger } from 'pino';

// Pure, unit-testable in isolation from the network/WS machinery below.

export function chunkSymbols (symbols: string[], size: number): string[][] {
    const chunks: string[][] = [];
    for (let i = 0; i < symbols.length; i += size) {
        chunks.push(symbols.slice(i, i + size));
    }
    return chunks;
}

// ccxt's raw [price, amount] tuples type price/amount as possibly-undefined (Num = number |
// undefined); drop any level missing either before it reaches the cache, which assumes complete
// numeric levels.
export function normalizeLevels (
    levels: [number | undefined, number | undefined][],
    depth = Number.POSITIVE_INFINITY,
): BookLevel[] {
    const out: BookLevel[] = [];
    for (const level of levels) {
        if (out.length >= depth) break;
        const [price, amount] = level;
        if (price === undefined || amount === undefined) continue;
        out.push({ price, amount });
    }
    return out;
}

const BACKOFF_START_MS = 500;
const BACKOFF_MAX_MS = 30_000;
// Spacing between starting individual watch loops (per-symbol loops on exchanges that don't
// support watchOrderBookForSymbols, or per-chunk batched loops on ones that do) — without this,
// N loops means N near-simultaneous subscribe messages at startup, which is exactly what
// triggered exchange-side rate limiting and a reconnect storm when this connector was tested
// against a 400+-symbol exchange.
const LOOP_START_STAGGER_MS = 25;

function sleep (ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

// Full jitter: spreads out retries so N loops that all failed at the same instant (e.g. a shared
// WS connection dropping, which fails every per-symbol watchOrderBook call on that exchange at
// once) don't all retry in lockstep and repeat the thundering-herd rate-limit hit every backoff
// cycle.
function jittered (ms: number): number {
    return Math.random() * ms;
}

// Some failures can never succeed on retry: missing credentials, an unsupported method, a symbol
// the venue does not list. Retrying them is not resilience, it is a busy loop — one such exchange
// generated 22M log lines and ~930MB of disk while burning CPU that working venues needed. These
// must be detected and abandoned, not backed off.
const PERMANENT_ERROR_PATTERNS = [
    /requires .*credential/i,
    /requires .*apiKey/i,
    /apiKey.*required/i,
    /authentication/i,
    /not supported/i,
    /does not have/i,
    /is invalid/i,
];

export function isPermanentError (message: string): boolean {
    return PERMANENT_ERROR_PATTERNS.some((re) => re.test(message));
}

// One connector owns exactly one exchange's WS connection(s) and one or more
// symbol watch loops. A crash/error in one connector never touches another —
// each catches its own errors and reconnects with backoff independently.
export class ExchangeConnector {
    readonly exchangeId: string;
    private exchange: Exchange;
    private cache: OrderBookCache;
    private feeRegistry: FeeRegistry;
    private logger: Logger;
    private stopped = false;
    private symbols: string[] = [];
    private maxSymbolsPerSubscription: number;
    private maxSymbolsForExchange: number | undefined;
    // Levels kept per side before a book crosses the IPC boundary. See applyOrderBook.
    private maxDepth: number;

    // `existingExchange` lets a caller that already ran loadMarkets() (e.g. discovery, which
    // needs markets to compute the routable symbol universe before connectors exist) hand off
    // that same instance instead of forcing a second loadMarkets() round-trip here. Only
    // meaningful within a single process — a shard worker always constructs its own.
    constructor (
        exchangeId: string,
        cache: OrderBookCache,
        feeRegistry: FeeRegistry,
        logger: Logger,
        existingExchange?: Exchange,
        maxSymbolsPerSubscription = 50,
        maxSymbolsForExchange?: number,
        maxDepth = 500,
    ) {
        this.exchangeId = exchangeId;
        this.maxSymbolsPerSubscription = maxSymbolsPerSubscription;
        this.maxSymbolsForExchange = maxSymbolsForExchange;
        this.maxDepth = maxDepth;
        if (existingExchange) {
            this.exchange = existingExchange;
        } else {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const ExchangeClass = (ccxt.pro as any)[exchangeId];
            if (!ExchangeClass) {
                throw new Error(`ccxt.pro does not support exchange '${exchangeId}'`);
            }
            this.exchange = new ExchangeClass({ enableRateLimit: true });
        }
        this.cache = cache;
        this.feeRegistry = feeRegistry;
        this.logger = logger.child({ exchange: exchangeId });
        this.cache.initHealth(exchangeId);
    }

    async start (requestedSymbols: string[]): Promise<void> {
        if (!this.exchange.markets) {
            await this.exchange.loadMarkets();
        }
        this.symbols = requestedSymbols.filter((s) => {
            const market = this.exchange.markets?.[s];
            if (!market) {
                this.logger.warn({ symbol: s }, 'symbol not supported on this exchange, skipping');
                return false;
            }
            const takerFeeRate = market.taker ?? this.exchange.fees?.trading?.taker ?? 0.001;
            this.feeRegistry.setFee(this.exchangeId, s, takerFeeRate);
            return true;
        });

        if (this.maxSymbolsForExchange !== undefined && this.symbols.length > this.maxSymbolsForExchange) {
            const dropped = this.symbols.length - this.maxSymbolsForExchange;
            this.logger.warn(
                { requested: this.symbols.length, cap: this.maxSymbolsForExchange, dropped },
                'exceeds this exchange\'s configured total-symbol cap (session-wide subscription limit), truncating',
            );
            this.symbols = this.symbols.slice(0, this.maxSymbolsForExchange);
        }

        if (this.symbols.length === 0) return;

        // Prefer batched subscriptions over independent per-symbol ones whenever the exchange
        // supports it — that's what watchOrderBookForSymbols exists for. But even where
        // supported, exchanges cap how many symbols one subscription/session can cover (observed
        // directly: Coinbase "too many L2 streams", Bitget "subscribe over limit, max:1000",
        // KuCoin rejecting an overlong topic string) — so still chunk into
        // maxSymbolsPerSubscription-sized groups, each its own independent watch loop, rather
        // than one unbounded call for every routable symbol on the exchange.
        if (this.exchange.has?.watchOrderBookForSymbols && this.symbols.length > 1) {
            const chunks = chunkSymbols(this.symbols, this.maxSymbolsPerSubscription);
            this.logger.info(
                { symbolCount: this.symbols.length, chunkCount: chunks.length, chunkSize: this.maxSymbolsPerSubscription },
                'using batched watchOrderBookForSymbols, chunked',
            );
            chunks.forEach((chunk, i) => {
                void sleep(i * LOOP_START_STAGGER_MS).then(() => this.batchWatchLoop(chunk));
            });
        } else {
            this.logger.info(
                { symbolCount: this.symbols.length },
                'watchOrderBookForSymbols not supported here, using per-symbol loops (staggered start)',
            );
            this.symbols.forEach((symbol, i) => {
                void sleep(i * LOOP_START_STAGGER_MS).then(() => this.singleSymbolWatchLoop(symbol));
            });
        }
    }

    // Books are truncated HERE, before they cross the IPC boundary, and this is the single most
    // consequential line in the connector.
    //
    // Measured: coinbase streams 44,298 levels per update at ~165 updates/sec. Serialised, that is
    // ~31 MB/s per exchange pushed at a parent that cannot drain it — process.send() returned false
    // on 96.3% of calls, libuv queued the remainder in native write buffers, and one shard reached
    // 19.8 GB RSS with a flat 62 MB heap. An isolation test settles the attribution: bare stream
    // 131 MB, +normalize 180 MB, +stringify 193 MB, +process.send 5,444 MB.
    //
    // The router does not need that depth. A 5,000,000 USDT order fills in under 50 levels per
    // venue, so the default here is roughly an order of magnitude more than the largest order
    // measured — while being ~90x less data than the venue sends. Depth limiting was deliberately
    // declined earlier to protect large-order routing; the number below protects it, and the cost
    // of not truncating turned out to be a swapping box.
    private applyOrderBook (symbol: string, ob: OrderBook, sequence: number): void {
        this.cache.setBook({
            exchangeId: this.exchangeId,
            symbol,
            bids: normalizeLevels(ob.bids, this.maxDepth),
            asks: normalizeLevels(ob.asks, this.maxDepth),
            exchangeTimestamp: ob.timestamp ?? undefined,
            receivedAt: Date.now(),
            sequence,
        });
        this.cache.recordUpdate(this.exchangeId);
    }

    private async batchWatchLoop (symbols: string[]): Promise<void> {
        let backoff = BACKOFF_START_MS;
        let sequence = 0;
        while (!this.stopped) {
            try {
                const ob = await this.exchange.watchOrderBookForSymbols(symbols);
                sequence += 1;
                if (ob.symbol) {
                    this.applyOrderBook(ob.symbol, ob, sequence);
                }
                backoff = BACKOFF_START_MS;
            } catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                if (isPermanentError(message)) {
                    this.logger.error({ err: message, symbolCount: symbols.length },
                        'permanent failure, abandoning this subscription (will not retry)');
                    this.cache.recordError(this.exchangeId, message);
                    return;
                }
                this.logger.error({ err: message }, 'watchOrderBookForSymbols failed, backing off');
                this.cache.recordError(this.exchangeId, message);
                this.cache.recordReconnect(this.exchangeId);
                await sleep(jittered(backoff));
                backoff = Math.min(backoff * 2, BACKOFF_MAX_MS);
            }
        }
    }

    private async singleSymbolWatchLoop (symbol: string): Promise<void> {
        let backoff = BACKOFF_START_MS;
        let sequence = 0;
        while (!this.stopped) {
            try {
                const ob = await this.exchange.watchOrderBook(symbol);
                sequence += 1;
                this.applyOrderBook(symbol, ob, sequence);
                backoff = BACKOFF_START_MS;
            } catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                if (isPermanentError(message)) {
                    this.logger.error({ symbol, err: message },
                        'permanent failure, abandoning this subscription (will not retry)');
                    this.cache.recordError(this.exchangeId, message);
                    return;
                }
                this.logger.error({ symbol, err: message }, 'watchOrderBook failed, backing off');
                this.cache.recordError(this.exchangeId, message);
                this.cache.recordReconnect(this.exchangeId);
                await sleep(jittered(backoff));
                backoff = Math.min(backoff * 2, BACKOFF_MAX_MS);
            }
        }
    }

    async stop (): Promise<void> {
        this.stopped = true;
        await this.exchange.close();
    }
}
