import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { homePage } from './views/home.js';

// The hero animation makes an argument with numbers: that fee-adjusting BEFORE comparing changes
// which venue wins. If those numbers drift out of agreement the animation quietly teaches the
// opposite of what the router does — which is worse than having no animation at all.

const HTML = homePage('/router', undefined);
const CSS = readFileSync(fileURLToPath(new URL('./public/styles.css', import.meta.url)), 'utf8');

function figures (): { name: string; raw: number; feePct: number; eff: number }[] {
    const rows = [...HTML.matchAll(
        /<span class="rt-venue">([a-z]+)<\/span>[\s\S]*?<span class="rt-raw">([\d,]+)<\/span>\s*<span class="rt-fee">\+([\d.]+)%<\/span>\s*<span class="rt-eff">([\d,]+)<\/span>/g)];
    return rows.map((m) => ({
        name: m[1]!,
        raw: Number(m[2]!.replace(/,/g, '')),
        feePct: Number(m[3]!),
        eff: Number(m[4]!.replace(/,/g, '')),
    }));
}

test('every fee-adjusted price on the hero is arithmetically correct', () => {
    const rows = figures();
    assert.equal(rows.length, 4, 'expected four venues in the animation');
    for (const r of rows) {
        assert.equal(Math.round(r.raw * (1 + r.feePct / 100)), r.eff,
            `${r.name}: ${r.raw} + ${r.feePct}% should be ${Math.round(r.raw * (1 + r.feePct / 100))}, page says ${r.eff}`);
    }
});

test('the venue with the cheapest raw price is NOT the cheapest after fees', () => {
    // This is the entire point of the animation. If it ever stops being true the illustration is
    // making the opposite argument to the product.
    const rows = figures();
    const cheapestRaw = [...rows].sort((a, b) => a.raw - b.raw)[0]!;
    const cheapestReal = [...rows].sort((a, b) => a.eff - b.eff)[0]!;
    assert.notEqual(cheapestRaw.name, cheapestReal.name,
        'the animation only teaches anything if fees change the winner');
    // And the reversal should be dramatic enough to see: the raw winner ends up last.
    const rankByEff = [...rows].sort((a, b) => a.eff - b.eff).map((r) => r.name);
    assert.equal(rankByEff[rankByEff.length - 1], cheapestRaw.name,
        'the cheapest raw venue should end up the most expensive real one');
});

test('the quoted saving matches the split it shows', () => {
    const rows = figures();
    const byEff = [...rows].sort((a, b) => a.eff - b.eff);
    // The fill widths in the CSS are what the bars actually render: 0.62 and 0.38.
    const split = 0.62 * byEff[0]!.eff + 0.38 * byEff[1]!.eff;
    const quotedPay = Number(/<span class="lbl">pay<\/span> ([\d,]+) USDT/.exec(HTML)![1]!.replace(/,/g, ''));
    assert.ok(Math.abs(split - quotedPay) < 1,
        `the quoted price ${quotedPay} should equal the split it draws (${split.toFixed(1)})`);

    const quotedBps = Number(/([\d.]+) bps better/.exec(HTML)![1]!);
    // Must stay inside the range actually measured for this router, or it is a claim we cannot back.
    assert.ok(quotedBps >= 0.19 && quotedBps <= 2.2,
        `${quotedBps} bps is outside the measured 0.19-2.2 bps band`);
});

test('the animation collapses to a readable final frame without motion', () => {
    // Motion is decoration; the argument has to survive prefers-reduced-motion, and the rows must
    // land in their fee-adjusted order rather than their raw one.
    const block = /@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?\n\}/.exec(CSS);
    assert.ok(block, 'a reduced-motion block must exist');
    assert.ok(/animation: none !important/.test(block[0]), 'animation must be disabled');
    assert.ok(/\.rt \.rt-eff[^}]*opacity: 1/.test(block[0]) || /rt-eff.*opacity: 1/.test(block[0]),
        'the fee-adjusted column must be visible when motion is off');
    assert.ok(/r-kucoin\s*\{\s*transform: translateY\(0\)/.test(block[0]),
        'the cheapest real venue must land first in the static frame');
});

test('the page drives to signup and states what the router is not', () => {
    assert.ok((HTML.match(/\/router\/signup/g) ?? []).length >= 3, 'the call to action should recur');
    assert.match(HTML, /never holds funds and never places trades/,
        'a trader asks this first; the homepage must answer it without being asked');
});
