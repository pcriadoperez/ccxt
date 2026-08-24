// Copy-to-clipboard. Kept as a static file rather than an inline script so the page needs no
// script-src 'unsafe-inline', which would weaken CSP for the sake of twelve lines.
document.addEventListener('click', async (event) => {
    const button = event.target.closest('[data-copy]');
    if (!button) return;
    const value = button.getAttribute('data-copy');
    try {
        await navigator.clipboard.writeText(value);
    } catch {
        // Clipboard API needs a secure context and permission; fall back rather than fail silently.
        const ta = document.createElement('textarea');
        ta.value = value;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        try { document.execCommand('copy'); } finally { ta.remove(); }
    }
    const previous = button.getAttribute('aria-label') || 'Copy';
    button.classList.add('copied');
    button.setAttribute('aria-label', 'Copied');
    setTimeout(() => {
        button.classList.remove('copied');
        button.setAttribute('aria-label', previous);
    }, 1400);
});
