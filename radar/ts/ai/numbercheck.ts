// Guardrail: every number in an AI answer must come from the data we gave it.
// Bare small integers (counts, hours, list numbers) are allowed. Anything with a unit that makes it a claim
// ($, %, k/m/b, x) or a decimal must match a data value within rounding; a written sign must match too.

export function collectNumbers (data: unknown, out: number[] = []): number[] {
    if (typeof data === 'number' && Number.isFinite (data)) {
        out.push (data);
    } else if (typeof data === 'string') {
        for (const m of data.matchAll (/-?\d[\d,]*(?:\.\d+)?/g)) {
            const n = Number (m[0].replace (/,/g, ''));
            if (Number.isFinite (n)) {
                out.push (n);
            }
        }
    } else if (Array.isArray (data)) {
        for (const x of data) {
            collectNumbers (x, out);
        }
    } else if (data && typeof data === 'object') {
        for (const v of Object.values (data)) {
            collectNumbers (v, out);
        }
    }
    return out;
}

function close (a: number, b: number, decimals: number): boolean {
    const step = 10 ** -decimals;
    return Math.abs (a - b) <= Math.max (Math.abs (b) * 0.005, step / 2 + 1e-12);
}

function matches (n: number, signed: boolean, decimals: number, allowed: number[]): boolean {
    for (const v of allowed) {
        if (signed ? close (n, v, decimals) : close (Math.abs (n), Math.abs (v), decimals)) {
            return true;
        }
    }
    return false;
}

// Numbers with an optional sign (only at a word boundary, so "2-3" is not "-3"), optional $ and a unit suffix.
const NUM_RE = /(?<![\w.])([+\-−]?)(\$?)(\d[\d,]*(?:\.\d+)?)\s?(%|[kKmMbB](?![a-zA-Z])|x(?![a-zA-Z]))?/g;

export function numberCheck (answer: string, data: unknown): { ok: boolean, offending: string[] } {
    const allowed = collectNumbers (data);
    const offending: string[] = [];
    for (const m of answer.matchAll (NUM_RE)) {
        const [ raw, sign, dollar, digits, unitRaw ] = m;
        const unit = (unitRaw || '').toLowerCase ();
        let n = Number (digits.replace (/,/g, ''));
        if (!Number.isFinite (n)) {
            continue;
        }
        const decimals = (digits.split ('.')[1] || '').length;
        const hasClaimUnit = dollar !== '' || unit !== '';
        const isSmallInt = Number.isInteger (n) && n <= 100 && decimals === 0 && !hasClaimUnit && sign === '';
        if (isSmallInt) {
            continue;
        }
        const mult = unit === 'k' ? 1e3 : (unit === 'm' ? 1e6 : (unit === 'b' ? 1e9 : 1));
        n *= mult;
        const signed = sign !== '';
        if (sign === '-' || sign === '−') {
            n = -n;
        }
        // "99k" style rounding: allow the precision of the written number, scaled by its unit
        const effDecimals = mult > 1 ? decimals - Math.log10 (mult) : decimals;
        if (!matches (n, signed, effDecimals, allowed)) {
            offending.push (raw.trim ());
        }
    }
    return { ok: offending.length === 0, offending };
}
