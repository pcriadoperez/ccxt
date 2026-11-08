// Read-only views over the shared state: lookups (/p, /funding, /status, /listings), the Daily Brief,
// and the compact data objects the AI is grounded on. Nothing here calls an exchange.

import { MarketState, to8h, toApr, median } from './market/state.js';
import type { Store, UserRow } from './db.js';
import type { NewsDesk } from './news.js';
import type { MacroCalendar } from './calendar.js';
import { DISCLAIMER, esc, fmtAge, fmtDuration, fmtFundingRate, fmtPct, fmtPrice, fmtUsd, venueName } from './format.js';
import { localParts } from './time.js';
import { MAJORS, MEDIAN_VENUES } from './config.js';

const KEY_NEEDED = new Set ([ 'binance', 'bybit', 'okx', 'mexc' ]);
const r2 = (n: number, d = 2) => Number (n.toFixed (d));
const sig = (n: number) => Number (n.toPrecision (6));

export function priceData (state: MarketState, base: string) {
    const now = state.now ();
    const rows = state.pricesAcross (base).sort ((a, b) => a.usd - b.usd);
    const med = state.medianPrice (base);
    return {
        asset: base,
        medianUsd: med ? sig (med.price) : null,
        medianVenues: med ? med.venues : [],
        venues: rows.map ((r) => ({ venue: r.venue, symbol: r.symbol, price: sig (r.price), priceUsd: sig (r.usd), change24hPct: r.pct24 === undefined ? null : r2 (r.pct24), ageSec: Math.round ((now - r.ts) / 1000) })),
    };
}

export function fundingData (state: MarketState, base: string) {
    const now = state.now ();
    return {
        asset: base,
        perps: state.fundingAcross (base).map ((r) => ({
            venue: r.venue,
            symbol: r.symbol,
            ratePerIntervalPct: r2 (r.f.rate * 100, 4),
            intervalHours: r.f.intervalH,
            intervalAssumed: r.f.intervalAssumed,
            rate8hPct: r2 (to8h (r.f) * 100, 4),
            aprPct: r2 (toApr (r.f) * 100, 1),
            settlesInMin: r.f.settleTs ? Math.round ((r.f.settleTs - now) / 60_000) : null,
        })).sort ((a, b) => b.rate8hPct - a.rate8hPct),
    };
}

export function statusData (state: MarketState, venues: string[]) {
    const now = state.now ();
    return venues.map ((v) => {
        const h = state.health.get (v);
        return {
            venue: v,
            state: !h || h.lastOk === 0 ? 'no data yet' : (state.isDegraded (v) ? 'degraded' : 'ok'),
            exchangeReports: h?.exchangeStatus || null,
            lastDataAgeSec: h && h.lastOk ? Math.round ((now - h.lastOk) / 1000) : null,
            lastError: h?.lastError || null,
        };
    });
}

export function walletData (state: MarketState, code: string, venues: string[]) {
    return venues.map ((v) => {
        if (!state.walletsAvailable.has (v)) {
            return { venue: v, available: false, networks: [] as Array<{ network: string, deposit: boolean | null, withdraw: boolean | null }> };
        }
        const nets = state.wallets.get (v)?.get (code);
        return {
            venue: v,
            available: true,
            networks: nets ? [ ...nets ].map (([ network, w ]) => ({ network, deposit: w.deposit ?? null, withdraw: w.withdraw ?? null })) : [],
        };
    });
}

export function oiData (state: MarketState, base: string) {
    const out: Array<{ venue: string, symbol: string, openInterest: number, change1hPct: number | null }> = [];
    for (const [ venue, rows ] of state.openInterest) {
        const r = state.resolve (venue, base, 'perp');
        if (!r) {
            continue;
        }
        const oi = rows.get (r.symbol);
        if (!oi) {
            continue;
        }
        const ch = state.change ('oi|' + venue + '|' + r.symbol, 3_600_000);
        out.push ({ venue, symbol: r.symbol, openInterest: sig (oi.value), change1hPct: ch ? r2 (ch.pct, 1) : null });
    }
    return out;
}

// ---------------------------------------------------------------- lookups (HTML)

export function priceView (state: MarketState, base: string, venue?: string): string {
    const d = priceData (state, base);
    let rows = d.venues;
    if (venue) {
        rows = rows.filter ((r) => r.venue === venue);
    }
    if (rows.length === 0) {
        return 'No fresh price for <b>' + esc (base) + '</b>' + (venue ? ' on ' + esc (venueName (venue)) : '') + '. Check the coin symbol, or the venue may be unavailable.';
    }
    const lines = [ '<b>' + esc (base) + '</b>' + (d.medianUsd !== null ? ' · median <code>' + esc (fmtPrice (d.medianUsd)) + '</code> USD' : '') ];
    for (const r of rows.sort ((a, b) => b.priceUsd - a.priceUsd)) {
        const pct = r.change24hPct === null ? '' : ' ' + fmtPct (r.change24hPct, 2, true);
        lines.push ('<code>' + esc (venueName (r.venue).padEnd (11)) + esc (fmtPrice (r.price)).padStart (12) + ' ' + esc (r.symbol.split ('/')[1]) + pct + '</code>');
    }
    lines.push ('<i>via ccxt fetchTickers · data &lt; ' + esc (fmtAge (Math.max (...rows.map ((r) => r.ageSec)) * 1000 + 1000)) + ' old</i>');
    return lines.join ('\n');
}

export function fundingView (state: MarketState, base: string): string {
    const d = fundingData (state, base);
    if (d.perps.length === 0) {
        return 'No funding data for <b>' + esc (base) + '</b> perps yet. Funding is available on Binance, Bybit, OKX, Bitget, Gate, KuCoin and Hyperliquid.';
    }
    const lines = [ '<b>Funding · ' + esc (base) + ' perps</b>', '<code>venue        /interval   8h-eq     APR   settles</code>' ];
    for (const p of d.perps) {
        const iv = (fmtPct (p.ratePerIntervalPct, 4, true) + '/' + p.intervalHours + 'h' + (p.intervalAssumed ? '*' : ''));
        const settle = p.settlesInMin === null ? '—' : fmtDuration (p.settlesInMin * 60_000);
        lines.push ('<code>' + esc (venueName (p.venue).padEnd (12)) + esc (iv.padEnd (12)) + esc (fmtPct (p.rate8hPct, 4, true).padStart (8)) + esc (fmtPct (p.aprPct, 1, true).padStart (8)) + '  ' + esc (settle) + '</code>');
    }
    if (d.perps.some ((p) => p.intervalAssumed)) {
        lines.push ('<i>* interval not reported by the venue; 8h assumed</i>');
    }
    lines.push ('<i>via ccxt fetchFundingRates · ' + DISCLAIMER + '</i>');
    return lines.join ('\n');
}

export function statusView (state: MarketState, venues: string[]): string {
    const rows = statusData (state, venues);
    const lines = [ '<b>Exchange status</b>' ];
    for (const r of rows) {
        const icon = r.state === 'ok' ? '✓' : (r.state === 'degraded' ? '⚠' : '·');
        const age = r.lastDataAgeSec === null ? 'never' : fmtAge (r.lastDataAgeSec * 1000) + ' ago';
        lines.push (icon + ' <b>' + esc (venueName (r.venue)) + '</b> ' + esc (r.state) + ' · last data ' + esc (age) + (r.exchangeReports && r.exchangeReports !== 'ok' ? ' · reports ' + esc (r.exchangeReports) : ''));
        if (r.state !== 'ok' && r.lastError) {
            lines.push ('   <i>' + esc (r.lastError.slice (0, 120)) + '</i>');
        }
    }
    return lines.join ('\n');
}

export function walletView (state: MarketState, code: string, venues: string[]): string {
    const rows = walletData (state, code, venues);
    const lines = [ '<b>' + esc (code) + ' deposits / withdrawals</b>' ];
    for (const r of rows) {
        if (!r.available) {
            lines.push ('· ' + esc (venueName (r.venue)) + ': status unknown (' + (KEY_NEEDED.has (r.venue) ? 'needs a read-only API key' : 'not reported by its public API') + ')');
            continue;
        }
        if (r.networks.length === 0) {
            lines.push ('· ' + esc (venueName (r.venue)) + ': not listed');
            continue;
        }
        const nets = r.networks.slice (0, 8).map ((n) => esc (n.network === '*' ? 'all' : n.network) + ' ' + (n.deposit === false ? 'D✗' : 'D✓') + (n.withdraw === false ? 'W✗' : 'W✓')).join (', ');
        lines.push ('· <b>' + esc (venueName (r.venue)) + '</b>: ' + nets);
    }
    lines.push ('<i>via ccxt fetchCurrencies · D = deposit, W = withdraw</i>');
    return lines.join ('\n');
}

export function listingsView (store: Store, sinceMs: number, venue?: string): string {
    const added = store.recentEvents ('listing', sinceMs).filter ((e) => !venue || e.payload.venue === venue);
    const removed = store.recentEvents ('delisting', sinceMs).filter ((e) => !venue || e.payload.venue === venue);
    const hours = Math.round (sinceMs / 3_600_000);
    if (added.length === 0 && removed.length === 0) {
        return 'No new or removed markets detected in the last ' + hours + 'h' + (venue ? ' on ' + esc (venueName (venue)) : '') + '.\n<i>Detection starts once the bot has two market snapshots per venue.</i>';
    }
    const lines = [ '<b>Markets in the last ' + hours + 'h</b>' ];
    for (const e of added.slice (0, 25)) {
        lines.push ('＋ <code>' + esc (e.payload.symbol) + '</code> ' + esc (venueName (e.payload.venue)) + ' · ' + fmtAge (Date.now () - e.createdAt) + ' ago');
    }
    for (const e of removed.slice (0, 10)) {
        lines.push ('－ <code>' + esc (e.payload.symbol) + '</code> ' + esc (venueName (e.payload.venue)) + ' · ' + fmtAge (Date.now () - e.createdAt) + ' ago');
    }
    return lines.join ('\n');
}

// ---------------------------------------------------------------- Daily Brief

export interface BriefDeps {
    state: MarketState;
    store: Store;
    news: NewsDesk;
    calendar: MacroCalendar;
}

function median24h (state: MarketState, base: string): number | undefined {
    const pcts = state.pricesAcross (base).filter ((r) => MEDIAN_VENUES.indexOf (r.venue) !== -1 && r.pct24 !== undefined).map ((r) => r.pct24!);
    return pcts.length ? median (pcts) : undefined;
}

// Biggest 24h movers among liquid USDT spot markets, using the median change across venues.
export function topMovers (state: MarketState, n = 3): Array<{ base: string, pct: number }> {
    const byBase = new Map<string, number[]> ();
    for (const venue of state.tickers.keys ()) {
        const mk = state.markets.get (venue);
        for (const [ symbol, t ] of state.tickers.get (venue)!) {
            const info = mk?.get (symbol);
            if (!info || info.type !== 'spot' || info.quote !== 'USDT' || t.pct24 === undefined || !t.quoteVolume || t.quoteVolume < 10_000_000) {
                continue;
            }
            const arr = byBase.get (info.base) || [];
            arr.push (t.pct24);
            byBase.set (info.base, arr);
        }
    }
    const rows = [ ...byBase ].filter (([ , v ]) => v.length >= 3).map (([ base, v ]) => ({ base, pct: median (v) }));
    rows.sort ((a, b) => Math.abs (b.pct) - Math.abs (a.pct));
    return rows.slice (0, n);
}

export function hottestFunding (state: MarketState): { venue: string, symbol: string, rate8h: number } | undefined {
    let best: { venue: string, symbol: string, rate8h: number } | undefined;
    const liquid = state.liquidPerpBases (50, 2);
    for (const [ venue, rows ] of state.funding) {
        for (const symbol of state.topPerps (venue, 30)) {
            const f = rows.get (symbol);
            const info = state.markets.get (venue)?.get (symbol);
            if (!f || !info || !liquid.has (MarketState.normalizeBase (info.base).base)) {
                continue;
            }
            const v = to8h (f);
            if (!best || Math.abs (v) > Math.abs (best.rate8h)) {
                best = { venue, symbol, rate8h: v };
            }
        }
    }
    return best;
}

export function buildBrief (deps: BriefDeps, user: Pick<UserRow, 'tz' | 'settings' | 'chatId'> | undefined, now = Date.now (), held: string[] = []): string {
    const { state, store, news, calendar } = deps;
    const tz = user?.tz || 'UTC';
    const lp = localParts (tz, now);
    const date = new Intl.DateTimeFormat ('en-GB', { timeZone: tz, weekday: 'short', day: 'numeric', month: 'short' }).format (new Date (now));
    const lines: string[] = [ '<b>Daily Brief · ' + esc (date) + ' · ' + lp.hhmm + '</b>', '' ];
    const watch = (user?.settings.watchlist && user.settings.watchlist.length ? user.settings.watchlist : MAJORS.slice (0, 3)).slice (0, 6);
    const market: string[] = [];
    for (const base of watch) {
        const m = state.medianPrice (base);
        if (!m) {
            continue;
        }
        const p = median24h (state, base);
        market.push (esc (base) + ' ' + esc (fmtPrice (m.price)) + (p === undefined ? '' : ' ' + fmtPct (p, 1, true)));
    }
    if (market.length) {
        lines.push ('<b>Markets</b> (24h)', market.join (' · '));
    }
    const movers = topMovers (state);
    if (movers.length) {
        lines.push ('Top movers: ' + movers.map ((m) => esc (m.base) + ' ' + fmtPct (m.pct, 1, true)).join (' · '));
    }
    const hot = hottestFunding (state);
    if (hot) {
        lines.push ('Hottest funding: ' + esc (hot.symbol) + ' ' + esc (venueName (hot.venue)) + ' ' + fmtFundingRate (hot.rate8h) + '/8h');
    }
    const listings = store.recentEvents ('listing', 86_400_000);
    if (listings.length) {
        const venues = new Set (listings.map ((e) => e.payload.venue));
        lines.push ('New markets (24h): ' + listings.length + ' on ' + venues.size + ' venue' + (venues.size > 1 ? 's' : '') + ' · /listings');
    }
    const paused = store.recentEvents ('wallet', 86_400_000).filter ((e) => e.payload.data?.to === false);
    if (paused.length) {
        lines.push ('Deposit/withdrawal pauses (24h): ' + paused.length);
    }
    const week = calendar.upcoming (now, now + 7 * 86_400_000).slice (0, 3);
    if (week.length) {
        lines.push ('', '<b>This week</b>');
        for (const e of week) {
            const d = new Intl.DateTimeFormat ('en-GB', { timeZone: tz, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format (new Date (e.at));
            lines.push (esc (d) + ' ' + esc (e.title) + ' (' + esc (e.source) + ')');
        }
    }
    const top = news.top (6, now);
    if (top.length) {
        lines.push ('', '<b>News</b>');
        top.forEach ((c, i) => {
            const text = c.summary || c.title;
            const links = c.publishers.slice (0, 3).map ((p) => {
                const it = c.items.find ((x) => x.publisher === p)!;
                return '<a href="' + esc (it.link) + '">' + esc (p) + '</a>';
            }).join (' · ');
            lines.push ((i + 1) + '. ' + esc (text) + ' ' + links);
        });
    }
    if (held.length) {
        lines.push ('', '<b>Held while you were quiet or over budget</b> (' + held.length + ')');
        for (const h of held.slice (0, 8)) {
            lines.push ('• ' + esc (h));
        }
        if (held.length > 8) {
            lines.push ('• …and ' + (held.length - 8) + ' more');
        }
    }
    const ai = top.some ((c) => c.summary);
    lines.push ('', '<i>' + (ai ? 'Headlines condensed by AI from the linked sources. ' : 'Headlines from the linked sources. ') + 'Prices: median of ' + MEDIAN_VENUES.map (venueName).join (', ') + ' via CCXT. ' + DISCLAIMER + '</i>');
    return lines.join ('\n');
}

export function fmtUsdShort (n: number): string {
    return fmtUsd (n);
}
