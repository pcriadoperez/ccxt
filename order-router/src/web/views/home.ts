import { page, esc, highlight, type NavUser } from './layout.js';

// Every number on this page is measured, not aspirational. A trader can smell a rounded-up claim,
// and the honest figures are good enough to use as they are.

// The hero animation. It plays out the one thing about the router that is genuinely
// counter-intuitive: fee-adjusting each venue BEFORE comparing them changes which venue wins. The
// venue with the cheapest raw price here ends up the most expensive real one, which is exactly the
// mistake a naive "best bid/ask" comparison makes.
//
// The arithmetic is self-consistent and checked:
//   okx      104,776 x 1.0020 = 104,986
//   binance  104,780 x 1.0010 = 104,885
//   kucoin   104,791 x 1.0008 = 104,875   <- cheapest once fees are in
//   bybit    104,795 x 1.0010 = 104,900
//   split    0.62 @ 104,875 + 0.38 @ 104,885 = 104,878.8 for 1 BTC
//   best single venue able to fill the whole size: 104,893.5 -> 1.4 bps saved,
//   inside the measured 0.19-2.2 bps band.
const VENUES = [
    { cls: 'r-okx', name: 'okx', raw: '104,776', fee: '+0.20%', eff: '104,986', fill: 'fill-0' },
    { cls: 'r-binance', name: 'binance', raw: '104,780', fee: '+0.10%', eff: '104,885', fill: 'fill-38' },
    { cls: 'r-kucoin', name: 'kucoin', raw: '104,791', fee: '+0.08%', eff: '104,875', fill: 'fill-62' },
    { cls: 'r-bybit', name: 'bybit', raw: '104,795', fee: '+0.10%', eff: '104,900', fill: 'fill-0' },
];

function heroAnimation (): string {
    return `<div class="rt" aria-label="Animation: four exchanges reordered once taker fees are applied, then an order split across the two cheapest">
  <div class="rt-card">
    <div class="rt-head">
      <div class="rt-dots"><i></i><i></i><i></i></div>
      <span class="rt-req">GET /route?from=<b>USDT</b>&amp;to=<b>BTC</b>&amp;amountOut=<b>1</b></span>
    </div>
    <div class="rt-body">
      <div class="rt-cols">
        <span>venue</span><span>fill</span><span class="rt-raw">ask</span>
        <span class="c-fee rt-fee" style="color:var(--muted)">fee</span>
        <span class="c-eff rt-raw">real cost</span>
      </div>
      <div class="rt-rows">
        ${VENUES.map((v) => `<div class="rt-row ${v.cls}">
          <span class="rt-venue">${esc(v.name)}</span>
          <span class="rt-bar"><i class="${v.fill}"></i></span>
          <span class="rt-raw">${esc(v.raw)}</span>
          <span class="rt-fee">${esc(v.fee)}</span>
          <span class="rt-eff">${esc(v.eff)}</span>
        </div>`).join('')}
      </div>
      <div class="rt-out">
        <span><span class="lbl">pay</span> 104,879 USDT</span>
        <span><span class="lbl">get</span> 1 BTC</span>
        <span class="win">1.4 bps better than any single venue</span>
      </div>
      <div class="rt-steps">
        <span class="rt-step s1">walk each book to your size</span>
        <span class="rt-step s2">add taker fees</span>
        <span class="rt-step s3">re-rank</span>
        <span class="rt-step s4">split</span>
      </div>
    </div>
  </div>
</div>`;
}

// Small diagrams rather than screenshots: they follow the theme, cost nothing to load, and stay
// truthful when the numbers change.
function strategyDiagram (kind: 'single' | 'optimal' | 'capped'): string {
    const dot = (x: number, y: number, on: boolean, label: string) =>
        `<circle cx="${x}" cy="${y}" r="9" class="dg-node${on ? ' on' : ''}"/>`
        + `<text x="${x}" y="${y + 21}" text-anchor="middle" class="dg-txt${on ? ' on' : ''}">${esc(label)}</text>`;
    const edge = (x: number, on: boolean) =>
        `<path d="M100 14 C100 30 ${x} 26 ${x} 40" class="dg-edge${on ? ' on' : ''}"/>`;
    const lit = { single: [false, true, false, false], optimal: [true, true, true, true], capped: [false, true, true, true] }[kind];
    const xs = [30, 77, 124, 171];
    return `<svg viewBox="0 0 200 76" role="img">
  <circle cx="100" cy="8" r="6" class="dg-node on"/>
  ${xs.map((x, i) => edge(x, lit[i]!)).join('')}
  ${xs.map((x, i) => dot(x, 46, lit[i]!, ['okx', 'kucoin', 'binance', 'bybit'][i]!)).join('')}
</svg>`;
}

const EXAMPLE = `curl -H "x-api-key: $KEY" \\
  "https://docs.ccxt.com/router/api/route?from=USDT&to=BTC&amountOut=1"`;

export function homePage (base: string, user: NavUser | undefined): string {
    return page({
        title: 'CCXT Router — best execution across ~60 exchanges',
        description: 'Asset-to-asset order routing over live order books from ~60 exchanges. '
            + 'Book-walked to your size, fee-adjusted, split across venues, with price impact reported.',
        base, user, active: 'home',
    }, `
<div class="hero"><div class="wrap">
  <h1>The cheapest price is not the best price.</h1>
  <p class="lede">
    Tell the router what you hold and what you want. It walks live order books from ~60 exchanges to
    <em>your</em> size, adjusts every level for that venue's fees, and returns the cheapest way to
    get there — one venue, several, or through a bridge asset.
  </p>
  <div class="cta">
    <a class="btn" href="${esc(base)}/signup">Get an API key</a>
    <a class="btn ghost" href="${esc(base)}/docs">See how it works</a>
  </div>
  <p class="note">Free during the beta. No card. Your key works the moment you sign up.</p>
</div></div>

<section class="band"><div class="wrap">
  ${heroAnimation()}
  <p class="sub" style="margin:20px auto 0;text-align:center;max-width:60ch">
    okx shows the best ask. After its taker fee it is the <strong>most expensive</strong> of the four.
    Comparing venues before fees picks the wrong one — this is what the router does instead.
  </p>
</div></section>

<section class="band"><div class="wrap">
  <h2>Pick how it fills</h2>
  <p class="sub">One parameter. Fewer venues means less execution risk; more venues means a better price.</p>
  <div class="strat">
    <div class="card">
      ${strategyDiagram('single')}
      <div class="nm">strategy=best_single</div>
      <p>One venue for the whole order. Simplest to execute, one fee, one counterparty — and the
      baseline everything else is measured against.</p>
    </div>
    <div class="card">
      ${strategyDiagram('optimal')}
      <div class="nm">strategy=split_optimal</div>
      <p>Minimum cost across the merged, fee-adjusted book with no venue limit. Because levels are
      fee-adjusted <em>before</em> merging, the greedy walk is provably cost-minimal rather than a guess.</p>
    </div>
    <div class="card">
      ${strategyDiagram('capped')}
      <div class="nm">strategy=split_capped&amp;maxVenues=3</div>
      <p>The same, but never more venues than you want to manage. Three captures about 95% of the
      unconstrained gain.</p>
    </div>
  </div>
</div></section>

<section class="band"><div class="wrap">
  <h2>What it does that a ticker cannot</h2>
  <p class="sub">Four things, each of which changes the price you actually get.</p>
  <div class="grid">
    <div class="card">
      <h3>Fees, before the comparison</h3>
      <p>Every level is adjusted for that venue's taker fee <em>before</em> the books are merged.
      Fees differ by up to ~4× between venues and routinely invert the ranking — as above.</p>
    </div>
    <div class="card">
      <h3>Book-walked, not top-of-book</h3>
      <p>Best bid/ask is the price for a trade you are not making. Each book is walked to your real
      size, so the answer is the price you would actually pay.</p>
    </div>
    <div class="card">
      <h3>Every bridge compared</h3>
      <p>No direct market? It solves the direct pair and every bridge, then takes the best. Live now,
      <code>USDC→TRY</code> routes through <strong>ETH</strong> — ~9 bps better than the obvious USDT path.</p>
    </div>
    <div class="card">
      <h3>Impact you can act on</h3>
      <p>Every hop reports what your size cost against the best price available anywhere. Positive
      always means worse, on both sides — so you can shrink, split, or wait.</p>
    </div>
  </div>
</div></section>

<section class="band"><div class="wrap">
  <h2>One request</h2>
  <p class="sub">
    No <code>side</code> parameter. <code>USDT&nbsp;→&nbsp;BTC</code> is a buy of <code>BTC/USDT</code>;
    <code>BTC&nbsp;→&nbsp;USDT</code> is a sell of the same market. Working that out is the step people
    get backwards, so the router does it.
  </p>
  <pre class="code"><code>${highlight(EXAMPLE)}</code></pre>
  <div class="grid" style="margin-top:28px">
    <div class="card"><span class="stat">0.22&nbsp;ms</span><p>route computation, p50</p></div>
    <div class="card"><span class="stat">~60</span><p>exchanges streamed over WebSocket</p></div>
    <div class="card"><span class="stat">0.19–2.2&nbsp;bps</span><p>measured gain from splitting</p></div>
    <div class="card"><span class="stat">9&nbsp;bps</span><p>best measured bridge gain</p></div>
  </div>
  <div class="callout" style="margin-top:24px">
    <p><strong>It refuses to quote rather than quote badly.</strong> Books older than the freshness
    window are excluded, not used. An empty route with a stated reason is a deliberate answer — and a
    far better one than a confident price that no longer exists.</p>
  </div>
</div></section>

<section class="band"><div class="wrap" style="text-align:center">
  <h2>Start in about a minute</h2>
  <p class="sub" style="margin-left:auto;margin-right:auto">
    Sign up, copy the key, paste the command. Nothing to install, no card.
  </p>
  <a class="btn" href="${esc(base)}/signup">Get an API key</a>
  <p class="note" style="color:var(--muted);font-size:13px;margin-top:14px">
    The router prices and routes orders. It never holds funds and never places trades — you do.
  </p>
</div></section>
`);
}
