// "Reproduce with CCXT": short runnable snippets that fetch the same data an alert was built from.
// They return current values, not the values at alert time.

import type { DeliveryContext } from './db.js';
import type { Rule } from './rules.js';

export type Lang = 'py' | 'js' | 'go' | 'cli';

function goCtor (venue: string): string {
    return venue + '.New()';
}

function q (s: string): string {
    return "'" + s.replace (/'/g, '') + "'";
}

function dq (s: string): string {
    return '"' + s.replace (/"/g, '') + '"';
}

export function snippet (ctx: DeliveryContext, lang: Lang): string {
    const venue = ctx.venue || 'binance';
    const symbol = ctx.symbol || ((ctx.base || 'BTC') + '/USDT');
    switch (ctx.kind) {
        case 'funding':
        case 'fundinggap':
            return byLang (lang, venue, {
                py: 'import ccxt\nex = ccxt.' + venue + '()\nr = ex.fetch_funding_rate(' + q (symbol) + ')\nprint(r[\'fundingRate\'], r[\'interval\'], r[\'fundingTimestamp\'])',
                js: "import ccxt from 'ccxt'\nconst ex = new ccxt." + venue + '()\nconst r = await ex.fetchFundingRate(' + q (symbol) + ')\nconsole.log(r.fundingRate, r.interval, r.fundingTimestamp)',
                go: 'ex := ' + goCtor (venue) + '\nr, err := ex.FetchFundingRate(' + dq (symbol) + ')\nif err != nil { panic(err) }\nfmt.Println(*r.FundingRate, r.Interval)',
                cli: 'ccxt ' + venue + ' fetchFundingRate ' + symbol,
            });
        case 'oi':
            return byLang (lang, venue, {
                py: 'import ccxt\nex = ccxt.' + venue + '()\noi = ex.fetch_open_interest(' + q (symbol) + ')\nprint(oi[\'openInterestAmount\'], oi[\'openInterestValue\'])',
                js: "import ccxt from 'ccxt'\nconst ex = new ccxt." + venue + '()\nconst oi = await ex.fetchOpenInterest(' + q (symbol) + ')\nconsole.log(oi.openInterestAmount, oi.openInterestValue)',
                go: 'ex := ' + goCtor (venue) + '\noi, err := ex.FetchOpenInterest(' + dq (symbol) + ')\nif err != nil { panic(err) }\nfmt.Println(oi.OpenInterestAmount)',
                cli: 'ccxt ' + venue + ' fetchOpenInterest ' + symbol,
            });
        case 'listing':
        case 'delisting':
            return byLang (lang, venue, {
                py: 'import ccxt\nex = ccxt.' + venue + '()\nmarkets = ex.load_markets()\nprint(' + q (symbol) + ' in markets)',
                js: "import ccxt from 'ccxt'\nconst ex = new ccxt." + venue + '()\nconst markets = await ex.loadMarkets()\nconsole.log(' + q (symbol) + ' in markets)',
                go: 'ex := ' + goCtor (venue) + '\nmarkets, err := ex.LoadMarkets()\nif err != nil { panic(err) }\n_, ok := markets[' + dq (symbol) + ']\nfmt.Println(ok)',
                cli: 'ccxt ' + venue + ' loadMarkets',
            });
        case 'wallet': {
            const code = ctx.code || 'USDT';
            return byLang (lang, venue, {
                py: 'import ccxt\nex = ccxt.' + venue + '()  # some venues need read-only API keys\nc = ex.fetch_currencies()[' + q (code) + ']\nfor net, n in c[\'networks\'].items():\n    print(net, n[\'deposit\'], n[\'withdraw\'])',
                js: "import ccxt from 'ccxt'\nconst ex = new ccxt." + venue + '()\nconst c = (await ex.fetchCurrencies())[' + q (code) + ']\nfor (const [net, n] of Object.entries(c.networks)) console.log(net, n.deposit, n.withdraw)',
                go: 'ex := ' + goCtor (venue) + '\ncur, err := ex.FetchCurrencies()\nif err != nil { panic(err) }\nfmt.Println(cur[' + dq (code) + '])',
                cli: 'ccxt ' + venue + ' fetchCurrencies',
            });
        }
        case 'status':
            return byLang (lang, venue, {
                py: 'import ccxt\nex = ccxt.' + venue + '()\nprint(ex.fetch_status())',
                js: "import ccxt from 'ccxt'\nconst ex = new ccxt." + venue + '()\nconsole.log(await ex.fetchStatus())',
                go: 'ex := ' + goCtor (venue) + '\ns, err := ex.FetchStatus()\nif err != nil { panic(err) }\nfmt.Println(s)',
                cli: 'ccxt ' + venue + ' fetchStatus',
            });
        case 'move':
            return byLang (lang, venue, {
                py: 'import ccxt\nex = ccxt.' + venue + '()\nbars = ex.fetch_ohlcv(' + q (symbol) + ", '5m', limit=" + Math.ceil (Number (ctx.windowMin || 60) / 5 + 1) + ')\nprint((bars[-1][4] - bars[0][1]) / bars[0][1] * 100, \'%\')',
                js: "import ccxt from 'ccxt'\nconst ex = new ccxt." + venue + '()\nconst bars = await ex.fetchOHLCV(' + q (symbol) + ", '5m', undefined, " + Math.ceil (Number (ctx.windowMin || 60) / 5 + 1) + ')\nconsole.log((bars.at(-1)[4] - bars[0][1]) / bars[0][1] * 100, "%")',
                go: 'ex := ' + goCtor (venue) + '\nbars, err := ex.FetchOHLCV(' + dq (symbol) + ')\nif err != nil { panic(err) }\nfmt.Println(bars[len(bars)-1].Close)',
                cli: 'ccxt ' + venue + ' fetchOHLCV ' + symbol + ' 5m',
            });
        default:
            return byLang (lang, venue, {
                py: 'import ccxt\nex = ccxt.' + venue + '()\nt = ex.fetch_ticker(' + q (symbol) + ')\nprint(t[\'last\'], t[\'percentage\'])',
                js: "import ccxt from 'ccxt'\nconst ex = new ccxt." + venue + '()\nconst t = await ex.fetchTicker(' + q (symbol) + ')\nconsole.log(t.last, t.percentage)',
                go: 'ex := ' + goCtor (venue) + '\nt, err := ex.FetchTicker(' + dq (symbol) + ')\nif err != nil { panic(err) }\nfmt.Println(*t.Last)',
                cli: 'ccxt ' + venue + ' fetchTicker ' + symbol,
            });
    }
}

function byLang (lang: Lang, venue: string, s: Record<Lang, string>): string {
    if (lang === 'go') {
        return 'package main\n\nimport (\n    "fmt"\n    "github.com/ccxt/ccxt/go/v4/' + venue + '"\n)\n\nfunc main() {\n' + s.go.split ('\n').map ((l) => '    ' + l).join ('\n') + '\n}';
    }
    return s[lang];
}

export const INSTALL: Record<Lang, string> = {
    py: 'pip install ccxt',
    js: 'npm install ccxt',
    go: 'go get github.com/ccxt/ccxt/go/v4',
    cli: 'npm install -g ccxt-cli',
};

// A standalone polling script that implements a saved rule ("Get script").
export function ruleScript (rule: Pick<Rule, 'spec'>, lang: 'py' | 'js'): string | undefined {
    const s = rule.spec;
    if (s.kind === 'price') {
        const venue = s.venue === 'median' ? 'coinbase' : s.venue;
        const symbol = s.base + (s.market === 'perp' ? '/USDT:USDT' : (venue === 'coinbase' || venue === 'kraken' ? '/USD' : '/USDT'));
        const cmp = s.op === 'above' ? '>=' : '<=';
        if (lang === 'py') {
            return 'import time, ccxt\nex = ccxt.' + venue + '()\nwhile True:\n    last = ex.fetch_ticker(' + q (symbol) + ")['last']\n    if last " + cmp + ' ' + s.value + ':\n        print(' + q (symbol) + ", 'crossed', last)\n        break\n    time.sleep(10)";
        }
        return "import ccxt from 'ccxt'\nconst ex = new ccxt." + venue + '()\nwhile (true) {\n  const { last } = await ex.fetchTicker(' + q (symbol) + ')\n  if (last ' + cmp + ' ' + s.value + ') { console.log(' + q (symbol) + ", 'crossed', last); break }\n  await new Promise(r => setTimeout(r, 10_000))\n}";
    }
    if (s.kind === 'funding') {
        const venue = s.venues[0] || 'okx';
        const symbol = (s.base === '*' ? 'BTC' : s.base) + (venue === 'hyperliquid' ? '/USDC:USDC' : '/USDT:USDT');
        const hi = s.high === null ? 'None' : String (s.high);
        const lo = s.low === null ? 'None' : String (s.low);
        if (lang === 'py') {
            return 'import time, ccxt\nex = ccxt.' + venue + '()\nHIGH, LOW = ' + hi + ', ' + lo + '  # 8h-equivalent\nwhile True:\n    r = ex.fetch_funding_rate(' + q (symbol) + ")\n    hours = int((r['interval'] or '8h').rstrip('h'))\n    rate8h = r['fundingRate'] * 8 / hours\n    if (HIGH is not None and rate8h > HIGH) or (LOW is not None and rate8h < LOW):\n        print(" + q (symbol) + ', rate8h)\n    time.sleep(60)';
        }
        return "import ccxt from 'ccxt'\nconst ex = new ccxt." + venue + '()\nconst HIGH = ' + (s.high ?? 'null') + ', LOW = ' + (s.low ?? 'null') + ' // 8h-equivalent\nwhile (true) {\n  const r = await ex.fetchFundingRate(' + q (symbol) + ")\n  const rate8h = r.fundingRate * 8 / parseInt(r.interval || '8h')\n  if ((HIGH !== null && rate8h > HIGH) || (LOW !== null && rate8h < LOW)) console.log(" + q (symbol) + ', rate8h)\n  await new Promise(r => setTimeout(r, 60_000))\n}';
    }
    if (s.kind === 'move') {
        const venue = s.venue === 'median' ? 'coinbase' : s.venue;
        const symbol = s.base + (venue === 'coinbase' || venue === 'kraken' ? '/USD' : '/USDT');
        const bars = Math.ceil (s.windowMin / 5) + 1;
        if (lang === 'py') {
            return 'import time, ccxt\nex = ccxt.' + venue + '()\nwhile True:\n    bars = ex.fetch_ohlcv(' + q (symbol) + ", '5m', limit=" + bars + ')\n    pct = (bars[-1][4] - bars[0][1]) / bars[0][1] * 100\n    if abs(pct) >= ' + s.pct + ':\n        print(' + q (symbol) + ', round(pct, 2), "%")\n    time.sleep(60)';
        }
        return "import ccxt from 'ccxt'\nconst ex = new ccxt." + venue + '()\nwhile (true) {\n  const bars = await ex.fetchOHLCV(' + q (symbol) + ", '5m', undefined, " + bars + ')\n  const pct = (bars.at(-1)[4] - bars[0][1]) / bars[0][1] * 100\n  if (Math.abs(pct) >= ' + s.pct + ') console.log(' + q (symbol) + ', pct.toFixed(2), "%")\n  await new Promise(r => setTimeout(r, 60_000))\n}';
    }
    return undefined;
}
