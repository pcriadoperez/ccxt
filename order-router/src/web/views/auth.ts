import { page, esc } from './layout.js';

function form (o: {
    base: string; title: string; sub: string; action: string; submit: string;
    csrf: string; error?: string | undefined; alt: string;
    passwordHint?: string | undefined;
}): string {
    return `
<div class="wrap"><div class="auth">
  <h1>${esc(o.title)}</h1>
  <p class="sub">${esc(o.sub)}</p>
  ${o.error ? `<div class="err">${esc(o.error)}</div>` : ''}
  <form method="post" action="${esc(o.base)}${esc(o.action)}">
    <input type="hidden" name="csrf" value="${esc(o.csrf)}">
    <div class="field">
      <label for="email">Email</label>
      <input id="email" name="email" type="email" required autocomplete="email" autofocus>
    </div>
    <div class="field">
      <label for="password">Password</label>
      <input id="password" name="password" type="password" required minlength="12"
             autocomplete="${o.action === '/signup' ? 'new-password' : 'current-password'}">
      ${o.passwordHint ? `<div class="hint">${esc(o.passwordHint)}</div>` : ''}
    </div>
    <button class="btn" type="submit" style="width:100%;justify-content:center">${esc(o.submit)}</button>
  </form>
  <p style="margin-top:18px;font-size:14px;color:var(--muted)">${o.alt}</p>
</div></div>`;
}

export function signupPage (base: string, csrf: string, error?: string): string {
    return page({ title: 'Get an API key — CCXT Router', base, active: 'signup' },
        form({
            base, csrf, error,
            title: 'Get an API key',
            sub: 'Free during the beta. Your key is issued immediately.',
            action: '/signup',
            submit: 'Create account',
            passwordHint: 'At least 12 characters.',
            // Stated plainly because it is true and because a user who discovers it later feels
            // misled: there is no verification mail and no reset link during the beta.
            alt: `Already have an account? <a href="${esc(base)}/login">Sign in</a>.`
                + '<br><span style="font-size:13px">During the beta there is no confirmation email, '
                + 'and no self-service password reset — if you lose it, contact us.</span>',
        }));
}

export function loginPage (base: string, csrf: string, error?: string): string {
    return page({ title: 'Sign in — CCXT Router', base, active: 'login' },
        form({
            base, csrf, error,
            title: 'Sign in',
            sub: 'Your keys and usage.',
            action: '/login',
            submit: 'Sign in',
            alt: `No account? <a href="${esc(base)}/signup">Get an API key</a>.`,
        }));
}
