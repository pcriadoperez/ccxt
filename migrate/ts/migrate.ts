#!/usr/bin/env node
// ccxt-migrate — codemod + AI-agent handoff for moving a project from pmxt to CCXT.
//
//   npx ccxt-migrate@latest                    # scan ./ , show a plan, apply it
//   npx ccxt-migrate@latest src --dry-run      # show the diff without writing
//   npx ccxt-migrate@latest prompt             # print the AI-agent prompt
//   npx ccxt-migrate@latest rules              # print the full mapping tables

import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { transformTypeScript } from './transform-ts.js';
import { transformPython } from './transform-py.js';
import { renderReport, renderRules, FileResult } from './report.js';
import { AGENT_PROMPT } from './prompt.js';

const VERSION = '1.0.0';

const TS_EXT = [ '.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs' ];
const PY_EXT = [ '.py' ];
const SKIP_DIRS = new Set ([ 'node_modules', 'dist', 'build', 'out', 'venv', '__pycache__', 'site-packages', 'vendor' ]);

type Options = {
    paths: string[];
    dryRun: boolean;
    report: string | null;
    yes: boolean;
};

function parseArgs (argv: string[]): { command: string; options: Options } {
    const options: Options = { 'paths': [], 'dryRun': false, 'report': 'MIGRATION-REPORT.md', 'yes': false };
    let command = 'run';
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === 'prompt' || arg === 'rules' || arg === 'run') {
            command = arg;
        } else if (arg === '--dry-run' || arg === '-n') {
            options.dryRun = true;
        } else if (arg === '--yes' || arg === '-y') {
            options.yes = true;
        } else if (arg === '--no-report') {
            options.report = null;
        } else if (arg === '--report') {
            i += 1;
            options.report = argv[i];
        } else if (arg === '--help' || arg === '-h') {
            command = 'help';
        } else if (arg === '--version' || arg === '-v') {
            command = 'version';
        } else if (arg.startsWith ('-')) {
            console.error ('unknown flag: ' + arg + ' (try --help)');
            process.exit (2);
        } else {
            options.paths.push (arg);
        }
    }
    if (options.paths.length === 0) {
        options.paths.push ('.');
    }
    return { command, options };
}

const HELP = [
    'ccxt-migrate ' + VERSION + ' — move a project from pmxt to CCXT',
    '',
    'USAGE',
    '  npx ccxt-migrate@latest [paths...] [options]',
    '  npx ccxt-migrate@latest prompt',
    '  npx ccxt-migrate@latest rules',
    '',
    'COMMANDS',
    '  run (default)   Rewrite pmxt calls to CCXT in the given paths (default: .)',
    '  prompt          Print the prompt to hand an AI coding agent',
    '  rules           Print the full pmxt -> CCXT mapping tables as markdown',
    '',
    'OPTIONS',
    '  -n, --dry-run   Show what would change; write nothing',
    '  -y, --yes       Skip the confirmation prompt',
    '      --report P  Where to write the migration report (default MIGRATION-REPORT.md)',
    '      --no-report Do not write a report',
    '  -h, --help      Show this help',
    '  -v, --version   Show the version',
    '',
    'The codemod does the mechanical half: imports, constructors, method renames,',
    'argument order, error classes. It leaves a TODO(ccxt-migrate) marker wherever',
    'the correct answer needs a human — unified symbols, response shapes, and any',
    'pmxt venue CCXT has no integration for. Read the report; the "Not migrated"',
    'section is the one that matters.',
].join ('\n');

function walk (target: string, out: string[]) {
    let stat: fs.Stats;
    try {
        stat = fs.statSync (target);
    } catch {
        console.error ('cannot read ' + target);
        return;
    }
    if (stat.isFile ()) {
        out.push (target);
        return;
    }
    if (!stat.isDirectory ()) {
        return;
    }
    for (const entry of fs.readdirSync (target, { 'withFileTypes': true })) {
        const full = path.join (target, entry.name);
        if (entry.isDirectory ()) {
            if (!SKIP_DIRS.has (entry.name) && !entry.name.startsWith ('.')) {
                walk (full, out);
            }
        } else if (entry.isFile ()) {
            const ext = path.extname (entry.name);
            if (TS_EXT.indexOf (ext) !== -1 || PY_EXT.indexOf (ext) !== -1) {
                out.push (full);
            }
        }
    }
}

/** Cheap pre-filter so we only parse files that actually mention pmxt. */
function mentionsPmxt (source: string): boolean {
    return /from\s+['"]pmxtjs['"]|require\s*\(\s*['"]pmxtjs['"]|^\s*import\s+pmxt\b|^\s*from\s+pmxt(\.|\s)/m.test (source);
}

/**
 * Human-readable preview diff. Not a patch format — it is only ever printed,
 * never applied, so a cheap forward-scan alignment is enough.
 */
function previewDiff (before: string, after: string, file: string): string {
    const a = before.split ('\n');
    const b = after.split ('\n');
    const lines: string[] = [ '--- a/' + file, '+++ b/' + file ];
    let i = 0;
    let j = 0;
    while (i < a.length || j < b.length) {
        if (i < a.length && j < b.length && a[i] === b[j]) {
            i += 1;
            j += 1;
            continue;
        }
        const resync = (i < a.length) ? b.indexOf (a[i], j) : -1;
        if (resync !== -1 && resync - j < 40) {
            while (j < resync) {
                lines.push ('+' + b[j]);
                j += 1;
            }
        } else if (i < a.length) {
            lines.push ('-' + a[i]);
            i += 1;
        } else {
            lines.push ('+' + b[j]);
            j += 1;
        }
    }
    return lines.join ('\n');
}

async function confirm (question: string): Promise<boolean> {
    if (!process.stdin.isTTY) {
        return false;
    }
    const rl = readline.createInterface ({ 'input': process.stdin, 'output': process.stdout });
    const answer = await new Promise<string> ((resolve) => rl.question (question, resolve));
    rl.close ();
    return /^y(es)?$/i.test (answer.trim ());
}

function ccxtVersion (): string {
    try {
        const local = path.join (process.cwd (), 'node_modules', 'ccxt', 'package.json');
        return JSON.parse (fs.readFileSync (local, 'utf8')).version;
    } catch {
        return 'latest';
    }
}

function dependencyAdvice (results: FileResult[]): string[] {
    const advice: string[] = [];
    if (results.some ((r) => r.language === 'typescript')) {
        advice.push ('npm uninstall pmxtjs && npm install ccxt');
    }
    if (results.some ((r) => r.language === 'python')) {
        advice.push ('pip uninstall pmxt && pip install ccxt');
    }
    return advice;
}

function collect (options: Options): { results: FileResult[]; alreadyMigrated: string[] } {
    const candidates: string[] = [];
    for (const target of options.paths) {
        walk (target, candidates);
    }
    const results: FileResult[] = [];
    const alreadyMigrated: string[] = [];
    for (const file of candidates) {
        let source: string;
        try {
            source = fs.readFileSync (file, 'utf8');
        } catch {
            continue;
        }
        if (!mentionsPmxt (source)) {
            continue;
        }
        if (source.indexOf ('TODO(ccxt-migrate)') !== -1) {
            alreadyMigrated.push (path.relative (process.cwd (), file) || file);
            continue;
        }
        const isPython = PY_EXT.indexOf (path.extname (file)) !== -1;
        const result = isPython ? transformPython (source) : transformTypeScript (source);
        if (!result.patch.changed) {
            continue;
        }
        results.push ({
            'path': path.relative (process.cwd (), file) || file,
            'language': isPython ? 'python' : 'typescript',
            'patch': result.patch,
            source,
            'code': result.code,
            'written': false,
        });
    }
    return { results, alreadyMigrated };
}

async function run (options: Options) {
    const { results, alreadyMigrated } = collect (options);
    if (alreadyMigrated.length) {
        console.log ('');
        console.log ('Skipped ' + alreadyMigrated.length + ' file(s) that already carry TODO(ccxt-migrate) markers:');
        for (const f of alreadyMigrated.slice (0, 10)) {
            console.log ('  ' + f);
        }
        console.log ('Resolve those markers rather than re-running the codemod over them.');
    }
    if (results.length === 0) {
        console.log (alreadyMigrated.length ? 'Nothing left to migrate.' : ('No pmxt usage found in ' + options.paths.join (', ') + '. Nothing to migrate.'));
        return;
    }

    const totalTodos = results.reduce ((n, r) => n + r.patch.todos.length, 0);
    const totalChanges = results.reduce ((n, r) => n + r.patch.changes.length, 0);
    const blockers = new Set<string> ();
    for (const r of results) {
        for (const u of r.patch.unsupported) {
            blockers.add (u.symbol);
        }
    }

    console.log ('');
    console.log ('ccxt-migrate ' + VERSION + ' — pmxt to CCXT');
    console.log ('');
    console.log ('  ' + results.length + ' file(s) use pmxt');
    console.log ('  ' + totalChanges + ' mechanical change(s) to apply');
    console.log ('  ' + totalTodos + ' TODO(ccxt-migrate) marker(s) for you to resolve');
    if (blockers.size) {
        console.log ('');
        console.log ('  ' + blockers.size + ' pmxt symbol(s) have NO CCXT equivalent and will not be rewritten:');
        for (const b of [ ...blockers ].sort ().slice (0, 10)) {
            console.log ('    - ' + b);
        }
        if (blockers.size > 10) {
            console.log ('    ...and ' + (blockers.size - 10) + ' more');
        }
    }
    console.log ('');
    for (const r of results) {
        console.log ('  ' + r.path + '  (' + r.patch.changes.length + ' changes, ' + r.patch.todos.length + ' todos)');
    }
    console.log ('');

    if (options.dryRun) {
        for (const r of results) {
            console.log (previewDiff (r.source, r.code, r.path));
            console.log ('');
        }
        console.log ('Dry run — nothing written.');
        return;
    }

    if (!options.yes) {
        const ok = await confirm ('Apply these changes in place? Commit or stash first. [y/N] ');
        if (!ok) {
            console.log ('Aborted. Re-run with --dry-run to preview, or --yes to skip this prompt.');
            return;
        }
    }

    for (const r of results) {
        fs.writeFileSync (r.path, r.code, 'utf8');
        r.written = true;
    }
    console.log ('Rewrote ' + results.length + ' file(s).');

    if (options.report) {
        fs.writeFileSync (options.report, renderReport (results, ccxtVersion ()), 'utf8');
        console.log ('Wrote ' + options.report + '.');
    }

    console.log ('');
    console.log ('Next:');
    for (const line of dependencyAdvice (results)) {
        console.log ('  ' + line);
    }
    console.log ('  grep -rn "TODO(ccxt-migrate)" .');
    if (blockers.size) {
        console.log ('');
        console.log ('  Read the "Not migrated" section of the report first — those call sites');
        console.log ('  are coverage gaps, not codemod limitations, and need a decision from you.');
    }
    console.log ('');
    console.log ('  Prefer to finish with an AI agent? npx ccxt-migrate@latest prompt');
    console.log ('');
}

async function main () {
    const { command, options } = parseArgs (process.argv.slice (2));
    if (command === 'help') {
        console.log (HELP);
    } else if (command === 'version') {
        console.log (VERSION);
    } else if (command === 'prompt') {
        console.log (AGENT_PROMPT);
    } else if (command === 'rules') {
        console.log (renderRules ());
    } else {
        await run (options);
    }
}

main ().catch ((e) => {
    console.error (e);
    process.exit (1);
});
