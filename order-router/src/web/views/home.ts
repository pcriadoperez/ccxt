import { page, esc, highlight, type NavUser } from './layout.js';

// Every number on this page is measured, not aspirational. Where a figure appears it comes from a
// benchmark or a live call recorded in the repo — a trader can smell a rounded-up claim, and the
// honest numbers are good enough to use as they are.

const EXAMPLE = `curl -H "x-api-key: $KEY" \\
  "https://docs.ccxt.com/router/api/route?from=USDT&to=BTC&amountOut=1&strategy=split_optimal"`;

const RESPONSE = `{
  "from": "USDT", "to": "BTC",
  "amountIn": 104812.4,        # what it actually costs
  "amountOut": 1,              # what you asked for
  "effectiveRate": 9.541e-6,
  "impactBps": 3.1,            # what your size cost you
  "hops": [{
    "pair": "BTC/USDT", "side": "buy",
    "referencePrice": 104780.1,
    "legs": [
      { "exchangeId": "binance",  "amount": 0.62, "averagePrice": 104780.1 },
      { "exchangeId": "kucoin",   "amount": 0.38, "averagePrice": 104791.7 }
    ]
  }],
  "fullyFillable": true, "fillRatio": 1
}`;

export function homePage (base: string, user: NavUser | undefined): string {
    return page({
        title: 'CCXT Router — best execution across ~60 exchanges',
        description: 'Asset-to-asset order routing over live order books from ~60 exchanges. '
            + 'Book-walked to your size, fee-adjusted, split across venues, with price impact reported.',
        base, user, active: 'home',
    }, `
<div class="hero"><div class="wrap">
  <h1>Where should this trade actually go?</h1>
  <p class="lede">
    Tell it what you hold and what you want. It walks live order books from ~60 exchanges to
    <em>your</em> size, adjusts every level for that venue's fees, and returns the cheapest way to
    get there — one venue, several, or through a bridge asset — with the price impact of your size
    stated up front.
  </p>
  <div class="cta">
    <a class="btn" href="${esc(base)}/signup">Get an API key</a>
    <a class="btn ghost" href="${esc(base)}/docs">Read the docs</a>
  </div>
  <p class="note">Free during the beta. No card. The key works the moment you sign up.</p>
</div></div>

<section class="band"><div class="wrap">
  <h2>One request</h2>
  <p class="sub">
    There is no <code>side</code> parameter. <code>USDT&nbsp;&rarr;&nbsp;BTC</code> is a buy of
    <code>BTC/USDT</code>; <code>BTC&nbsp;&rarr;&nbsp;USDT</code> is a sell of the same market.
    Working that out is the step people get backwards, so the router does it.
  </p>
  <pre class="code"><code>${highlight(EXAMPLE)}</code></pre>
  <pre class="code"><code>${highlight(RESPONSE)}</code></pre>
</div></section>

<section class="band"><div class="wrap">
  <h2>What it does that a ticker cannot</h2>
  <p class="sub">Four things, each of which changes the price you actually get.</p>
  <div class="grid">
    <div class="card">
      <h3>Book-walked, not top-of-book</h3>
      <p>Best bid/ask is the price for a trade you are not making. Each venue's book is walked to
      your real size and fee-adjusted before any comparison — and for anything non-trivial the best
      top-of-book venue is frequently not the best venue.</p>
    </div>
    <div class="card">
      <h3>Split when splitting pays</h3>
      <p>Levels are fee-adjusted <em>before</em> the books are merged, which makes the split
      cost-minimal rather than a guess. Measured gain over the best single venue:
      <strong>0.19–2.2&nbsp;bps</strong>, and three venues capture ~95% of it.</p>
    </div>
    <div class="card">
      <h3>Every bridge compared</h3>
      <p>No direct market? It solves the direct pair and every bridge, then picks the best. Live
      right now, <code>USDC&rarr;TRY</code> routes through <strong>ETH</strong> — about
      <strong>9&nbsp;bps</strong> better than the obvious USDT path.</p>
    </div>
    <div class="card">
      <h3>Impact you can act on</h3>
      <p>Every hop reports what your size cost against the best price available anywhere. Positive
      always means worse, on both sides — so you can shrink, split, or wait, without walking the
      book yourself.</p>
    </div>
  </div>
</div></section>

<section class="band"><div class="wrap">
  <h2>Measured, not claimed</h2>
  <p class="sub">Route computation, against a cache the size of full discovery (42,120 books).</p>
  <div class="grid">
    <div class="card"><span class="stat">0.22&nbsp;ms</span><p>single hop, p50</p></div>
    <div class="card"><span class="stat">1.10&nbsp;ms</span><p>two bridges compared, p50</p></div>
    <div class="card"><span class="stat">~60</span><p>exchanges streamed over WebSocket</p></div>
    <div class="card"><span class="stat">9&nbsp;bps</span><p>best measured bridge gain</p></div>
  </div>
  <div class="callout">
    <p><strong>It refuses to quote rather than quote badly.</strong> Books older than the freshness
    window are excluded, not used. An empty route with a stated reason is a deliberate answer — and
    a far better one than a confident price that no longer exists.</p>
  </div>
</div></section>

<section class="band"><div class="wrap">
  <h2>Start in about a minute</h2>
  <p class="sub">Sign up, copy the key, paste the command. Nothing to install.</p>
  <a class="btn" href="${esc(base)}/signup">Get an API key</a>
</div></section>
`);
}
