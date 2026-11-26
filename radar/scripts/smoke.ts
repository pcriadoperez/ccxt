// Live smoke test: polls real exchanges once through the real ingestion code and prints what the bot would show.
// Usage: npm run smoke [-- okx,kraken,coinbase]   (no Telegram token or AI key needed)

import { loadConfig } from '../ts/config.js';
import { Store } from '../ts/db.js';
import { EventBus } from '../ts/events.js';
import { MarketState } from '../ts/market/state.js';
import { Ingestor } from '../ts/market/ingest.js';
import { NewsDesk } from '../ts/news.js';
import { MacroCalendar } from '../ts/calendar.js';
import { buildBrief, fundingView, priceView, statusView, walletView } from '../ts/views.js';
import { backtest } from '../ts/backtest.js';
import { parseShorthand } from '../ts/parse.js';

const strip = (s: string) => s.replace (/<[^>]+>/g, '').replace (/&lt;/g, '<').replace (/&gt;/g, '>').replace (/&amp;/g, '&');

async function main (): Promise<void> {
    const arg = process.argv[2];
    const env = { ...process.env, RADAR_DB: ':memory:' } as NodeJS.ProcessEnv;
    if (arg) {
        env.RADAR_VENUES = arg;
        env.RADAR_LISTING_VENUES = arg;
    }
    const cfg = loadConfig (env);
    const store = new Store (':memory:');
    const state = new MarketState ();
    const bus = new EventBus ();
    const ing = new Ingestor (cfg, state, bus, store, (m) => console.log ('  ' + m));
    const t0 = Date.now ();
    console.log ('Venues: ' + cfg.venues.join (', '));
    await Promise.all (cfg.venues.map (async (v) => {
        const step = async (name: string, fn: () => Promise<void>) => {
            try {
                await fn ();
            } catch (e: any) {
                state.error (v, e);
                console.log ('  [' + v + '] ' + name + ': ' + (e?.constructor?.name || '') + ' ' + String (e?.message || e).slice (0, 100));
            }
        };
        await step ('markets', () => ing.pollMarkets (v));
        await step ('tickers', () => ing.pollTickers (v));
        await step ('funding', () => ing.pollFunding (v));
        await step ('currencies', () => ing.pollCurrencies (v));
        await step ('status', () => ing.pollStatus (v));
        await step ('oi', () => ing.pollOpenInterest (v));
    }));
    console.log ('Ingestion round took ' + ((Date.now () - t0) / 1000).toFixed (1) + 's\n');
    for (const v of cfg.venues) {
        console.log ('  ' + v.padEnd (12) + ' markets ' + String (state.markets.get (v)?.size || 0).padStart (5) + ' · tickers ' + String (state.tickers.get (v)?.size || 0).padStart (5) + ' · funding ' + String (state.funding.get (v)?.size || 0).padStart (4) + ' · wallets ' + (state.walletsAvailable.has (v) ? 'yes' : 'no ') + ' · OI ' + (state.openInterest.get (v)?.size || 0));
    }
    console.log ('\n' + strip (priceView (state, 'BTC')));
    console.log ('\n' + strip (fundingView (state, 'BTC')));
    console.log ('\n' + strip (statusView (state, cfg.venues)));
    console.log ('\n' + strip (walletView (state, 'USDT', cfg.venues)));
    const news = new NewsDesk ();
    await news.refresh ();
    console.log ('\nNews: ' + news.items.length + ' items, ' + news.clusters.length + ' clusters' + (news.lastErrors.length ? ' (errors: ' + news.lastErrors.join ('; ') + ')' : ''));
    const cal = new MacroCalendar ();
    await cal.refresh ();
    console.log ('Calendar: ' + cal.events.length + ' events' + (cal.lastError ? ' (BLS feed: ' + cal.lastError + '; FOMC dates only)' : ''));
    console.log ('\n' + strip (buildBrief ({ state, store, news, calendar: cal }, undefined)));
    for (const text of [ 'btc > 150k', 'sol 5% 4h', 'funding eth > 0.05%' ]) {
        const p = parseShorthand (text)!;
        const bt = await backtest (p.spec, state, (id) => ing.exchange (id));
        console.log ('\nBacktest "' + text + '": ' + (bt ? bt.count + ' times in ' + bt.days + ' days on ' + bt.venue : 'n/a'));
    }
    store.close ();
}

main ().catch ((e) => {
    console.error (e);
    process.exit (1);
});
