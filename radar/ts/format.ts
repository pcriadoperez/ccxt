// Formatting helpers. All user-facing text is Telegram HTML, so every dynamic string goes through esc().

const VENUE_NAMES: Record<string, string> = {
    binance: 'Binance', bybit: 'Bybit', okx: 'OKX', coinbase: 'Coinbase', kraken: 'Kraken',
    bitget: 'Bitget', gate: 'Gate', kucoin: 'KuCoin', hyperliquid: 'Hyperliquid', mexc: 'MEXC',
    upbit: 'Upbit', bithumb: 'Bithumb', htx: 'HTX', cryptocom: 'Crypto.com', bingx: 'BingX',
    median: 'Median',
};

export function venueName (id: string): string {
    return VENUE_NAMES[id] || id;
}

export function esc (s: unknown): string {
    return String (s).replace (/&/g, '&amp;').replace (/</g, '&lt;').replace (/>/g, '&gt;').replace (/"/g, '&quot;');
}

// Prices: keep ~5-6 significant digits, thousands separators for large numbers.
export function fmtPrice (n: number | undefined | null): string {
    if (n === undefined || n === null || !Number.isFinite (n)) {
        return 'n/a';
    }
    const abs = Math.abs (n);
    let digits = 2;
    if (abs >= 1000) {
        digits = abs >= 100_000 ? 0 : 2;
    } else if (abs >= 1) {
        digits = abs >= 10 ? 2 : 4;
    } else if (abs > 0) {
        digits = Math.min (10, Math.max (4, 3 - Math.floor (Math.log10 (abs)) + 1));
    }
    return n.toLocaleString ('en-US', { minimumFractionDigits: 0, maximumFractionDigits: digits });
}

export function fmtPct (n: number | undefined | null, digits = 2, signed = false): string {
    if (n === undefined || n === null || !Number.isFinite (n)) {
        return 'n/a';
    }
    const s = n.toFixed (digits);
    const sign = (signed && n > 0) ? '+' : '';
    return sign + s.replace ('-', '−') + '%';
}

// Funding rates are stored as fractions (0.0001 = 0.01%).
export function fmtFundingRate (rate: number, signed = true): string {
    return fmtPct (rate * 100, 3, signed);
}

export function fmtUsd (n: number | undefined | null): string {
    if (n === undefined || n === null || !Number.isFinite (n)) {
        return 'n/a';
    }
    const abs = Math.abs (n);
    if (abs >= 1e9) {
        return '$' + (n / 1e9).toFixed (2) + 'B';
    }
    if (abs >= 1e6) {
        return '$' + (n / 1e6).toFixed (1) + 'M';
    }
    if (abs >= 1e3) {
        return '$' + (n / 1e3).toFixed (1) + 'k';
    }
    return '$' + n.toFixed (0);
}

export function fmtAge (ms: number): string {
    if (ms < 1000) {
        return ms + ' ms';
    }
    const s = Math.round (ms / 1000);
    if (s < 120) {
        return s + 's';
    }
    const m = Math.round (s / 60);
    if (m < 120) {
        return m + ' min';
    }
    return Math.round (m / 60) + 'h';
}

export function fmtDuration (ms: number): string {
    const totalMin = Math.max (0, Math.round (ms / 60_000));
    const h = Math.floor (totalMin / 60);
    const m = totalMin % 60;
    if (h > 0) {
        return m === 0 ? h + 'h' : h + 'h ' + m + 'm';
    }
    return m + 'm';
}

export function arrow (n: number): string {
    return n >= 0 ? '▲' : '▼';
}

// Parse human numbers: "100k", "1.2m", "100,000", "0.05%".
export function parseHumanNumber (raw: string): number | undefined {
    const s = raw.trim ().toLowerCase ().replace (/,/g, '').replace (/^\$/, '');
    const m = s.match (/^(-?\d+(?:\.\d+)?)([kmb])?$/);
    if (!m) {
        return undefined;
    }
    const mult = m[2] === 'k' ? 1e3 : (m[2] === 'm' ? 1e6 : (m[2] === 'b' ? 1e9 : 1));
    return Number (m[1]) * mult;
}

export const DISCLAIMER = 'Not investment advice.';
