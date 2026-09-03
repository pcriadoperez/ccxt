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
        // Reject anything that is not a usable level, not merely a missing one. A zero or negative
        // price sorts to the front of the merged book and wins the allocation, and the walk then
        // divides by it — reporting unlimited size at no cost from one venue. NaN is worse: it
        // fails every comparison, so it is neither filtered nor ordered and simply poisons the
        // arithmetic downstream. The venues that motivated the crossed-book guard (deepcoin,
        // whitebit) are proof that books arrive corrupt, and that guard only inspects the top of
        // each side — a bad level in the interior reaches the cache untouched without this.
        if (price === undefined || amount === undefined) continue;
        if (!Number.isFinite(price) || !Number.isFinite(amount)) continue;
        if (price <= 0 || amount <= 0) continue;
        out.push({ price, amount });
    }
    return out;
}

// A single venue's own book cannot legitimately cross: if the best bid were above the best ask,
// the exchange's own matching engine would have filled them against each other. So a crossed book
// is proof of corrupt local state, never a market condition, and rejecting one has no false
// positives. Locked books (bid exactly equal to ask) DO occur briefly on some venues and are
// harmless to walk, so the test is strict.
//
// Observed live: deepcoin held bid 79,802.10 against ask 79,009.70, and whitebit bid 79,771.53
// against ask 79,111.05, while the true market on both was ~79,426. The crossing width tracked
// BTC's recent trading range, which is the signature of lost deletes — bids keep the highest price
// they ever saw and asks the lowest, so a book that never prunes slowly accumulates the envelope
// of every price it has quoted. Left alone it is worse than useless: the phantom ask is the
// cheapest in the market, so the router routes the whole order to precisely the corrupt venue.
export function isCrossedBook (bids: BookLevel[], asks: BookLevel[]): boolean {
    const bestBid = bids[0];
    const bestAsk = asks[0];
    if (bestBid === undefined || bestAsk === undefined) return false;
    return bestBid.price > bestAsk.price;
}

// A resync closes the exchange's sockets, so it must not run back-to-back on a venue that is
// emitting corrupt updates continuously — one reconnect per minute is enough to repair while
// staying far below any venue's connection rate limit.
const RESYNC_MIN_INTERVAL_MS = 60_000;
// ...but some venues are not repairable by reconnecting at all. Measured live: bitget re-crossed
// within seconds of every fresh snapshot and sustained ~30 crossed books/sec through repeated
// resyncs, while deepcoin was fixed by its first one. Hammering an unfixable venue with a
// reconnect every minute forever buys nothing and is a good way to earn a connection ban.
const RESYNC_MAX_INTERVAL_MS = 30 * 60_000;

// Escalation rule for corruption-triggered resyncs, kept pure so it is testable without a socket.
// `quietForMs` is the gap since the last resync; because this decision is only reached when the
// venue is corrupt RIGHT NOW, a short gap is evidence the last resync did not work, and a long one
// is evidence the venue recovered by itself and the escalation should be dropped.
export function nextResyncBackoffMs (
    currentBackoffMs: number,
    quietForMs: number,
    everResynced: boolean,
): number {
    if (everResynced && quietForMs <= currentBackoffMs * 2) {
        return Math.min(currentBackoffMs * 2, RESYNC_MAX_INTERVAL_MS);
    }
    return RESYNC_MIN_INTERVAL_MS;
}
// Belt-and-braces sweep for corruption that has accumulated but not yet crossed. Every venue
// rebuilds from a fresh snapshot at least this often, which bounds how long undetected drift can
// survive. Staggered per connector so ~60 exchanges never reconnect together.
const PERIODIC_RESYNC_MS = 60 * 60_000;

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

// ccxt.pro drops a client from `exchange.clients` when its connection errors, but does NOT close
// the underlying socket — so the socket stays OPEN, keeps receiving and keeps dispatching into the
// same message handler, with nothing left holding a reference that could close it.
//
// Verified directly against bitstamp: three forced errors produced three clients removed from
// exchange.clients, all three with connection.readyState === 1. On the live box this showed as 78
// sockets to one okx host and 45 to coinbase — roughly one orphan per logged watch error — and the
// duplicate traffic multiplies the very message rate that saturates the IPC channel and the event
// loop. Measured amplification: one live connection plus ten orphans took 125 msg/s to 1,378.
//
// This is a bug in ccxt.pro and belongs upstream. Until then the connector reaps them itself: any
// client it saw before a failure that the exchange no longer owns is ours to close.
export function reapOrphanedSockets (
    exchange: { clients?: Record<string, unknown> },
    seen: Set<unknown>,
    logger: Logger,
): number {
    const owned = new Set(Object.values(exchange.clients ?? {}));
    let closed = 0;
    for (const client of seen) {
        if (owned.has(client)) continue;
        if (client === null || typeof client !== 'object') continue;
        const c = client as { connection?: { readyState?: number }; close?: () => unknown };
        // 1 is OPEN, 0 is CONNECTING — both still hold a socket. Anything else is already gone.
        // ccxt internals are not ours, so an unrecognised shape must degrade to doing nothing
        // rather than throwing from inside a handler that is already handling a failure.
        const state = c.connection?.readyState;
        if (state !== 1 && state !== 0) continue;
        try {
            c.close?.();
            closed += 1;
        } catch {
            // Already closing, or a shape we do not recognise. Nothing useful to do.
        }
    }
    seen.clear();
    if (closed > 0) logger.warn({ closed }, 'closed orphaned websocket clients ccxt left open');
    return closed;
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
//
// The classification is asymmetric on purpose. Retrying a permanent failure wastes CPU; calling a
// TRANSIENT failure permanent silently and irreversibly removes a venue from routing for the
// lifetime of the process. So the default is retry, and only evidence strong enough to be sure
// buys an abandonment.
//
// Message text is not that evidence. These four all matched the old patterns and are all
// recoverable — measured against the patterns as they were:
//
//   binance {"code":-1021,"msg":"Timestamp for this request is invalid."}   (clock drift)
//   okx {"code":"50113","msg":"Invalid Sign"} signature is invalid          (clock drift)
//   kraken EAPI:Invalid nonce - the nonce is invalid, retry                 (nonce race)
//   bybit authentication in progress, please retry                          (handshake)
//
// ccxt already answers the question structurally, so ask it that way instead. Everything under
// NetworkError/OperationFailed — RequestTimeout, ExchangeNotAvailable, OnMaintenance,
// RateLimitExceeded and, importantly, InvalidNonce — is by definition retryable. The message
// patterns survive only as a fallback for errors thrown before ccxt wraps them, and no longer
// carry the two that produced every false positive above (/authentication/ and /is invalid/).
const PERMANENT_ERROR_PATTERNS = [
    /requires .*credential/i,
    /requires .*apiKey/i,
    /apiKey.*required/i,
    /not supported/i,
    /does not have/i,
];

export function isPermanentError (err: unknown): boolean {
    // A ccxt error classifies itself. NetworkError is checked FIRST because InvalidNonce lives
    // under it while reading, in text, exactly like an authentication failure.
    if (err instanceof ccxt.NetworkError || err instanceof ccxt.OperationFailed) {
        return false;
    }
    if (err instanceof ccxt.NotSupported
        || err instanceof ccxt.BadSymbol
        || err instanceof ccxt.ArgumentsRequired
        || err instanceof ccxt.AuthenticationError) {
        return true;
    }
    if (err instanceof ccxt.BaseError) {
        // A plain ExchangeError or BadRequest is not proof of anything permanent; retry it.
        return false;
    }
    const message = err instanceof Error ? err.message : String(err);
    return PERMANENT_ERROR_PATTERNS.some((re) => re.test(message));
}

// A venue that will not serve the requested depth is rejecting the LIMIT, not the subscription.
// ccxt reports that as NotSupported or a BadRequest naming the limit — both of which the
// permanent-error rules above would otherwise read as "abandon this venue forever". Dropping the
// limit and carrying on unlimited costs bandwidth; abandoning costs the venue.
const LIMIT_REJECTION_PATTERNS = [
    /limit/i,
    /depth/i,
];

export function isLimitRejection (err: unknown, limit: number | undefined): boolean {
    if (limit === undefined) return false;
    if (err instanceof ccxt.NotSupported) return true;
    if (!(err instanceof ccxt.BadRequest) && !(err instanceof ccxt.ArgumentsRequired)) return false;
    const message = err instanceof Error ? err.message : String(err);
    return LIMIT_REJECTION_PATTERNS.some((re) => re.test(message));
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
    // Depth asked of the VENUE, as opposed to maxDepth which is what is kept after the book
    // arrives. Truncating on arrival fixed the memory blow-up but not the bandwidth: the venue
    // still streams every level, ccxt still parses and holds them, and 90+% of that work is
    // discarded a moment later. Where a venue offers a depth-limited channel (binance @depth20,
    // okx books5) ccxt selects it from this argument, so the levels are never sent at all.
    //
    // Undefined once a venue has told us it will not take a limit — see limitRejected.
    private watchLimit: number | undefined;
    // Latched when a venue rejects the limit itself rather than the subscription. Retrying the
    // same rejected limit forever would be a busy loop, and treating it as permanent would
    // abandon a venue over a bandwidth preference; so the limit is dropped once, for this venue,
    // and the loop carries on unlimited.
    private limitRejected = false;
    private lastResyncAt = 0;
    private resyncBackoffMs = RESYNC_MIN_INTERVAL_MS;
    private resyncTimer: NodeJS.Timeout | undefined;

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
        this.watchLimit = maxDepth;
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

        // Stagger the periodic resync by a stable per-exchange offset rather than a random one, so
        // the reconnect schedule is reproducible across restarts and two exchanges that happen to
        // collide keep colliding visibly instead of intermittently.
        let offset = 0;
        for (let i = 0; i < this.exchangeId.length; i++) {
            offset = (offset * 31 + this.exchangeId.charCodeAt(i)) % PERIODIC_RESYNC_MS;
        }
        this.resyncTimer = setTimeout(() => {
            this.resyncTimer = setInterval(() => {
                void this.resync('periodic snapshot refresh', true);
            }, PERIODIC_RESYNC_MS);
            this.resyncTimer.unref?.();
            void this.resync('periodic snapshot refresh', true);
        }, offset);
        this.resyncTimer.unref?.();

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

    // Returns true when the failure was the venue refusing the depth limit rather than the
    // subscription, in which case the limit is dropped for this venue and the caller retries
    // immediately — with no backoff, because nothing was actually wrong with the connection.
    private dropLimitIfRejected (err: unknown, message: string): boolean {
        if (this.limitRejected || !isLimitRejection(err, this.watchLimit)) return false;
        this.limitRejected = true;
        this.watchLimit = undefined;
        this.logger.warn({ err: message, droppedLimit: this.maxDepth },
            'venue refused the depth limit, resubscribing without one (books are still truncated on arrival)');
        return true;
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
        const bids = normalizeLevels(ob.bids, this.maxDepth);
        const asks = normalizeLevels(ob.asks, this.maxDepth);
        // Reject rather than store. The previously cached book stays, which is stale but real, and
        // the existing staleness cutoff retires it within seconds if the resync does not land
        // first — whereas storing this one would put a phantom price into routing immediately.
        if (isCrossedBook(bids, asks)) {
            this.cache.recordCrossed(this.exchangeId);
            this.logger.warn(
                { symbol, bestBid: bids[0]?.price, bestAsk: asks[0]?.price },
                'crossed order book, rejecting update and scheduling resync',
            );
            void this.resync(`crossed book on ${symbol}`);
            return;
        }
        this.cache.setBook({
            exchangeId: this.exchangeId,
            symbol,
            bids,
            asks,
            exchangeTimestamp: ob.timestamp ?? undefined,
            receivedAt: Date.now(),
            sequence,
        });
        this.cache.recordUpdate(this.exchangeId);
    }

    // Rebuilds this exchange's books from scratch. Two steps, and both are needed: dropping
    // ccxt.pro's accumulated OrderBook objects discards the corrupt levels, and closing the
    // sockets makes the watch loops reconnect and resubscribe — which is what actually produces a
    // fresh snapshot. Closing alone would reconnect onto the same poisoned OrderBook, since
    // ccxt.pro keeps it across a reconnect.
    //
    // Deliberately exchange-agnostic. The underlying defect is in individual ccxt.pro
    // implementations dropping deletes (deepcoin, for one, discards a whole message when its `mt`
    // timestamp fails to advance, deletes included), and auditing ~60 of those is not a thing this
    // service can depend on. Resubscribing is the one repair that works the same everywhere.
    private async resync (reason: string, force = false): Promise<void> {
        const now = Date.now();
        if (!force && now - this.lastResyncAt < this.resyncBackoffMs) return;
        // The periodic sweep is exempt from escalation: it is a scheduled refresh rather than a
        // fault report, and letting it drive the backoff would inflate the interval on venues that
        // are perfectly healthy.
        if (!force) {
            this.resyncBackoffMs = nextResyncBackoffMs(
                this.resyncBackoffMs,
                now - this.lastResyncAt,
                this.lastResyncAt !== 0,
            );
        }
        this.lastResyncAt = now;
        this.cache.recordResync(this.exchangeId);
        this.logger.warn({ reason, nextAttemptAfterMs: this.resyncBackoffMs }, 'forcing order book resync');
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const books = (this.exchange as any).orderbooks;
        if (books !== undefined && books !== null) {
            for (const key of Object.keys(books)) delete books[key];
        }
        for (const client of Object.values(this.exchange.clients ?? {})) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            try { await (client as any)?.close?.(); } catch { /* already closing */ }
        }
    }

    private async batchWatchLoop (symbols: string[]): Promise<void> {
        let backoff = BACKOFF_START_MS;
        let sequence = 0;
        const seen = new Set<unknown>();
        while (!this.stopped) {
            try {
                for (const c of Object.values(this.exchange.clients ?? {})) seen.add(c);
                const ob = await this.exchange.watchOrderBookForSymbols(symbols, this.watchLimit);
                sequence += 1;
                if (ob.symbol) {
                    this.applyOrderBook(ob.symbol, ob, sequence);
                }
                backoff = BACKOFF_START_MS;
            } catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                if (this.dropLimitIfRejected(err, message)) continue;
                if (isPermanentError(err)) {
                    this.logger.error({ err: message, symbolCount: symbols.length, symbols },
                        'permanent failure, abandoning this subscription (will not retry)');
                    this.cache.recordError(this.exchangeId, message);
                    this.cache.recordAbandoned(this.exchangeId, symbols, message);
                    return;
                }
                this.logger.error({ err: message }, 'watchOrderBookForSymbols failed, backing off');
                this.cache.recordError(this.exchangeId, message);
                this.cache.recordReconnect(this.exchangeId);
                reapOrphanedSockets(this.exchange, seen, this.logger);
                await sleep(jittered(backoff));
                backoff = Math.min(backoff * 2, BACKOFF_MAX_MS);
            }
        }
    }

    private async singleSymbolWatchLoop (symbol: string): Promise<void> {
        let backoff = BACKOFF_START_MS;
        let sequence = 0;
        const seenPerSymbol = new Set<unknown>();
        while (!this.stopped) {
            try {
                for (const c of Object.values(this.exchange.clients ?? {})) seenPerSymbol.add(c);
                const ob = await this.exchange.watchOrderBook(symbol, this.watchLimit);
                sequence += 1;
                this.applyOrderBook(symbol, ob, sequence);
                backoff = BACKOFF_START_MS;
            } catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                if (this.dropLimitIfRejected(err, message)) continue;
                if (isPermanentError(err)) {
                    this.logger.error({ symbol, err: message },
                        'permanent failure, abandoning this subscription (will not retry)');
                    this.cache.recordError(this.exchangeId, message);
                    this.cache.recordAbandoned(this.exchangeId, [ symbol ], message);
                    return;
                }
                this.logger.error({ symbol, err: message }, 'watchOrderBook failed, backing off');
                this.cache.recordError(this.exchangeId, message);
                this.cache.recordReconnect(this.exchangeId);
                reapOrphanedSockets(this.exchange, seenPerSymbol, this.logger);
                await sleep(jittered(backoff));
                backoff = Math.min(backoff * 2, BACKOFF_MAX_MS);
            }
        }
    }

    async stop (): Promise<void> {
        this.stopped = true;
        if (this.resyncTimer !== undefined) {
            clearTimeout(this.resyncTimer);
            clearInterval(this.resyncTimer);
            this.resyncTimer = undefined;
        }
        await this.exchange.close();
    }
}
