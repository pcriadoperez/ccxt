// Small text utilities shared by the TypeScript and Python transforms.
// Deliberately dependency-free so `npx ccxt-migrate` stays a single fast download.

export type Todo = {
    /** 0-based index into the *original* source lines. */
    line: number;
    message: string;
};

export type Change = {
    line: number;
    rule: string;
    detail: string;
};

export type Unsupported = {
    line: number;
    symbol: string;
    note: string;
};

export class Patch {
    /** The source as it was handed to the transform. All indices are into this. */
    readonly original: string;

    private edits: { start: number; end: number; text: string; insert: boolean }[] = [];

    private lineStarts: number[];

    todos: Todo[] = [];

    changes: Change[] = [];

    unsupported: Unsupported[] = [];

    constructor (source: string) {
        this.original = source;
        this.lineStarts = [ 0 ];
        for (let i = 0; i < source.length; i++) {
            if (source[i] === '\n') {
                this.lineStarts.push (i + 1);
            }
        }
    }

    /** 0-based line number that `index` falls on. */
    lineAt (index: number): number {
        let lo = 0;
        let hi = this.lineStarts.length - 1;
        while (lo < hi) {
            const mid = Math.ceil ((lo + hi) / 2);
            if (this.lineStarts[mid] <= index) {
                lo = mid;
            } else {
                hi = mid - 1;
            }
        }
        return lo;
    }

    /** Replace `original[start:end]` with `text`. */
    edit (start: number, end: number, text: string) {
        this.edits.push ({ start, end, text, 'insert': false });
    }

    note (index: number, rule: string, detail: string) {
        this.changes.push ({ 'line': this.lineAt (index) + 1, rule, detail });
    }

    /** Queue a TODO comment above the line containing `index`. */
    todo (index: number, message: string) {
        const line = this.lineAt (index);
        const already = this.todos.some ((t) => t.line === line && t.message === message);
        if (!already) {
            this.todos.push ({ line, message });
        }
    }

    unsupportedSymbol (index: number, symbol: string, note: string) {
        const line = this.lineAt (index) + 1;
        const already = this.unsupported.some ((u) => u.symbol === symbol && u.line === line);
        if (!already) {
            this.unsupported.push ({ line, symbol, note });
        }
    }

    get changed (): boolean {
        return (this.edits.length > 0) || (this.todos.length > 0);
    }

    /**
     * Apply every queued edit plus every queued TODO comment, all against the
     * original index space, and return the rewritten source.
     *
     * TODO comments are inserted at the start of their anchor line, so they are
     * modelled as zero-width insertions. Edits are applied right-to-left; when an
     * insertion shares a start offset with a replacement the replacement goes
     * first, which leaves the comment sitting above the rewritten code.
     */
    render (commentPrefix: string): string {
        const all = this.edits.slice ();
        for (const t of this.todos) {
            const at = this.lineStarts[t.line];
            const indent = this.original.slice (at).match (/^[ \t]*/)![0];
            all.push ({
                'start': at,
                'end': at,
                'text': indent + commentPrefix + ' TODO(ccxt-migrate): ' + t.message + '\n',
                'insert': true,
            });
        }
        all.sort ((a, b) => {
            if (b.start !== a.start) {
                return b.start - a.start;
            }
            // same offset: apply replacements before insertions so the inserted
            // comment ends up *above* the replacement in the output
            return Number (a.insert) - Number (b.insert);
        });
        let out = this.original;
        let lastStart = Infinity;
        for (const e of all) {
            if (e.end > lastStart) {
                continue;   // overlaps an edit we already applied — drop it rather than corrupt the file
            }
            out = out.slice (0, e.start) + e.text + out.slice (e.end);
            lastStart = Math.min (lastStart, e.start);
        }
        return out;
    }
}

/**
 * Given the index of an opening bracket, return the index of its match,
 * skipping over string literals, template literals and comments.
 * Returns -1 when unbalanced.
 */
export function matchBracket (src: string, open: number): number {
    const pairs: Record<string, string> = { '(': ')', '{': '}', '[': ']' };
    const opener = src[open];
    const closer = pairs[opener];
    if (closer === undefined) {
        return -1;
    }
    let depth = 0;
    let i = open;
    while (i < src.length) {
        const ch = src[i];
        if (ch === '"' || ch === "'" || ch === '`') {
            i = skipString (src, i);
            continue;
        }
        if (ch === '/' && src[i + 1] === '/') {
            while (i < src.length && src[i] !== '\n') {
                i++;
            }
            continue;
        }
        if (ch === '/' && src[i + 1] === '*') {
            const end = src.indexOf ('*/', i + 2);
            i = (end === -1) ? src.length : end + 2;
            continue;
        }
        if (ch === '#') { // python comment; harmless in JS because '#' outside a string is rare
            while (i < src.length && src[i] !== '\n') {
                i++;
            }
            continue;
        }
        if (ch === opener) {
            depth++;
        } else if (ch === closer) {
            depth--;
            if (depth === 0) {
                return i;
            }
        }
        i++;
    }
    return -1;
}

/** Index just past the string literal that starts at `start`. */
export function skipString (src: string, start: number): number {
    const quote = src[start];
    let i = start + 1;
    while (i < src.length) {
        if (src[i] === '\\') {
            i += 2;
            continue;
        }
        if (src[i] === quote) {
            return i + 1;
        }
        i++;
    }
    return src.length;
}

/**
 * Split an argument list (the text between brackets) on top-level commas.
 * Returns trimmed, non-empty pieces.
 */
export function splitArgs (text: string): string[] {
    const out: string[] = [];
    let depth = 0;
    let start = 0;
    let i = 0;
    while (i < text.length) {
        const ch = text[i];
        if (ch === '"' || ch === "'" || ch === '`') {
            i = skipString (text, i);
            continue;
        }
        if (ch === '(' || ch === '{' || ch === '[') {
            depth++;
        } else if (ch === ')' || ch === '}' || ch === ']') {
            depth--;
        } else if (ch === ',' && depth === 0) {
            out.push (text.slice (start, i).trim ());
            start = i + 1;
        }
        i++;
    }
    out.push (text.slice (start).trim ());
    return out.filter ((s) => s.length > 0);
}

/**
 * Parse `key: value` / `key=value` pairs out of one level of an object literal
 * or keyword-argument list. Shorthand (`walletAddress`) maps key -> key.
 */
export function parsePairs (text: string, separator: ':' | '='): Record<string, string> {
    const out: Record<string, string> = {};
    for (const piece of splitArgs (text)) {
        const idx = findTopLevel (piece, separator);
        if (idx === -1) {
            const bare = piece.replace (/^\.\.\./, '').trim ();
            if (/^[A-Za-z_$][\w$]*$/.test (bare)) {
                out[bare] = bare;
            }
            continue;
        }
        const key = piece.slice (0, idx).trim ().replace (/^['"]|['"]$/g, '');
        out[key] = piece.slice (idx + 1).trim ();
    }
    return out;
}

function findTopLevel (text: string, ch: string): number {
    let depth = 0;
    let i = 0;
    while (i < text.length) {
        const c = text[i];
        if (c === '"' || c === "'" || c === '`') {
            i = skipString (text, i);
            continue;
        }
        if (c === '(' || c === '{' || c === '[') {
            depth++;
        } else if (c === ')' || c === '}' || c === ']') {
            depth--;
        } else if (c === ch && depth === 0) {
            return i;
        }
        i++;
    }
    return -1;
}
