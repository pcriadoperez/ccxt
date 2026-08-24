// Server-rendered HTML. No framework, no build step, no bundler — the whole site is a handful of
// pages behind a login, and a toolchain would cost more to maintain than it saves.
//
// Everything operator- or user-supplied goes through esc(). An XSS here is same-origin and
// therefore mints API keys, so escaping is not hygiene, it is the control.

export function esc (value: unknown): string {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

export interface NavUser {
    email: string;
    isAdmin: boolean;
}

export interface PageOptions {
    title: string;
    description?: string;
    base: string;
    user?: NavUser | undefined;
    active?: string;
    wide?: boolean;
}

function nav (o: PageOptions): string {
    const link = (href: string, label: string, key: string): string =>
        `<a href="${esc(o.base)}${esc(href)}"${o.active === key ? ' aria-current="page"' : ''}>${esc(label)}</a>`;
    const items = [link('/docs', 'Docs', 'docs'), link('/docs/api', 'API', 'api')];
    if (o.user) {
        items.push(link('/dashboard', 'Dashboard', 'dashboard'));
        if (o.user.isAdmin) items.push(link('/admin', 'Admin', 'admin'));
        items.push(`<form method="post" action="${esc(o.base)}/logout" style="display:inline">`
            + `<button class="btn ghost sm" type="submit">Sign out</button></form>`);
    } else {
        items.push(link('/login', 'Sign in', 'login'));
        items.push(`<a class="btn sm" href="${esc(o.base)}/signup">Get an API key</a>`);
    }
    return `<nav class="site">${items.join('')}</nav>`;
}

export function page (o: PageOptions, body: string): string {
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(o.title)}</title>
${o.description ? `<meta name="description" content="${esc(o.description)}">` : ''}
<link rel="icon" href="${esc(o.base)}/static/logo.svg">
<link rel="stylesheet" href="${esc(o.base)}/static/styles.css">
<script src="${esc(o.base)}/static/app.js" defer></script>
</head>
<body>
<header class="site"><div class="wrap inner">
  <a class="brand" href="${esc(o.base)}/">
    <img src="${esc(o.base)}/static/logo.svg" alt="">
    <span>CCXT</span><span class="sep">/</span><span class="sub">Router</span>
    <span class="beta">beta</span>
  </a>
  ${nav(o)}
</div></header>
${body}
<footer class="site"><div class="wrap">
  Built on <a href="https://github.com/ccxt/ccxt">CCXT</a> · order books from ~60 exchanges over WebSocket
  · <a href="${esc(o.base)}/docs">Docs</a>
  <div style="margin-top:6px">This is a beta. It routes and prices orders; it never holds funds or places trades.</div>
</div></footer>
</body>
</html>`;
}

// A minimal syntax highlighter for the few code samples on the marketing pages. Deliberately not a
// dependency: it colours curl and JSON, which is all these pages contain.
export function highlight (code: string): string {
    return esc(code)
        .replace(/(&quot;[^&]*?&quot;)(\s*:)/g, '<span class="tok-key">$1</span>$2')
        .replace(/:\s*(&quot;[^&]*?&quot;)/g, ': <span class="tok-str">$1</span>')
        .replace(/\b(-?\d+\.?\d*(?:e-?\d+)?)\b/g, '<span class="tok-num">$1</span>')
        .replace(/(^|\n)(\s*#.*)/g, '$1<span class="tok-com">$2</span>')
        .replace(/\b(curl|GET|POST|true|false|null)\b/g, '<span class="tok-fn">$1</span>');
}
