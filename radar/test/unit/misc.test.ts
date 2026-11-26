import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRss, clusterNews, NewsDesk, rankClusters } from '../../ts/news.js';
import type { NewsItem } from '../../ts/news.js';
import { EventBus } from '../../ts/events.js';
import type { MarketEvent } from '../../ts/events.js';
import { parseBlsIcs, fomcEvents } from '../../ts/calendar.js';
import { snippet, ruleScript } from '../../ts/snippets.js';
import { parseShorthand } from '../../ts/parse.js';
import { inQuietHours, localParts, zoneForOffset, parseHHMM } from '../../ts/time.js';
import { fmtPrice, fmtPct, esc, parseHumanNumber } from '../../ts/format.js';
import { countCrossings } from '../../ts/backtest.js';
import { Store } from '../../ts/db.js';
import { buildBrief } from '../../ts/views.js';
import { MacroCalendar } from '../../ts/calendar.js';
import { makeState, setMajors } from '../helpers/fixtures.js';

const RSS = `<?xml version="1.0"?><rss><channel>
<item><title><![CDATA[Protocol X exploited for $12M]]></title><link>https://a.example/1</link><pubDate>Sun, 08 Nov 2026 10:00:00 GMT</pubDate><description>&lt;p&gt;Attackers drained $12M&lt;/p&gt;</description></item>
<item><title>Bitcoin ETF inflows rise</title><link>https://a.example/2</link><pubDate>Sun, 08 Nov 2026 09:00:00 GMT</pubDate></item>
</channel></rss>`;

test ('RSS parsing decodes CDATA and entities', () => {
    const items = parseRss (RSS, 'Pub A');
    assert.equal (items.length, 2);
    assert.equal (items[0].title, 'Protocol X exploited for $12M');
    assert.equal (items[0].description, 'Attackers drained $12M');
});

test ('clustering groups the same story across publishers; exploits need 2 publishers', () => {
    const now = Date.parse ('2026-11-08T12:00:00Z');
    const a: NewsItem = { publisher: 'Pub A', title: 'Protocol X exploited for $12M in flash loan attack', link: 'https://a/1', published: now - 3_600_000, description: '' };
    const b: NewsItem = { publisher: 'Pub B', title: 'Protocol X exploited, $12M drained in flash loan attack', link: 'https://b/1', published: now - 1_800_000, description: '' };
    const c: NewsItem = { publisher: 'Pub C', title: 'Ethereum validators vote on gas limit', link: 'https://c/1', published: now, description: '' };
    const clusters = clusterNews ([ a, b, c ]);
    assert.equal (clusters.length, 2);
    assert.deepEqual (rankClusters (clusters, 86_400_000, now)[0].publishers.sort (), [ 'Pub A', 'Pub B' ]);
    const bus = new EventBus ();
    const evs: MarketEvent[] = [];
    bus.on ((e) => evs.push (e));
    const desk = new NewsDesk (bus);
    desk.clusters = clusterNews ([ a ]);
    desk.detectExploits (now);
    assert.equal (evs.length, 0, 'one publisher is not enough');
    desk.clusters = clusters;
    desk.detectExploits (now);
    assert.equal (evs.length, 1);
    assert.equal (evs[0].type, 'exploit');
});

test ('macro calendar: FOMC at 2pm ET and BLS iCal parsing', () => {
    const dec = fomcEvents ().find ((e) => e.id === 'fomc-2026-12-9')!;
    assert.equal (new Date (dec.at).toISOString (), '2026-12-09T19:00:00.000Z');
    const jun = fomcEvents ().find ((e) => e.id === 'fomc-2026-6-17')!;
    assert.equal (new Date (jun.at).toISOString (), '2026-06-17T18:00:00.000Z');
    const ics = 'BEGIN:VCALENDAR\nBEGIN:VEVENT\nSUMMARY:Consumer Price Index for October 2026\nDTSTART;TZID=US-Eastern:20261112T083000\nEND:VEVENT\nBEGIN:VEVENT\nSUMMARY:Something else\nDTSTART:20261113T100000\nEND:VEVENT\nEND:VCALENDAR';
    const ev = parseBlsIcs (ics);
    assert.equal (ev.length, 1);
    assert.equal (ev[0].title, 'US CPI');
    assert.equal (new Date (ev[0].at).toISOString (), '2026-11-12T13:30:00.000Z');
});

test ('reproduce snippets use the alert venue and symbol in every language', () => {
    const ctx = { kind: 'funding', venue: 'bybit', symbol: 'ETH/USDT:USDT', base: 'ETH' };
    assert.match (snippet (ctx, 'py'), /ccxt\.bybit\(\)\nr = ex\.fetch_funding_rate\('ETH\/USDT:USDT'\)/);
    assert.match (snippet (ctx, 'js'), /new ccxt\.bybit\(\)/);
    assert.match (snippet (ctx, 'go'), /github\.com\/ccxt\/ccxt\/go\/v4\/bybit[\s\S]*ex := bybit\.New\(\)[\s\S]*FetchFundingRate\("ETH\/USDT:USDT"\)/);
    assert.equal (snippet (ctx, 'cli'), 'ccxt bybit fetchFundingRate ETH/USDT:USDT');
    assert.match (snippet ({ kind: 'price', venue: 'okx', symbol: 'BTC/USDT' }, 'py'), /fetch_ticker\('BTC\/USDT'\)/);
});

test ('rule scripts exist for price, funding and move rules', () => {
    assert.match (ruleScript (parseShorthand ('btc > 100k')!, 'py')!, /while True:[\s\S]*last >= 100000/);
    assert.match (ruleScript (parseShorthand ('funding eth > 0.1% okx')!, 'js')!, /fetchFundingRate\('ETH\/USDT:USDT'\)/);
    assert.match (ruleScript (parseShorthand ('sol 5% 4h')!, 'py')!, /fetch_ohlcv/);
    assert.equal (ruleScript (parseShorthand ('listings')!, 'py'), undefined);
});

test ('time helpers: local parts, quiet hours across midnight, zone for offset', () => {
    const t = Date.parse ('2026-11-08T23:30:00Z');
    assert.equal (localParts ('Europe/Madrid', t).hhmm, '00:30');
    assert.equal (localParts ('Europe/Madrid', t).date, '2026-11-09');
    assert.equal (inQuietHours (23 * 60, 7 * 60, 'Europe/Madrid', t), true);
    assert.equal (inQuietHours (23 * 60, 7 * 60, 'Europe/Madrid', Date.parse ('2026-11-08T12:00:00Z')), false);
    assert.equal (zoneForOffset (60, t), 'Europe/Madrid');
    assert.equal (zoneForOffset (-300, t), 'America/New_York');
    assert.equal (parseHHMM ('8'), 480);
    assert.equal (parseHHMM ('25:00'), undefined);
});

test ('formatting', () => {
    assert.equal (fmtPrice (101240.5), '101,241');
    assert.equal (fmtPrice (3410.123), '3,410.12');
    assert.equal (fmtPrice (0.000012345), '0.000012345');
    assert.equal (fmtPct (-3.2, 1, true), '−3.2%');
    assert.equal (fmtPct (1.8, 1, true), '+1.8%');
    assert.equal (esc ('<b>&'), '&lt;b&gt;&amp;');
    assert.equal (parseHumanNumber ('100k'), 100_000);
    assert.equal (parseHumanNumber ('$1.5m'), 1_500_000);
});

test ('backtest crossing counter matches engine semantics', () => {
    const series = [ 99, 101, 100.8, 99, 101, 99.6, 102 ];
    assert.equal (countCrossings (series, (v) => v >= 100, (v) => v <= 99.5), 2);
});

test ('Daily Brief shows markets, held alerts and the source footer', () => {
    const now = { t: Date.now () };
    const state = makeState (now);
    setMajors (state, now.t, 100_000, 3_000);
    const store = new Store (':memory:');
    const html = buildBrief ({ state, store, news: new NewsDesk (), calendar: new MacroCalendar () }, { chatId: 1, tz: 'UTC', settings: { watchlist: [ 'BTC', 'ETH' ], breaking: [] } }, now.t, [ 'SOL −5% in 4h' ]);
    assert.match (html, /<b>Daily Brief · /);
    assert.match (html, /BTC 100,000 \+1\.0%/);
    assert.match (html, /Held while you were quiet or over budget<\/b> \(1\)\n• SOL −5% in 4h/);
    assert.match (html, /Prices: median of Binance, Coinbase, Kraken, OKX, Bybit via CCXT\. Not investment advice\./);
});
