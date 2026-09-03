// pmxtjs -> ccxt transform for TypeScript / JavaScript sources.

import { VENUES, ERRORS, OPTIONS, methodRule } from './rules.js';
import { Patch, matchBracket, parsePairs, splitArgs } from './util.js';
import { adaptArgs } from './argmap.js';

const NAMED_IMPORT_RE = /(?:^|\n)([ \t]*)import\s+(type\s+)?([\s\S]*?)\s+from\s*['"]pmxtjs['"][ \t]*;?/g;
const REQUIRE_RE = /(?:^|\n)([ \t]*)(const|let|var)\s+([\s\S]*?)\s*=\s*require\s*\(\s*['"]pmxtjs['"]\s*\)[ \t]*;?/g;

export type TsResult = {
    code: string;
    patch: Patch;
    /** true when the file subscribes with watch or unwatch calls, so it needs ccxt.pro */
    needsPro: boolean;
};

export function transformTypeScript (source: string): TsResult {
    const patch = new Patch (source);

    // --- 1. what did the file import from pmxtjs? --------------------------
    const venueLocals = new Map<string, string> ();   // local name -> pmxt venue class
    const errorLocals = new Map<string, string> ();   // local name -> pmxt error class
    let namespaceLocal: string | null = null;         // `import pmxt from 'pmxtjs'`
    let importedAnything = false;

    const collect = (clause: string) => {
        const braced = clause.match (/\{([\s\S]*?)\}/);
        const outside = clause.replace (/\{[\s\S]*?\}/, '').replace (/,/g, ' ').trim ();
        const star = outside.match (/\*\s+as\s+([\w$]+)/);
        if (star) {
            namespaceLocal = star[1];
        } else if (/^[\w$]+$/.test (outside)) {
            namespaceLocal = outside;
        }
        if (braced) {
            for (const piece of splitArgs (braced[1])) {
                const m = piece.replace (/^type\s+/, '').match (/^([\w$]+)(?:\s+as\s+([\w$]+))?$/);
                if (!m) {
                    continue;
                }
                const [ , imported, alias ] = m;
                const local = alias ?? imported;
                if (imported in VENUES) {
                    venueLocals.set (local, imported);
                } else if (imported in ERRORS) {
                    errorLocals.set (local, imported);
                }
            }
        }
    };

    for (const m of source.matchAll (NAMED_IMPORT_RE)) {
        importedAnything = true;
        collect (m[3]);
    }
    for (const m of source.matchAll (REQUIRE_RE)) {
        importedAnything = true;
        collect (m[3]);
    }
    if (!importedAnything) {
        // Nothing to do — caller decides whether to report the file as skipped.
        return { 'code': source, patch, 'needsPro': false };
    }

    // Idempotency guard. A second pass would rewrite the pmxtjs import this
    // codemod deliberately kept for venues CCXT does not cover, so refuse to
    // touch a file that has already been through it.
    if (source.indexOf ('TODO(ccxt-migrate)') !== -1) {
        return { 'code': source, patch, 'needsPro': false };
    }
    // Nothing here maps onto CCXT (e.g. a file that only imports Polymarket) —
    // rewriting the import would break it for no gain.
    const migratable = (errorLocals.size > 0) || (namespaceLocal !== null)
        || [ ...venueLocals.values () ].some ((v) => VENUES[v].ccxtId !== null);
    if (!migratable) {
        return { 'code': source, patch, 'needsPro': false };
    }

    const needsPro = /\.(watch[A-Z]\w*|unwatch[A-Z]\w*|firehose)\s*\(/.test (source);
    const isCjs = REQUIRE_RE.test (source);
    REQUIRE_RE.lastIndex = 0;

    // --- 2. rewrite the pmxtjs import ------------------------------------
    const importRanges: [number, number][] = [];
    const insideImport = (index: number) => importRanges.some (([ a, b ]) => (index >= a) && (index < b));

    const ccxtErrors = new Set<string> ();
    for (const pmxtName of errorLocals.values ()) {
        ccxtErrors.add (ERRORS[pmxtName]);
    }

    // Venues CCXT has no integration for keep their pmxtjs import, so the file
    // still compiles and the user can decide per call site.
    const keptVenues: string[] = [];
    for (const [ local, venue ] of venueLocals) {
        if (VENUES[venue].ccxtId === null) {
            keptVenues.push ((local === venue) ? venue : (venue + ' as ' + local));
        }
    }
    // `new pmxt.Kalshi()` style: CCXT has nothing to point that at, so the pmxtjs
    // namespace import has to survive alongside the new ccxt one.
    let keepNamespace = false;
    if (namespaceLocal !== null) {
        const nsCtorRe = new RegExp ('new\\s+' + namespaceLocal + '\\s*\\.\\s*([A-Z][\\w$]*)\\s*\\(', 'g');
        for (const m of source.matchAll (nsCtorRe)) {
            if ((m[1] in VENUES) && (VENUES[m[1]].ccxtId === null)) {
                keepNamespace = true;
            }
        }
    }

    const rewriteImport = (m: RegExpMatchArray, indent: string) => {
        const start = m.index! + (m[0].startsWith ('\n') ? 1 : 0);
        const end = m.index! + m[0].length;
        const lines: string[] = [];
        if (isCjs) {
            lines.push (indent + 'const ccxt = require (\'ccxt\');');
            if (ccxtErrors.size) {
                lines.push (indent + 'const { ' + [ ...ccxtErrors ].join (', ') + ' } = ccxt;');
            }
            if (keepNamespace) {
                lines.push (indent + '// TODO(ccxt-migrate): CCXT has no integration for some pmxt venues used here — kept the pmxtjs import for them.');
                lines.push (indent + 'const ' + namespaceLocal + ' = require (\'pmxtjs\');');
            }
            if (keptVenues.length) {
                lines.push (indent + '// TODO(ccxt-migrate): CCXT has no integration for these pmxt venues — kept on pmxtjs for now.');
                lines.push (indent + 'const { ' + keptVenues.join (', ') + ' } = require (\'pmxtjs\');');
            }
        } else {
            const named = ccxtErrors.size ? (', { ' + [ ...ccxtErrors ].join (', ') + ' }') : '';
            lines.push (indent + 'import ccxt' + named + ' from \'ccxt\';');
            if (keepNamespace) {
                lines.push (indent + '// TODO(ccxt-migrate): CCXT has no integration for some pmxt venues used here — kept the pmxtjs import for them.');
                lines.push (indent + 'import * as ' + namespaceLocal + ' from \'pmxtjs\';');
            }
            if (keptVenues.length) {
                lines.push (indent + '// TODO(ccxt-migrate): CCXT has no integration for these pmxt venues — kept on pmxtjs for now.');
                lines.push (indent + 'import { ' + keptVenues.join (', ') + ' } from \'pmxtjs\';');
            }
        }
        patch.edit (start, end, lines.join ('\n'));
        patch.note (start, 'import', 'pmxtjs -> ccxt');
    };

    let seenImport = false;
    for (const m of source.matchAll (NAMED_IMPORT_RE)) {
        importRanges.push ([ m.index!, m.index! + m[0].length ]);
        if (seenImport) {
            patch.edit (m.index! + (m[0].startsWith ('\n') ? 1 : 0), m.index! + m[0].length, '');
            continue;
        }
        seenImport = true;
        rewriteImport (m, m[1] ?? '');
    }
    for (const m of source.matchAll (REQUIRE_RE)) {
        importRanges.push ([ m.index!, m.index! + m[0].length ]);
        if (seenImport) {
            patch.edit (m.index! + (m[0].startsWith ('\n') ? 1 : 0), m.index! + m[0].length, '');
            continue;
        }
        seenImport = true;
        rewriteImport (m, m[1] ?? '');
    }

    // --- 3. constructors --------------------------------------------------
    const ctorRe = /new\s+(?:([\w$]+)\s*\.\s*)?([\w$]+)\s*\(/g;
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
        const argText = source.slice (openParen + 1, closeParen);
        const braceStart = argText.indexOf ('{');
        let newArgs = argText;
        if (braceStart !== -1) {
            const absBrace = openParen + 1 + braceStart;
            const absBraceEnd = matchBracket (source, absBrace);
            if (absBraceEnd !== -1) {
                const inner = source.slice (absBrace + 1, absBraceEnd);
                const pairs = parsePairs (inner, ':');
                const kept: string[] = [];
                for (const [ key, value ] of Object.entries (pairs)) {
                    const opt = OPTIONS[key];
                    if (opt === undefined) {
                        kept.push ("'" + key + "': " + value);
                    } else if (opt.ccxt === null) {
                        patch.todo (m.index!, 'dropped constructor option `' + key + '`. ' + opt.note);
                    } else {
                        kept.push ("'" + opt.ccxt + "': " + value);
                    }
                }
                newArgs = kept.length ? ('{ ' + kept.join (', ') + ' }') : '';
            }
        }
        // Prediction venues live in their own namespace and are not part of
        // ccxt.pro — the pro classes cover the crypto exchanges only.
        let target = 'ccxt.' + rule.ccxtId;
        if (rule.namespace === 'prediction') {
            target = 'ccxt.prediction.' + rule.ccxtId;
        } else if (needsPro) {
            target = 'ccxt.pro.' + rule.ccxtId;
        }
        patch.edit (m.index!, closeParen + 1, 'new ' + target + ' (' + newArgs + ')');
        patch.note (m.index!, 'constructor', venue + ' -> ' + target);
        if (rule.namespace === 'prediction') {
            patch.todo (m.index!, 'mapped to `' + target + '`. Same events/markets/outcomes model and 0..1 pricing as pmxt, but verify the outcome handles: ' + rule.note);
        } else {
            patch.todo (m.index!, 'CCXT `' + rule.ccxtId + '` is a different product surface than pmxt `' + venue + '`. ' + rule.note);
        }
    }

    // --- 4. createOrder object argument -> positional arguments ----------
    const createRe = /\.\s*createOrder\s*\(/g;
    for (const m of source.matchAll (createRe)) {
        const openParen = m.index! + m[0].length - 1;
        const closeParen = matchBracket (source, openParen);
        if (closeParen === -1) {
            continue;
        }
        const argText = source.slice (openParen + 1, closeParen).trim ();
        if (!argText.startsWith ('{')) {
            continue;   // already positional
        }
        const braceEnd = matchBracket (argText, 0);
        if (braceEnd === -1) {
            continue;
        }
        const pairs = parsePairs (argText.slice (1, braceEnd), ':');
        const symbol = pairs['outcomeId'] ?? pairs['marketId'] ?? 'symbol';
        const type = pairs['type'] ?? "'limit'";
        const side = pairs['side'] ?? "'buy'";
        const amount = pairs['amount'] ?? 'amount';
        const price = pairs['price'] ?? 'undefined';
        const extra: string[] = [];
        for (const [ key, value ] of Object.entries (pairs)) {
            if ([ 'marketId', 'outcomeId', 'side', 'type', 'amount', 'price' ].indexOf (key) === -1) {
                extra.push ("'" + key + "': " + value);
            }
        }
        const args = [ symbol, type, side, amount, price ];
        if (extra.length) {
            args.push ('{ ' + extra.join (', ') + ' }');
        }
        patch.edit (openParen + 1, closeParen, args.join (', '));
        patch.note (m.index!, 'createOrder', 'object argument -> positional (symbol, type, side, amount, price)');
        patch.todo (m.index!, 'createOrder now takes positional arguments. The first one must be a unified CCXT symbol (e.g. \'BTC/USDT\') — ' + symbol + ' is a pmxt id.');
    }

    // --- 5. method renames + unsupported-method TODOs ---------------------
    const callRe = /\.\s*([A-Za-z_$][\w$]*)\s*\(/g;
    for (const m of source.matchAll (callRe)) {
        const name = m[1];
        const found = methodRule (name);
        if (found === undefined) {
            continue;
        }
        const [ camelKey, rule ] = found;
        const openParen = m.index! + m[0].length - 1;
        if (rule.ccxt === null) {
            patch.unsupportedSymbol (m.index!, name + '()', rule.note);
            patch.todo (m.index!, '`' + name + '()` has no CCXT equivalent. ' + rule.note);
            continue;
        }
        if (rule.ccxt !== name) {
            const dot = m[0].indexOf ('.');
            const nameStart = m.index! + m[0].indexOf (name, dot);
            patch.edit (nameStart, nameStart + name.length, rule.ccxt);
            patch.note (m.index!, 'rename', name + '() -> ' + rule.ccxt + '()');
        }
        const closeParen = matchBracket (source, openParen);
        if (closeParen === -1) {
            continue;
        }
        const argText = source.slice (openParen + 1, closeParen);
        const adapted = adaptArgs (camelKey, argText, 'ts');
        if (adapted !== null && adapted.text !== argText.trim ()) {
            patch.edit (openParen + 1, closeParen, adapted.text);
            patch.note (m.index!, 'arguments', name + ' (' + argText.trim () + ') -> ' + rule.ccxt + ' (' + adapted.text + ')');
        }
        for (const extra of adapted?.notes ?? []) {
            patch.todo (m.index!, extra);
        }
        if (rule.signature && (argText.trim ().length > 0 || camelKey === 'fetchBalance')) {
            patch.todo (m.index!, 'signature changed: ' + rule.signature + '. ' + rule.note);
        }
    }

    // --- 6. error identifiers --------------------------------------------
    for (const [ local, pmxtName ] of errorLocals) {
        const target = ERRORS[pmxtName];
        if (target === local) {
            continue;
        }
        const re = new RegExp ('\\b' + local + '\\b', 'g');
        for (const m of source.matchAll (re)) {
            if (insideImport (m.index!)) {
                continue;   // the whole import statement was already replaced
            }
            patch.edit (m.index!, m.index! + local.length, target);
        }
        patch.note (0, 'error', local + ' -> ' + target);
    }
    if (namespaceLocal !== null) {
        const nsErrorRe = new RegExp ('\\b' + namespaceLocal + '\\s*\\.\\s*([A-Z][\\w$]*)', 'g');
        for (const m of source.matchAll (nsErrorRe)) {
            const name = m[1];
            if ((name in ERRORS) && !insideImport (m.index!)) {
                patch.edit (m.index!, m.index! + m[0].length, 'ccxt.' + ERRORS[name]);
                patch.note (m.index!, 'error', namespaceLocal + '.' + name + ' -> ccxt.' + ERRORS[name]);
            }
        }
    }

    return { 'code': patch.render ('//'), patch, needsPro };
}
