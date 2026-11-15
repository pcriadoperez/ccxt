// Test helpers: a MarketState pre-filled with markets and tickers, without touching any exchange.

import { MarketState } from '../../ts/market/state.js';
import type { MarketInfo, Tick } from '../../ts/market/state.js';

export function market (symbol: string, extra: Partial<MarketInfo> = {}): MarketInfo {
    const [ pair, settle ] = symbol.split (':');
    const [ base, quote ] = pair.split ('/');
    return { symbol, base, quote, settle, type: settle ? 'swap' : 'spot', linear: settle ? true : undefined, active: true, ...extra };
}

export function makeState (now: { t: number }): MarketState {
    const s = new MarketState ();
    s.now = () => now.t;
    const venues: Record<string, string[]> = {
        binance: [ 'BTC/USDT', 'ETH/USDT', 'SOL/USDT', 'USDC/USDT', 'BTC/USDT:USDT', 'ETH/USDT:USDT', '1000PEPE/USDT:USDT' ],
        okx: [ 'BTC/USDT', 'ETH/USDT', 'SOL/USDT', 'BTC/USDT:USDT', 'ETH/USDT:USDT' ],
        kraken: [ 'BTC/USD', 'ETH/USD', 'SOL/USD', 'USDT/USD', 'USDC/USD' ],
        coinbase: [ 'BTC/USD', 'ETH/USD', 'SOL/USD', 'USDT/USD' ],
        hyperliquid: [ 'BTC/USDC:USDC', 'ETH/USDC:USDC', 'KPEPE/USDC:USDC' ],
    };
    for (const [ v, syms ] of Object.entries (venues)) {
        s.setMarkets (v, syms.map ((x) => market (x)));
    }
    return s;
}

export function setPrice (s: MarketState, venue: string, symbol: string, last: number, ts: number, extra: Partial<Tick> = {}): void {
    s.setTickers (venue, new Map ([ [ symbol, { last, bid: last, ask: last, ts, quoteVolume: 1e9, ...extra } ] ]));
}

export function setMajors (s: MarketState, ts: number, btc = 100_000, eth = 3_000): void {
    for (const v of [ 'binance', 'okx' ]) {
        s.setTickers (v, new Map ([
            [ 'BTC/USDT', { last: btc, ts, quoteVolume: 1e9, pct24: 1 } ],
            [ 'ETH/USDT', { last: eth, ts, quoteVolume: 1e9, pct24: 2 } ],
            [ 'SOL/USDT', { last: 150, ts, quoteVolume: 1e9, pct24: -1 } ],
            [ 'USDC/USDT', { last: 1, ts, quoteVolume: 1e8 } ],
            [ 'BTC/USDT:USDT', { last: btc, ts, quoteVolume: 2e9 } ],
            [ 'ETH/USDT:USDT', { last: eth, ts, quoteVolume: 2e9 } ],
        ]));
    }
    for (const v of [ 'kraken', 'coinbase' ]) {
        s.setTickers (v, new Map ([
            [ 'BTC/USD', { last: btc, ts, quoteVolume: 1e9, pct24: 1 } ],
            [ 'ETH/USD', { last: eth, ts, quoteVolume: 1e9 } ],
            [ 'SOL/USD', { last: 150, ts, quoteVolume: 1e8 } ],
            [ 'USDT/USD', { last: 1, ts, quoteVolume: 1e8 } ],
            [ 'USDC/USD', { last: 1, ts, quoteVolume: 1e8 } ],
        ]));
    }
}
