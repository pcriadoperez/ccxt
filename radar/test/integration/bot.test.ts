// End-to-end bot flows against a fake Telegram API: updates in, Bot API calls captured.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBot, alertKeyboard } from '../../ts/bot.js';
import { loadConfig } from '../../ts/config.js';
import { Store } from '../../ts/db.js';
import { EventBus } from '../../ts/events.js';
import { Engine } from '../../ts/engine.js';
import { Dispatcher } from '../../ts/delivery.js';
import { Assistant } from '../../ts/ai/assistant.js';
import type { Llm, ChatMessage } from '../../ts/ai/llm.js';
import { NewsDesk } from '../../ts/news.js';
import { MacroCalendar } from '../../ts/calendar.js';
import { makeState, setMajors } from '../helpers/fixtures.js';

const BOT_ID = 999;
const USER = { id: 100, is_bot: false, first_name: 'Tess', language_code: 'en' };

class ScriptedLlm implements Llm {
    replies: string[] = [];
    async complete (_m: ChatMessage[]): Promise<string> {
        const r = this.replies.shift ();
        if (!r) {
            throw new Error ('no reply scripted');
        }
        return r;
    }
}

function harness () {
    const cfg = loadConfig ({ RADAR_DB: ':memory:', RADAR_BOT_USERNAME: 'ccxt_radar_bot' } as any);
    const now = { t: Date.now () };
    const state = makeState (now);
    setMajors (state, now.t, 99_000, 3_000);
    for (const v of [ 'binance', 'okx', 'kraken', 'coinbase', 'hyperliquid' ]) {
        state.ok (v);
    }
    state.setFunding ('okx', new Map ([ [ 'ETH/USDT:USDT', { rate: 0.0001, intervalH: 8, intervalAssumed: false, ts: now.t } ] ]));
    const store = new Store (':memory:');
    const bus = new EventBus ();
    const calls: Array<{ method: string, payload: any }> = [];
    let msgId = 100;
    const dispatched: Array<{ chatId: number | string, html: string, markup: any }> = [];
    const dispatcher = new Dispatcher (store, async (chatId, html, markup) => {
        dispatched.push ({ chatId, html, markup });
        return { message_id: ++msgId };
    }, (did, a) => alertKeyboard (did, a));
    const engine = new Engine (store, state, bus, (a) => dispatcher.enqueue (a));
    const llm = new ScriptedLlm ();
    const news = new NewsDesk ();
    const assistant = new Assistant (llm, state, store, news);
    const failingExchange = () => ({ has: {}, fetchOHLCV: async () => {
        throw new Error ('offline');
    } });
    const bot = createBot ('123:TEST', { cfg, store, state, engine, assistant, news, calendar: new MacroCalendar (), getExchange: failingExchange }, {
        id: BOT_ID, is_bot: true, first_name: 'CCXT Radar', username: 'ccxt_radar_bot', can_join_groups: true, can_read_all_group_messages: false, supports_inline_queries: false, can_connect_to_business: false, has_main_web_app: false,
    } as any);
    bot.api.config.use (async (_prev, method, payload: any) => {
        calls.push ({ method, payload });
        let result: any = true;
        if (method === 'sendMessage') {
            result = { message_id: ++msgId, date: 0, chat: { id: payload.chat_id, type: 'private' }, text: payload.text };
        } else if (method === 'getChatMember') {
            result = { status: payload.user_id === 555 ? 'administrator' : 'member', user: { id: payload.user_id, is_bot: false, first_name: 'X' } };
        }
        return { ok: true, result } as any;
    });
    let updateId = 1;
    const chat = (id = USER.id, type = 'private') => (type === 'private' ? { id, type, first_name: 'Tess' } : { id, type, title: 'Group' });
    const send = async (text: string, opts: { chatId?: number, type?: string, from?: any, replyTo?: any } = {}) => {
        const entities = text.startsWith ('/') ? [ { type: 'bot_command', offset: 0, length: text.split (' ')[0].length } ] : undefined;
        await bot.handleUpdate ({ update_id: updateId++, message: { message_id: updateId, date: 0, chat: chat (opts.chatId, opts.type), from: opts.from || USER, text, entities, reply_to_message: opts.replyTo } } as any);
    };
    const press = async (data: string, opts: { chatId?: number, type?: string, from?: any, text?: string } = {}) => {
        await bot.handleUpdate ({ update_id: updateId++, callback_query: { id: String (updateId), from: opts.from || USER, chat_instance: 'x', data, message: { message_id: 5, date: 0, chat: chat (opts.chatId, opts.type), from: { id: BOT_ID, is_bot: true, first_name: 'Radar' }, text: opts.text || 'card' } } } as any);
    };
    const lastText = () => {
        const m = [ ...calls ].reverse ().find ((c) => c.method === 'sendMessage' || c.method === 'editMessageText');
        return m ? String (m.payload.text) : '';
    };
    const lastMarkup = () => {
        const m = [ ...calls ].reverse ().find ((c) => (c.method === 'sendMessage' || c.method === 'editMessageText') && c.payload.reply_markup);
        return m ? m.payload.reply_markup.inline_keyboard.flat () : [];
    };
    const button = (label: RegExp) => {
        const b = lastMarkup ().find ((x: any) => label.test (x.text));
        assert.ok (b, 'button ' + label + ' not found in ' + JSON.stringify (lastMarkup ().map ((x: any) => x.text)));
        return b.callback_data as string;
    };
    return { cfg, now, state, store, bus, engine, dispatcher, dispatched, llm, calls, send, press, lastText, lastMarkup, button };
}

test ('onboarding: persona → coins → loudness → timezone → brief creates move rules', async () => {
    const h = harness ();
    await h.send ('/start');
    assert.match (h.lastText (), /never ask for API keys/);
    await h.press (h.button (/Big moves on my coins/));
    assert.match (h.lastText (), /Pick coins/);
    await h.press ('ob:c:SOL');
    await h.press ('ob:c:BTC');
    assert.ok (h.lastMarkup ().some ((b: any) => b.text === '✓ SOL'));
    await h.press ('ob:c:done');
    await h.press (h.button (/Normal/));
    assert.match (h.lastText (), /What time is it for you now/);
    await h.press ('ob:t:60');
    assert.match (h.lastText (), /Timezone set to <b>Europe\/Madrid<\/b>/);
    await h.press ('ob:b:08:00');
    const rules = h.store.rulesForChat (USER.id);
    assert.deepEqual (rules.map ((r) => r.spec.kind === 'move' && r.spec.base).sort (), [ 'BTC', 'SOL' ]);
    const user = h.store.getUser (USER.id)!;
    assert.equal (user.briefTime, '08:00');
    assert.equal (user.tz, 'Europe/Madrid');
    assert.equal (user.quietStart, 23 * 60);
    assert.deepEqual (user.settings.watchlist, [ 'SOL', 'BTC' ]);
    assert.match (h.lastText (), /Done\.[\s\S]*SOL moves ±5% within 4h/);
});

test ('typing a shorthand alert shows a confirmation card; Save stores it', async () => {
    const h = harness ();
    await h.send ('/start');
    await h.send ('btc > 100k');
    const card = h.calls.filter ((c) => c.method === 'sendMessage').pop ()!;
    assert.match (card.payload.text, /Here's the alert I understood:<\/b>\nBTC rises above 100,000 · median of major venues/);
    assert.match (card.payload.text, /Now: <code>99,000<\/code> USD/);
    assert.equal (h.store.countRules (USER.id), 0, 'nothing saved before Save');
    await h.press (h.button (/^Save$/));
    assert.match (h.lastText (), /✓ <b>Saved:<\/b> BTC rises above 100,000/);
    assert.equal (h.store.countRules (USER.id), 1);
});

test ('an alert fires through engine + dispatcher, with Reproduce and Mute buttons', async () => {
    const h = harness ();
    await h.send ('/start');
    await h.send ('btc > 100k');
    await h.press (h.button (/^Save$/));
    h.engine.tick ();
    h.now.t += 10_000;
    setMajors (h.state, h.now.t, 100_250, 3_000);
    h.engine.tick ();
    await h.dispatcher.pump ();
    assert.equal (h.dispatched.length, 1);
    const sent = h.dispatched[0];
    assert.match (sent.html, /Price above 100,000 · BTC\/USD \(median\)/);
    const labels = sent.markup.inline_keyboard.flat ().map ((b: any) => b.text);
    assert.deepEqual (labels, [ 'Reproduce with CCXT', 'Why might this be?', 'Mute 4h', 'My alerts', 'Looks wrong' ]);
    const rp = sent.markup.inline_keyboard[0][0].callback_data;
    await h.press (rp);
    assert.match (h.lastText (), /<b>Reproduce with CCXT<\/b>\n<pre><code class="language-python">import ccxt\nex = ccxt\.coinbase\(\)/);
    await h.press (h.button (/^Go$/));
    assert.match (h.lastText (), /coinbase\.New\(\)/);
    await h.send ('/code');
    assert.match (h.lastText (), /Reproduce with CCXT/);
    const bad = sent.markup.inline_keyboard[1][2].callback_data;
    await h.press (bad);
    const answer = h.calls.filter ((c) => c.method === 'answerCallbackQuery').pop ()!;
    assert.match (answer.payload.text, /reported/);
});

test ('AI path: plain language → proposal card with assumptions and quota footer', async () => {
    const h = harness ();
    await h.send ('/start');
    h.llm.replies.push (JSON.stringify ({ intent: 'create_rule', rule: { kind: 'funding', base: 'ETH', venues: [ 'okx' ], high: 0.001, low: -0.0005 }, mode: 'repeat', assumptions: [ '"crazy" → above +0.10% or below −0.05% per 8h' ] }));
    await h.send ('ping me if eth funding on okx goes crazy');
    const card = h.calls.filter ((c) => c.method === 'sendMessage').pop ()!;
    assert.match (card.payload.text, /ETH perp funding \(8h-equiv\.\) above \+0\.100% or below −0\.050% · OKX/);
    assert.match (card.payload.text, /Now \(8h-eq\): OKX \+0\.010%/);
    assert.match (card.payload.text, /Assumed: "crazy"/);
    assert.match (card.payload.text, /AI 1\/3 today/, 'new users get 3 AI messages before their first rule');
    await h.press (h.button (/^Save$/));
    assert.equal (h.store.countRules (USER.id), 1);
});

test ('AI quota is enforced and commands keep working', async () => {
    const h = harness ();
    await h.send ('/start');
    for (let i = 0; i < 3; i++) {
        h.llm.replies.push (JSON.stringify ({ intent: 'other' }));
        await h.send ('hello there ' + i);
    }
    await h.send ('hello again');
    assert.match (h.lastText (), /used today's AI messages \(3\/3\)\. Save your first alert to unlock 20 a day/);
    await h.send ('/p btc');
    assert.match (h.lastText (), /<b>BTC<\/b> · median <code>99,000<\/code> USD/);
});

test ('/list shows rules with pause/delete buttons that work', async () => {
    const h = harness ();
    await h.send ('/start');
    await h.send ('sol 5% 4h');
    await h.press (h.button (/^Save$/));
    await h.send ('/list');
    assert.match (h.lastText (), /Your alerts<\/b> \(1\/30\)\n1\. SOL moves ±5% within 4h/);
    await h.press (h.button (/^⏸ 1$/), { text: 'Your alerts (1/30)' });
    assert.equal (h.store.rulesForChat (USER.id)[0].paused, true);
    await h.press (h.button (/^🗑 1$/), { text: 'Your alerts (1/30)' });
    assert.equal (h.store.countRules (USER.id), 0);
});

test ('settings commands: brief, quiet, budget, pause, breaking, forget', async () => {
    const h = harness ();
    await h.send ('/start');
    await h.send ('/brief 07:30');
    assert.equal (h.store.getUser (USER.id)!.briefTime, '07:30');
    await h.send ('/quiet 22-06');
    assert.equal (h.store.getUser (USER.id)!.quietStart, 22 * 60);
    await h.send ('/budget 20');
    assert.equal (h.store.getUser (USER.id)!.dailyBudget, 20);
    await h.send ('/pause 8h');
    assert.ok (h.store.getUser (USER.id)!.pausedUntil > Date.now () + 7 * 3_600_000);
    await h.send ('/resume');
    assert.equal (h.store.getUser (USER.id)!.pausedUntil, 0);
    await h.send ('/breaking');
    await h.press (h.button (/CPI \/ FOMC/));
    const br = h.store.rulesForChat (USER.id).find ((r) => r.spec.kind === 'breaking')!;
    assert.deepEqual ((br.spec as any).types, [ 'macro' ]);
    await h.send ('/brief now');
    assert.match (h.lastText (), /Daily Brief · /);
    await h.send ('/forget');
    await h.press ('fg:yes');
    assert.equal (h.store.getUser (USER.id), undefined);
});

test ('deep link opens a pre-filled card for returning users', async () => {
    const h = harness ();
    await h.send ('/start');
    await h.press ('ob:p:brief');
    await h.press ('ob:t:0');
    await h.press ('ob:b:off');
    await h.send ('/start funding_eth');
    assert.match (h.lastText (), /ETH perp funding/);
});

test ('groups: admin-only setup and alerts, /ask and replies go to the AI, members are throttled', async () => {
    const h = harness ();
    const G = -1001;
    const admin = { id: 555, is_bot: false, first_name: 'Admin' };
    const member = { id: 556, is_bot: false, first_name: 'Member' };
    await h.send ('/setup', { chatId: G, type: 'supergroup', from: member });
    assert.match (h.lastText (), /Only group admins/);
    await h.send ('/setup', { chatId: G, type: 'supergroup', from: { id: 1087968824, is_bot: true, first_name: 'Group' } });
    assert.match (h.lastText (), /can't verify anonymous admins/);
    await h.send ('/setup', { chatId: G, type: 'supergroup', from: admin });
    assert.match (h.lastText (), /Group setup/);
    await h.press ('gs:majors', { chatId: G, type: 'supergroup', from: admin });
    assert.equal (h.store.rulesForChat (G).length, 3);
    await h.press ('gs:majors', { chatId: G, type: 'supergroup', from: member });
    assert.equal (h.store.rulesForChat (G).length, 3, 'members cannot toggle presets');
    await h.send ('/alert btc > 100k', { chatId: G, type: 'supergroup', from: member });
    assert.match (h.lastText (), /Only group admins can add alerts/);
    h.llm.replies.push (JSON.stringify ({ intent: 'advice' }));
    await h.send ('/ask should i buy?', { chatId: 0 - 2002, type: 'supergroup', from: member });
    assert.match (h.lastText (), /can't tell you what to buy/);
    const before = h.calls.length;
    await h.send ('/p btc', { chatId: -2002, type: 'supergroup', from: member });
    assert.equal (h.calls.length, before, 'member throttled for 30s after /ask');
    const countBefore = h.calls.length;
    await h.send ('just chatting', { chatId: -3003, type: 'supergroup', from: member });
    assert.equal (h.calls.length, countBefore, 'ordinary group messages are ignored');
});
