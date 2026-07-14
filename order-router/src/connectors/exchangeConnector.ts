import ccxt, { Exchange } from 'ccxt';
import type { OrderBookCache } from '../cache/orderBookCache.js';
import type { Logger } from 'pino';

const BACKOFF_START_MS = 500;
const BACKOFF_MAX_MS = 30_000;

function sleep (ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

// One connector owns exactly one exchange's WS connection(s) and one or more
// symbol watch loops. A crash/error in one connector never touches another —
// each catches its own errors and reconnects with backoff independently.
export class ExchangeConnector {
    readonly exchangeId: string;
    private exchange: Exchange;
    private cache: OrderBookCache;
    private logger: Logger;
    private stopped = false;
    private symbols: string[] = [];

    constructor (exchangeId: string, cache: OrderBookCache, logger: Logger) {
        this.exchangeId = exchangeId;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const ExchangeClass = (ccxt.pro as any)[exchangeId];
        if (!ExchangeClass) {
            throw new Error(`ccxt.pro does not support exchange '${exchangeId}'`);
        }
        this.exchange = new ExchangeClass({ enableRateLimit: true });
        this.cache = cache;
        this.logger = logger.child({ exchange: exchangeId });
        this.cache.initHealth(exchangeId);
    }

    getTakerFee (symbol: string): number {
        const market = this.exchange.markets?.[symbol];
        return market?.taker ?? this.exchange.fees?.trading?.taker ?? 0.001;
    }

    async start (requestedSymbols: string[]): Promise<void> {
        await this.exchange.loadMarkets();
        this.symbols = requestedSymbols.filter((s) => {
            const supported = Boolean(this.exchange.markets?.[s]);
            if (!supported) {
                this.logger.warn({ symbol: s }, 'symbol not supported on this exchange, skipping');
            }
            return supported;
        });
        for (const symbol of this.symbols) {
            void this.watchLoop(symbol);
        }
    }

    private async watchLoop (symbol: string): Promise<void> {
        let backoff = BACKOFF_START_MS;
        let sequence = 0;
        while (!this.stopped) {
            try {
                const ob = await this.exchange.watchOrderBook(symbol);
                sequence += 1;
                this.cache.setBook({
                    exchangeId: this.exchangeId,
                    symbol,
                    bids: ob.bids
                        .filter(([price, amount]) => price !== undefined && amount !== undefined)
                        .map(([price, amount]) => ({ price: price as number, amount: amount as number })),
                    asks: ob.asks
                        .filter(([price, amount]) => price !== undefined && amount !== undefined)
                        .map(([price, amount]) => ({ price: price as number, amount: amount as number })),
                    exchangeTimestamp: ob.timestamp ?? undefined,
                    receivedAt: Date.now(),
                    sequence,
                });
                this.cache.recordUpdate(this.exchangeId);
                backoff = BACKOFF_START_MS;
            } catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                this.logger.error({ symbol, err: message }, 'watchOrderBook failed, backing off');
                this.cache.recordError(this.exchangeId, message);
                this.cache.recordReconnect(this.exchangeId);
                await sleep(backoff);
                backoff = Math.min(backoff * 2, BACKOFF_MAX_MS);
            }
        }
    }

    async stop (): Promise<void> {
        this.stopped = true;
        await this.exchange.close();
    }
}
