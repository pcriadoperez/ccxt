// Public channels: one post reaches every subscriber in a single API call (no per-user fan-out).
// Configure with RADAR_CHANNEL_LISTINGS / _MOVERS / _FUNDING / _STATUS / _BRIEF (channel @username or numeric id).

import type { Config } from './config.js';
import { MAJORS, STABLECOINS } from './config.js';
import type { MarketEvent } from './events.js';
import type { Dispatcher } from './delivery.js';
import type { MarketState } from './market/state.js';
import { to8h } from './market/state.js';
import { eventHtml } from './alerts.js';
import { fundingView } from './views.js';
import { esc, fmtFundingRate, fmtPct, fmtPrice, venueName } from './format.js';

export class Channels {
    cfg: Config;
    dispatcher: Dispatcher;
    state: MarketState;
    lastMoverPost = new Map<string, number> ();
    lastFundingPost = new Map<string, number> ();
    lastBoard = 0;

    // Wire onEvent to Engine.onNewEvent (not the raw bus) so each real-world event is posted once.
    constructor (cfg: Config, dispatcher: Dispatcher, state: MarketState) {
        this.cfg = cfg;
        this.dispatcher = dispatcher;
        this.state = state;
    }

    private post (target: string | undefined, html: string, priority = 2): void {
        if (target) {
            this.dispatcher.enqueueRaw (target, html + '\n\n<i>CCXT Radar · data fetched with CCXT</i>', priority);
        }
    }

    onEvent (ev: MarketEvent): void {
        const c = this.cfg.channels;
        const now = Date.now ();
        if (ev.type === 'listing' || ev.type === 'delisting') {
            this.post (c.listings, eventHtml (ev, now));
        } else if (ev.type === 'status' || (ev.type === 'wallet' && STABLECOINS.indexOf (ev.code || '') !== -1 && ev.data.field === 'withdraw')) {
            this.post (c.status, eventHtml (ev, now), 1);
        } else if (ev.type === 'bigmove') {
            this.post (c.movers, eventHtml (ev, now), 1);
        } else if (ev.type === 'macro' || ev.type === 'exploit') {
            this.post (c.status, eventHtml (ev, now));
        }
    }

    // Called by the scheduler every ~30s.
    periodic (now = Date.now ()): void {
        const c = this.cfg.channels;
        if (c.movers) {
            for (const base of MAJORS) {
                const ch = this.state.change ('median|' + base, 3_600_000);
                if (!ch || Math.abs (ch.pct) < 5 || now - ch.toTs > 60_000) {
                    continue;
                }
                if (now - (this.lastMoverPost.get (base) || 0) < 3_600_000) {
                    continue;
                }
                this.lastMoverPost.set (base, now);
                this.post (c.movers, '<b>' + (ch.pct > 0 ? '▲ ' : '▼ ') + esc (base) + ' ' + fmtPct (ch.pct, 1, true) + ' in 1h</b>\n<code>' + esc (fmtPrice (ch.from)) + ' → ' + esc (fmtPrice (ch.to)) + '</code> (median of major venues)', 1);
            }
        }
        if (c.funding) {
            // Extremes on the top 20 perps per venue, at most once per 4h per market.
            for (const [ venue, rows ] of this.state.funding) {
                for (const symbol of this.state.topPerps (venue, 20)) {
                    const f = rows.get (symbol);
                    if (!f || now - f.ts > 300_000) {
                        continue;
                    }
                    const v = to8h (f);
                    if (v <= 0.001 && v >= -0.0005) {
                        continue;
                    }
                    const key = venue + '|' + symbol;
                    if (now - (this.lastFundingPost.get (key) || 0) < 4 * 3_600_000) {
                        continue;
                    }
                    this.lastFundingPost.set (key, now);
                    this.post (c.funding, '<b>Funding extreme · ' + esc (symbol) + '</b>\n' + esc (venueName (venue)) + ' ' + fmtFundingRate (v) + ' per 8h-equivalent');
                }
            }
            if (now - this.lastBoard >= 4 * 3_600_000 && this.state.funding.size > 0) {
                this.lastBoard = now;
                this.post (c.funding, fundingView (this.state, 'BTC') + '\n\n' + fundingView (this.state, 'ETH'), 3);
            }
        }
    }
}
