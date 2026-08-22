// pmxt -> ccxt transform for Python sources.
//
// Two things make Python different from the TypeScript side:
//   * pmxt takes keyword arguments (pmxt.Polymarket(pmxt_api_key=...)) while
//     CCXT takes a single config dict with camelCase keys.
//   * CCXT ships three Python packages - ccxt (sync), ccxt.async_support and
//     ccxt.pro - and which one you want depends on whether the file awaits.

import { VENUES, ERRORS, OPTIONS, methodRule, snakeCase } from './rules.js';
import { Patch, matchBracket, parsePairs, splitArgs } from './util.js';
import { adaptArgs } from './argmap.js';

const IMPORT_MODULE_RE = /(?:^|\n)([ \t]*)import\s+pmxt(?:\s+as\s+([\w]+))?[ \t]*(?=\n|$)/g;
const FROM_IMPORT_RE = /(?:^|\n)([ \t]*)from\s+pmxt(?:\.[\w.]+)?\s+import\s+([^\n]+)/g;

export type PyResult = {
    code: string;
    patch: Patch;
    /** true when the file subscribes with watch or unwatch calls, so it needs ccxt.pro */
    needsPro: boolean;
    /** true when the file is async and therefore needs ccxt.async_support */
    isAsync: boolean;
};

export function transformPython (source: string): PyResult {
    const patch = new Patch (source);

    const venueLocals = new Map<string, string> ();
    const errorLocals = new Map<string, string> ();
    let namespaceLocal: string | null = null;
    let importedAnything = false;
    const importRanges: [number, number][] = [];
    const insideImport = (index: number) => importRanges.some (([ a, b ]) => (index >= a) && (index < b));

    for (const m of source.matchAll (IMPORT_MODULE_RE)) {
        importedAnything = true;
        importRanges.push ([ m.index!, m.index! + m[0].length ]);
        namespaceLocal = m[2] ?? 'pmxt';
    }
    for (const m of source.matchAll (FROM_IMPORT_RE)) {
        importedAnything = true;
        importRanges.push ([ m.index!, m.index! + m[0].length ]);
        const clause = m[2].replace (/[()]/g, '');
        for (const piece of splitArgs (clause)) {
            const parts = piece.trim ().match (/^([\w]+)(?:\s+as\s+([\w]+))?$/);
            if (!parts) {
                continue;
            }
            const [ , imported, alias ] = parts;
            const local = alias ?? imported;
            if (imported in VENUES) {
                venueLocals.set (local, imported);
            } else if (imported in ERRORS) {
                errorLocals.set (local, imported);
            }
        }
    }
    if (!importedAnything) {
        return { 'code': source, patch, 'needsPro': false, 'isAsync': false };
    }

    // Idempotency guard — see the TypeScript transform for why.
    if (source.indexOf ('TODO(ccxt-migrate)') !== -1) {
        return { 'code': source, patch, 'needsPro': false, 'isAsync': false };
    }
    const migratable = (errorLocals.size > 0) || (namespaceLocal !== null)
        || [ ...venueLocals.values () ].some ((v) => VENUES[v].ccxtId !== null);
    if (!migratable) {
        return { 'code': source, patch, 'needsPro': false, 'isAsync': false };
    }

    const needsPro = /\.(watch_[\w]+|unwatch_[\w]+|firehose)\s*\(/.test (source);
    const isAsync = /\bawait\s|\basync\s+def\s/.test (source);

    // --- 1. imports -------------------------------------------------------
    let ccxtModule = 'ccxt';
    if (needsPro) {
        ccxtModule = 'ccxt.pro';
    } else if (isAsync) {
        ccxtModule = 'ccxt.async_support';
    }
    const importLine = (indent: string) => {
        if (ccxtModule === 'ccxt') {
            return indent + 'import ccxt';
        }
        return indent + 'import ' + ccxtModule + ' as ccxt';
    };

    const keptVenues: string[] = [];
    for (const [ local, venue ] of venueLocals) {
        if (VENUES[venue].ccxtId === null) {
            keptVenues.push ((local === venue) ? venue : (venue + ' as ' + local));
        }
    }
    // `pmxt.Kalshi()` style: CCXT has nothing to point that at, so the pmxt
    // module import has to survive alongside the new ccxt one.
    let keepNamespace = false;
    if (namespaceLocal !== null) {
        const nsCtorRe = new RegExp ('\\b' + namespaceLocal + '\\s*\\.\\s*([A-Z][\\w]*)\\s*\\(', 'g');
        for (const m of source.matchAll (nsCtorRe)) {
            if ((m[1] in VENUES) && (VENUES[m[1]].ccxtId === null)) {
                keepNamespace = true;
            }
        }
    }

    let seenImport = false;
    const rewriteImport = (m: RegExpMatchArray) => {
        const start = m.index! + (m[0].startsWith ('\n') ? 1 : 0);
        const end = m.index! + m[0].length;
        if (seenImport) {
            patch.edit (start, end, '');
            return;
        }
        seenImport = true;
        const indent = m[1] ?? '';
        const lines = [ importLine (indent) ];
        if (keepNamespace) {
            lines.push (indent + '# TODO(ccxt-migrate): CCXT has no integration for some pmxt venues used here — kept the pmxt import for them.');
            lines.push (indent + 'import pmxt' + ((namespaceLocal !== 'pmxt') ? (' as ' + namespaceLocal) : ''));
        }
        if (keptVenues.length) {
            lines.push (indent + '# TODO(ccxt-migrate): CCXT has no integration for these pmxt venues — kept on pmxt for now.');
            lines.push (indent + 'from pmxt import ' + keptVenues.join (', '));
        }
        patch.edit (start, end, lines.join ('\n'));
        patch.note (start, 'import', 'pmxt -> ' + ccxtModule);
    };
    for (const m of source.matchAll (IMPORT_MODULE_RE)) {
        rewriteImport (m);
    }
    for (const m of source.matchAll (FROM_IMPORT_RE)) {
        rewriteImport (m);
    }

    // --- 2. constructors: kwargs -> a CCXT config dict --------------------
    const ctorRe = /(?:([\w]+)\s*\.\s*)?([\w]+)\s*\(/g;
    for (const m of source.matchAll (ctorRe)) {
        const [ , qualifier, name ] = m;
        let venue: string | undefined;
        if (qualifier !== undefined) {
            if (qualifier !== namespaceLocal) {
                continue;
            }
            venue = (name in VENUES) ? name : undefined;
        } else {
            venue = venueLocals.get (name);
        }
        if (venue === undefined) {
            continue;
        }
        const rule = VENUES[venue];
        const openParen = m.index! + m[0].length - 1;
        const closeParen = matchBracket (source, openParen);
        if (closeParen === -1) {
            continue;
        }
        if (rule.ccxtId === null) {
            patch.unsupportedSymbol (m.index!, venue, rule.note);
            patch.todo (m.index!, 'pmxt venue `' + venue + '` has no CCXT exchange. ' + rule.note + ' Pick a CCXT exchange for this workload or keep pmxt for this venue.');
            continue;
        }
        const pairs = parsePairs (source.slice (openParen + 1, closeParen), '=');
        const kept: string[] = [];
        for (const [ key, value ] of Object.entries (pairs)) {
            // pmxt python kwargs are snake_case; CCXT config keys are camelCase
            const camel = Object.keys (OPTIONS).find ((k) => snakeCase (k) === key) ?? key;
            const opt = OPTIONS[camel];
            if (opt === undefined) {
                kept.push ("'" + camel + "': " + value);
            } else if (opt.ccxt === null) {
                patch.todo (m.index!, 'dropped constructor option `' + key + '`. ' + opt.note);
            } else {
                kept.push ("'" + opt.ccxt + "': " + value);
            }
        }
        const config = kept.length ? ('{\n    ' + kept.join (',\n    ') + ',\n}') : '';
        patch.edit (m.index!, closeParen + 1, 'ccxt.' + rule.ccxtId + ' (' + config + ')');
        patch.note (m.index!, 'constructor', venue + ' -> ccxt.' + rule.ccxtId + ' (kwargs -> config dict)');
        patch.todo (m.index!, 'CCXT `' + rule.ccxtId + '` is a different product surface than pmxt `' + venue + '`. ' + rule.note);
    }

    // --- 3. create_order kwargs -> positional -----------------------------
    for (const m of source.matchAll (/\.\s*create_order\s*\(/g)) {
        const openParen = m.index! + m[0].length - 1;
        const closeParen = matchBracket (source, openParen);
        if (closeParen === -1) {
            continue;
        }
        const inner = source.slice (openParen + 1, closeParen);
        if (inner.indexOf ('=') === -1) {
            continue;   // already positional
        }
        const pairs = parsePairs (inner, '=');
        const symbol = pairs['outcome_id'] ?? pairs['market_id'] ?? 'symbol';
        const type = pairs['order_type'] ?? pairs['type'] ?? "'limit'";
        const side = pairs['side'] ?? "'buy'";
        const amount = pairs['amount'] ?? 'amount';
        const price = pairs['price'] ?? 'None';
        const known = [ 'market_id', 'outcome_id', 'side', 'type', 'order_type', 'amount', 'price' ];
        const extra: string[] = [];
        for (const [ key, value ] of Object.entries (pairs)) {
            if (known.indexOf (key) === -1) {
                extra.push ("'" + key + "': " + value);
            }
        }
        const args = [ symbol, type, side, amount, price ];
        if (extra.length) {
            args.push ('{ ' + extra.join (', ') + ' }');
        }
        patch.edit (openParen + 1, closeParen, args.join (', '));
        patch.note (m.index!, 'create_order', 'keyword arguments -> positional (symbol, type, side, amount, price)');
        patch.todo (m.index!, 'create_order now takes positional arguments. The first one must be a unified CCXT symbol (e.g. \'BTC/USDT\') — ' + symbol + ' is a pmxt id.');
    }

    // --- 4. method renames ------------------------------------------------
    for (const m of source.matchAll (/\.\s*([A-Za-z_][\w]*)\s*\(/g)) {
        const name = m[1];
        const found = methodRule (name);
        if (found === undefined) {
            continue;
        }
        const [ camelKey, rule ] = found;
        if (rule.ccxt === null) {
            patch.unsupportedSymbol (m.index!, name + '()', rule.note);
            patch.todo (m.index!, '`' + name + '()` has no CCXT equivalent. ' + rule.note);
            continue;
        }
        const target = snakeCase (rule.ccxt);
        if (target !== name) {
            const nameStart = m.index! + m[0].indexOf (name, m[0].indexOf ('.'));
            patch.edit (nameStart, nameStart + name.length, target);
            patch.note (m.index!, 'rename', name + '() -> ' + target + '()');
        }
        const openParen = m.index! + m[0].length - 1;
        const closeParen = matchBracket (source, openParen);
        if (closeParen === -1) {
            continue;
        }
        const argText = source.slice (openParen + 1, closeParen);
        const adapted = adaptArgs (camelKey, argText, 'py');
        if (adapted !== null && adapted.text !== argText.trim ()) {
            patch.edit (openParen + 1, closeParen, adapted.text);
            patch.note (m.index!, 'arguments', name + ' (' + argText.trim () + ') -> ' + target + ' (' + adapted.text + ')');
        }
        for (const extra of adapted?.notes ?? []) {
            patch.todo (m.index!, extra);
        }
        if (rule.signature && (argText.trim ().length > 0 || camelKey === 'fetchBalance')) {
            patch.todo (m.index!, 'signature changed: ' + rule.signature + '. ' + rule.note);
        }
    }

    // --- 5. errors ---------------------------------------------------------
    for (const [ local, pmxtName ] of errorLocals) {
        const target = ERRORS[pmxtName];
        if (target === local) {
            continue;
        }
        for (const m of source.matchAll (new RegExp ('\\b' + local + '\\b', 'g'))) {
            if (insideImport (m.index!)) {
                continue;
            }
            patch.edit (m.index!, m.index! + local.length, target);
        }
        patch.note (0, 'error', local + ' -> ' + target);
    }
    if (namespaceLocal !== null) {
        const nsRe = new RegExp ('\\b' + namespaceLocal + '\\s*\\.\\s*([A-Z][\\w]*)', 'g');
        for (const m of source.matchAll (nsRe)) {
            const name = m[1];
            if ((name in ERRORS) && !insideImport (m.index!)) {
                patch.edit (m.index!, m.index! + m[0].length, 'ccxt.' + ERRORS[name]);
                patch.note (m.index!, 'error', namespaceLocal + '.' + name + ' -> ccxt.' + ERRORS[name]);
            }
        }
    }

    return { 'code': patch.render ('#'), patch, needsPro, isAsync };
}
