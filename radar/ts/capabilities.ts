// Which venues can serve which rule kind (CCXT capabilities + what this bot ingests).
// Used before showing a confirmation card, so users never save an alert that can never fire.

import type { Config } from './config.js';
import type { RuleSpec } from './rules.js';
import { venueName } from './format.js';

export const FUNDING_VENUES = [ 'binance', 'bybit', 'okx', 'bitget', 'gate', 'kucoin', 'hyperliquid' ];
export const OI_VENUES = [ 'binance', 'bybit', 'okx', 'bitget', 'kucoin', 'hyperliquid' ];
export const WALLET_VENUES = [ 'binance', 'bybit', 'okx', 'bitget', 'gate', 'kucoin', 'mexc', 'kraken' ];

export function venueProblem (spec: RuleSpec, cfg: Config): string | undefined {
    const check = (venues: string[], allowed: string[], what: string): string | undefined => {
        const bad = venues.filter ((v) => allowed.indexOf (v) === -1);
        if (bad.length === 0) {
            return undefined;
        }
        return bad.map (venueName).join (', ') + (bad.length > 1 ? ' don\'t' : ' doesn\'t') + ' support ' + what + ' here. Available: ' + allowed.map (venueName).join (', ') + '.';
    };
    const tickerVenues = cfg.venues;
    switch (spec.kind) {
        case 'price':
        case 'move':
            return spec.venue === 'median' ? undefined : check ([ spec.venue ], tickerVenues, 'price alerts');
        case 'funding':
        case 'fundinggap':
        case 'settle':
            return check (spec.venues, FUNDING_VENUES.filter ((v) => tickerVenues.indexOf (v) !== -1), 'funding alerts');
        case 'oi':
            return check (spec.venues, OI_VENUES.filter ((v) => tickerVenues.indexOf (v) !== -1), 'open interest alerts');
        case 'wallet':
            return check (spec.venues, WALLET_VENUES.filter ((v) => tickerVenues.indexOf (v) !== -1), 'deposit/withdrawal alerts');
        case 'status':
            return check (spec.venues, tickerVenues, 'status alerts');
        case 'listing':
            return check (spec.venues, cfg.listingVenues, 'listing alerts');
        default:
            return undefined;
    }
}
