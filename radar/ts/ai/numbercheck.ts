// Guardrail: every number in an AI answer must come from the data we gave it.
// Small integers (counts, hours, list numbers) are allowed; anything else must match a data value within rounding.

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

function matches (n: number, allowed: number[]): boolean {
    const a = Math.abs (n);
    for (const v of allowed) {
        const b = Math.abs (v);
        if (a === b) {
            return true;
        }
        // rounding tolerance: 0.5% relative, or the last shown decimal place
        const decimals = (String (n).split ('.')[1] || '').length;
        const step = 10 ** -decimals;
        if (Math.abs (a - b) <= Math.max (b * 0.005, step / 2 + 1e-12)) {
            return true;
        }
    }
    return false;
}

export function numberCheck (answer: string, data: unknown): { ok: boolean, offending: string[] } {
    const allowed = collectNumbers (data);
    const offending: string[] = [];
    for (const m of answer.matchAll (/-?\d[\d,]*(?:\.\d+)?/g)) {
        const raw = m[0];
        const n = Number (raw.replace (/,/g, ''));
        if (!Number.isFinite (n)) {
            continue;
        }
        const isSmallInt = Number.isInteger (n) && Math.abs (n) <= 100 && raw.indexOf ('.') === -1;
        if (isSmallInt) {
            continue;
        }
        if (!matches (n, allowed)) {
            offending.push (raw);
        }
    }
    return { ok: offending.length === 0, offending };
}
