import { page, esc, highlight, type NavUser } from './layout.js';

const CLIP_ICON = '<svg class="clip" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5">'
    + '<rect x="5.5" y="5.5" width="8" height="9" rx="1.5"/>'
    + '<path d="M10.5 5.5V3a1.5 1.5 0 0 0-1.5-1.5H3.5A1.5 1.5 0 0 0 2 3v6a1.5 1.5 0 0 0 1.5 1.5H5.5"/></svg>';
const TICK_ICON = '<svg class="tick" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2">'
    + '<path d="M3 8.5L6.5 12L13 4.5"/></svg>';
const LINK_ICON = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5">'
    + '<path d="M6 10L14 2M14 2h-4.5M14 2v4.5"/><path d="M12 9.5V13a1.5 1.5 0 0 1-1.5 1.5h-7A1.5 1.5 0 0 1 2 13V6a1.5 1.5 0 0 1 1.5-1.5H7"/></svg>';
const DOWN_ICON = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5">'
    + '<path d="M8 2v9M4.5 7.5L8 11l3.5-3.5M2.5 13.5h11"/></svg>';

// A value with a copy button beside it. The button carries the raw value in a data attribute; the
// handler lives in a static file rather than inline so the page needs no script-src 'unsafe-inline'.
function copyable (value: string, label: string, wrap = false): string {
    return `<div class="copyrow">
  <div class="val${wrap ? ' wrap' : ''}">${esc(value)}</div>
  <button class="copy" type="button" data-copy="${esc(value)}" aria-label="Copy ${esc(label)}"
          title="Copy ${esc(label)}">${CLIP_ICON}${TICK_ICON}</button>
</div>`;
}

// Built by joining rather than as a multi-line template literal: a trailing backslash inside a
// template literal is a line continuation and eats the newline, so the shell continuation vanishes
// and the command renders as one unreadable line.
const ROUTE_URL = 'https://docs.ccxt.com/router/api/route?from=USDT&to=BTC&amountOut=0.1';
function curlFor (key: string): string {
    return [`curl -H "x-api-key: ${key}" \\`, `  "${ROUTE_URL}"`].join('\n');
}

// Shown once, immediately after a key is minted. This is the only moment the plaintext exists
// outside the user's clipboard, so the page has to get them to a working call before they leave it.
function onboarding (base: string, key: string): string {
    return `<div class="reveal">
  <strong>Your API key is ready. This is the only time it is shown.</strong>
  <p style="margin:6px 0 18px;font-size:13px;color:var(--muted)">
    It is stored only as a hash and cannot be recovered. If you lose it, revoke it and create another.
  </p>
  <ol class="steps">
    <li>
      <h4>Copy your API key</h4>
      <p>Keep it secret — it is the only credential the API needs.</p>
      ${copyable(key, 'API key', true)}
    </li>
    <li>
      <h4>Make your first call</h4>
      <p>Paste this into a terminal. It asks for the cheapest way to buy 0.1&nbsp;BTC with USDT.</p>
      ${copyable(curlFor(key), 'curl command', true)}
    </li>
    <li>
      <h4>Read what came back</h4>
      <p><code>amountIn</code> is what it costs, <code>impactBps</code> is what your size cost you,
      and <code>hops[].legs[]</code> is where to place the orders. Check <code>fillRatio</code>
      before trusting <code>effectiveRate</code>.</p>
      <div class="linkrow">
        <a href="${esc(base)}/docs/api#reading-the-response">${LINK_ICON}Reading the response</a>
        <a href="${esc(base)}/docs">${LINK_ICON}Guide for traders</a>
      </div>
    </li>
    <li>
      <h4>Build against it</h4>
      <p>The full contract, as an OpenAPI 3.1 document you can import into Postman, Insomnia or a code generator.</p>
      <div class="linkrow">
        <a href="${esc(base)}/openapi.yaml" download>${DOWN_ICON}Download openapi.yaml</a>
        <a href="${esc(base)}/docs/api">${LINK_ICON}API reference</a>
      </div>
    </li>
  </ol>
</div>`;
}

// Always present, so the page is still useful once the one-time reveal is gone.
function quickstart (base: string): string {
    return `<div class="card" style="margin-bottom:24px">
  <h3 style="margin-bottom:10px">Using the API</h3>
  <p style="margin-bottom:10px">Replace <code>$ROUTER_KEY</code> with one of your keys.</p>
  ${copyable(curlFor('$ROUTER_KEY'), 'curl command', true)}
  <div class="linkrow" style="margin-top:12px">
    <a href="${esc(base)}/docs/api">${LINK_ICON}API reference</a>
    <a href="${esc(base)}/docs">${LINK_ICON}Guide for traders</a>
    <a href="${esc(base)}/openapi.yaml" download>${DOWN_ICON}openapi.yaml</a>
  </div>
</div>`;
}

export interface KeyRow {
    displayId: string;
    name: string;
    last4: string;
    createdAt: string;
    revokedAt: string | null;
    rateLimitMax: number | null;
    requests: number;
    lastUsed: string | null;
}

export interface UsageBucket { hour: string; requests: number }

export interface RouteRow {
    ts: string;
    pair: string;
    hops: number;
    impactBps: number | null;
    status: number;
    fullyFillable: boolean | null;
}

function sparkline (buckets: UsageBucket[]): string {
    if (buckets.length === 0) return '<p style="color:var(--muted);font-size:13px">No traffic yet.</p>';
    const max = Math.max(...buckets.map((b) => b.requests), 1);
    return `<div class="spark">${buckets
        .map((b) => `<i style="height:${Math.max(2, Math.round((b.requests / max) * 34))}px" `
            + `title="${esc(b.hour)} — ${b.requests} requests"></i>`)
        .join('')}</div>`;
}

function keyTable (keys: KeyRow[], base: string, csrf: string): string {
    if (keys.length === 0) {
        return '<p style="color:var(--muted)">No keys yet.</p>';
    }
    return `<table class="tbl">
<thead><tr><th>Key</th><th>Name</th><th>Created</th><th>Requests</th><th>Last used</th><th></th></tr></thead>
<tbody>${keys.map((k) => `<tr>
  <td><span class="keyval">${esc(k.displayId)}</span><br>
      <span style="color:var(--muted);font-size:12px">…${esc(k.last4)}</span></td>
  <td>${esc(k.name)}${k.revokedAt ? ' <span class="pill dead">revoked</span>' : ' <span class="pill ok">active</span>'}
      ${k.rateLimitMax ? `<br><span style="color:var(--muted);font-size:12px">limit ${esc(k.rateLimitMax)}/min</span>` : ''}</td>
  <td style="color:var(--muted)">${esc(k.createdAt.slice(0, 10))}</td>
  <td class="num">${esc(k.requests)}</td>
  <td style="color:var(--muted)">${k.lastUsed ? esc(k.lastUsed.slice(0, 16).replace('T', ' ')) : '—'}</td>
  <td>${k.revokedAt ? '' : `<form method="post" action="${esc(base)}/dashboard/revoke" style="margin:0">
        <input type="hidden" name="csrf" value="${esc(csrf)}">
        <input type="hidden" name="displayId" value="${esc(k.displayId)}">
        <button class="btn danger sm" type="submit"
          data-confirm="Revoke ${esc(k.name)}? Any client using it stops working within 15 seconds."
        >Revoke</button></form>`}</td>
</tr>`).join('')}</tbody></table>`;
}

export function dashboardPage (opts: {
    base: string;
    user: NavUser;
    csrf: string;
    keys: KeyRow[];
    buckets: UsageBucket[];
    recent: RouteRow[];
    newKey?: string | undefined;
    error?: string | undefined;
}): string {
    const { base, user, csrf, keys, buckets, recent, newKey, error } = opts;
    const totalRequests = keys.reduce((s, k) => s + k.requests, 0);

    return page({ title: 'Dashboard — CCXT Router', base, user, active: 'dashboard' }, `
<div class="wrap dash">
  <h1>Your keys</h1>
  <p class="sub">${esc(user.email)}</p>

  ${error ? `<div class="err">${esc(error)}</div>` : ''}

  ${newKey ? onboarding(base, newKey) : quickstart(base)}

  <div class="row">
    <div>
      <div style="font-family:var(--mono);font-size:20px;font-weight:600">${esc(totalRequests)}</div>
      <div style="color:var(--muted);font-size:13px">requests in the last 7 days</div>
    </div>
    <form method="post" action="${esc(base)}/dashboard/keys" style="display:flex;gap:8px;align-items:center">
      <input type="hidden" name="csrf" value="${esc(csrf)}">
      <input name="name" placeholder="key name" required maxlength="40"
        style="padding:8px 12px;font-size:14px;font-family:inherit;background:var(--card);color:var(--fg);border:1px solid var(--border-strong);border-radius:8px">
      <button class="btn sm" type="submit">Create key</button>
    </form>
  </div>

  ${sparkline(buckets)}

  <h2 style="font-size:16px;margin:28px 0 8px">Keys</h2>
  ${keyTable(keys, base, csrf)}

  <h2 style="font-size:16px;margin:28px 0 8px">Recent routes</h2>
  ${recent.length === 0
        ? '<p style="color:var(--muted)">Nothing yet — make a request and it will show up here.</p>'
        : `<table class="tbl">
  <thead><tr><th>When</th><th>Route</th><th>Hops</th><th>Impact</th><th>Filled</th></tr></thead>
  <tbody>${recent.map((r) => `<tr>
    <td style="color:var(--muted)">${esc(r.ts.slice(0, 16).replace('T', ' '))}</td>
    <td class="keyval">${esc(r.pair)}</td>
    <td class="num">${esc(r.hops ?? '—')}</td>
    <td class="num">${r.impactBps === null ? '—' : `${r.impactBps.toFixed(2)} bps`}</td>
    <td>${r.fullyFillable === null ? '—' : (r.fullyFillable ? 'full' : '<span style="color:var(--warn)">partial</span>')}</td>
  </tr>`).join('')}</tbody></table>`}
</div>`);
}

export interface AdminUserRow {
    email: string;
    plan: string;
    isAdmin: boolean;
    createdAt: string;
    keys: number;
    requests: number;
}

export function adminPage (opts: {
    base: string;
    user: NavUser;
    users: AdminUserRow[];
    keys: (KeyRow & { owner: string })[];
    buckets: UsageBucket[];
    topRoutes: { route: string; requests: number; avgMs: number }[];
    topVenues: { exchange: string; legs: number }[];
    csrf: string;
}): string {
    const { base, user, users, keys, buckets, topRoutes, topVenues, csrf } = opts;
    return page({ title: 'Admin — CCXT Router', base, user, active: 'admin' }, `
<div class="wrap dash">
  <h1>Admin</h1>
  <p class="sub">Everything, across all accounts.</p>

  <div class="grid" style="margin-bottom:24px">
    <div class="card"><span class="stat">${esc(users.length)}</span><p>accounts</p></div>
    <div class="card"><span class="stat">${esc(keys.filter((k) => !k.revokedAt).length)}</span><p>active keys</p></div>
    <div class="card"><span class="stat">${esc(keys.reduce((s, k) => s + k.requests, 0))}</span><p>requests, 7d</p></div>
    <div class="card"><span class="stat">${esc(topVenues.length)}</span><p>venues routed to</p></div>
  </div>

  ${sparkline(buckets)}

  <h2 style="font-size:16px;margin:28px 0 8px">Accounts</h2>
  <table class="tbl">
  <thead><tr><th>Email</th><th>Plan</th><th>Joined</th><th>Keys</th><th>Requests 7d</th></tr></thead>
  <tbody>${users.map((u) => `<tr>
    <td>${esc(u.email)}${u.isAdmin ? ' <span class="pill">admin</span>' : ''}</td>
    <td style="color:var(--muted)">${esc(u.plan)}</td>
    <td style="color:var(--muted)">${esc(u.createdAt.slice(0, 10))}</td>
    <td class="num">${esc(u.keys)}</td>
    <td class="num">${esc(u.requests)}</td>
  </tr>`).join('')}</tbody></table>

  <h2 style="font-size:16px;margin:28px 0 8px">All keys</h2>
  <table class="tbl">
  <thead><tr><th>Key</th><th>Owner</th><th>Name</th><th>Requests 7d</th><th></th></tr></thead>
  <tbody>${keys.map((k) => `<tr>
    <td><span class="keyval">${esc(k.displayId)}</span></td>
    <td style="color:var(--muted)">${esc(k.owner)}</td>
    <td>${esc(k.name)}${k.revokedAt ? ' <span class="pill dead">revoked</span>' : ' <span class="pill ok">active</span>'}</td>
    <td class="num">${esc(k.requests)}</td>
    <td>${k.revokedAt ? '' : `<form method="post" action="${esc(base)}/admin/revoke" style="margin:0">
      <input type="hidden" name="csrf" value="${esc(csrf)}">
      <input type="hidden" name="displayId" value="${esc(k.displayId)}">
      <button class="btn danger sm" type="submit"
        data-confirm="Revoke ${esc(k.displayId)}?">Revoke</button></form>`}</td>
  </tr>`).join('')}</tbody></table>

  <div class="grid" style="margin-top:28px">
    <div>
      <h2 style="font-size:16px;margin:0 0 8px">Busiest endpoints</h2>
      <table class="tbl"><thead><tr><th>Route</th><th>Requests</th><th>Avg</th></tr></thead>
      <tbody>${topRoutes.map((r) => `<tr><td class="keyval">${esc(r.route)}</td>
        <td class="num">${esc(r.requests)}</td><td class="num">${r.avgMs.toFixed(1)} ms</td></tr>`).join('')}
      </tbody></table>
    </div>
    <div>
      <h2 style="font-size:16px;margin:0 0 8px">Venues routed to</h2>
      <table class="tbl"><thead><tr><th>Exchange</th><th>Legs</th></tr></thead>
      <tbody>${topVenues.map((v) => `<tr><td class="keyval">${esc(v.exchange)}</td>
        <td class="num">${esc(v.legs)}</td></tr>`).join('')}
      </tbody></table>
    </div>
  </div>
</div>`);
}
