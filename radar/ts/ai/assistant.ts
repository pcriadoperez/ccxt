// AI assistant: plain language -> validated rule proposal (the user confirms before anything is saved),
// and market questions answered only from data the bot already holds. The model never writes to anything.

import type { Llm, ChatMessage } from './llm.js';
import { extractJson, LlmUnavailable } from './llm.js';
import { numberCheck } from './numbercheck.js';
import type { MarketState } from '../market/state.js';
import type { NewsDesk } from '../news.js';
import type { Store, DeliveryContext } from '../db.js';
import { parseSpec } from '../rules.js';
import type { RuleSpec } from '../rules.js';
import { fundingData, oiData, priceData, statusData, walletData, fundingView, priceView } from '../views.js';
import { DISCLAIMER, esc } from '../format.js';
import { CORE_VENUES } from '../config.js';
import { venueAlias } from '../parse.js';

export type AssistantReply =
    | { kind: 'proposal', spec: RuleSpec, mode: 'once' | 'repeat', assumptions: string[] }
    | { kind: 'answer', html: string }
    | { kind: 'clarify', html: string }
    | { kind: 'refusal', html: string }
    | { kind: 'unavailable', html: string };

const RULE_SCHEMA = `Rule JSON (pick one "kind"; numbers are plain numbers):
- {"kind":"price","base":"BTC","market":"spot"|"perp","venue":"median"|<venue>,"field":"last"|"mark","op":"above"|"below","value":100000}
- {"kind":"move","base":"SOL","market":"spot","venue":"median"|<venue>,"pct":5,"windowMin":240,"direction":"both"|"up"|"down"}
- {"kind":"funding","base":"ETH" or "*" for any top perp,"venues":[<venue>...] or [],"high":0.001,"low":-0.0005}   (8h-equivalent rate as a FRACTION: 0.001 = 0.1%; use null for no bound)
- {"kind":"fundinggap","base":"BTC","venues":[],"aprGap":0.2}   (annualized gap as a fraction)
- {"kind":"settle","base":"BTC","venues":[],"minutesBefore":15}
- {"kind":"oi","base":"BTC","venues":[],"pct":8,"windowMin":60}
- {"kind":"listing","venues":[],"markets":["spot","perp"],"removals":true,"bases":[]}
- {"kind":"wallet","code":"USDT","venues":[]}
- {"kind":"status","venues":[]}
- {"kind":"depeg","codes":["USDT","USDC"],"threshold":0.005}
Venues: ${CORE_VENUES.join (', ')}, upbit, bithumb, htx, cryptocom, bingx. Empty venues = all supported.
Defaults when the user is vague: "crazy/extreme funding" => high 0.001, low -0.0005; "big move" => pct 5, windowMin 240; price rules fire once; others repeat.`;

const INTENT_SYSTEM = `You are the intent parser of CCXT Radar, a free Telegram bot that sends crypto market alerts using the CCXT library.
Classify the user's message and reply with ONE JSON object only:
{"intent":"create_rule"|"question"|"advice"|"other",
 "rule": <rule JSON or null>, "mode": "once"|"repeat"|null,
 "assumptions": [short strings describing any default you chose],
 "question": {"assets":["BTC"],"venues":[],"topics":["price"|"funding"|"status"|"wallet"|"oi"|"listings"|"news"]} or null,
 "missing": "what is missing to create the rule, or null"}
- create_rule: the user wants to be notified/alerted/pinged about something.
- question: the user asks about current market data (prices, funding, status, deposits/withdrawals, open interest, listings, news).
- advice: the user asks whether to buy/sell/hold, what will happen, or for a prediction.
- other: anything else.
${RULE_SCHEMA}`;

const ANSWER_SYSTEM = `You are CCXT Radar's market assistant. Answer the user's question using ONLY the DATA JSON provided.
Rules:
- Copy numbers exactly as they appear in DATA (you may round to fewer decimals). Never invent, estimate or compute new numbers.
- If DATA does not contain the answer, say so plainly.
- Describe; never recommend buying, selling or holding, and never predict prices.
- Plain text, at most 6 short lines, no markdown tables, no headings.`;

const EXPLAIN_SYSTEM = `You explain why a crypto market alert may have fired, using ONLY the DATA JSON provided.
Write 2-4 short sentences in plain text. Mention which data points stand out (cross-venue differences, funding, open interest changes, matching headlines).
If nothing in DATA explains it, say the cause is unconfirmed. Copy numbers exactly from DATA. Never give trading advice or predictions.`;

const ADVICE_HTML = 'I can\'t tell you what to buy, sell or hold, or predict prices. I can show you the data: try <code>/p btc</code>, <code>/funding eth</code>, or ask "what is BTC funding across exchanges?". ' + DISCLAIMER;

export class Assistant {
    llm?: Llm;
    state: MarketState;
    store: Store;
    news: NewsDesk;

    constructor (llm: Llm | undefined, state: MarketState, store: Store, news: NewsDesk) {
        this.llm = llm;
        this.state = state;
        this.store = store;
        this.news = news;
    }

    get enabled (): boolean {
        return this.llm !== undefined;
    }

    async handle (chatId: number, text: string): Promise<AssistantReply> {
        if (!this.llm) {
            return { kind: 'unavailable', html: 'The AI assistant is not configured on this bot. Use commands like <code>/alert btc &gt; 100k</code> or /help.' };
        }
        let parsed: any;
        try {
            const raw = await this.llm.complete ([ { role: 'system', content: INTENT_SYSTEM }, { role: 'user', content: text.slice (0, 600) } ], { json: true, maxTokens: 500 });
            parsed = extractJson (raw);
            this.store.logAiTurn (chatId, String (parsed?.intent), true, JSON.stringify ({ text, parsed }));
        } catch (e) {
            this.store.logAiTurn (chatId, 'error', false, JSON.stringify ({ text, error: String (e) }));
            return this.unavailable (e);
        }
        const intent = String (parsed?.intent || 'other');
        if (intent === 'advice') {
            return { kind: 'refusal', html: ADVICE_HTML };
        }
        if (intent === 'create_rule') {
            return this.toProposal (parsed);
        }
        if (intent === 'question') {
            return this.answer (chatId, text, parsed?.question || {});
        }
        return { kind: 'clarify', html: 'I can set up alerts ("ping me if ETH funding on Bybit goes crazy") or answer market questions ("where is SOL cheapest right now?"). Type /help for commands.' };
    }

    private unavailable (e: unknown): AssistantReply {
        const busy = e instanceof LlmUnavailable;
        return { kind: 'unavailable', html: (busy ? 'The AI assistant is busy right now.' : 'I couldn\'t understand the AI\'s reply.') + ' Commands and buttons keep working: try <code>/alert btc &gt; 100k</code>, <code>/p eth</code> or /help.' };
    }

    toProposal (parsed: any): AssistantReply {
        if (!parsed?.rule) {
            const missing = parsed?.missing ? ' Missing: ' + esc (String (parsed.missing).slice (0, 120)) + '.' : '';
            return { kind: 'clarify', html: 'I need a bit more to create that alert.' + missing + ' For example: <code>btc &gt; 100k</code>, <code>sol 5% 4h</code>, <code>funding eth &gt; 0.1%</code>.' };
        }
        const rule = { ...parsed.rule };
        // Normalize venue names the model may have written in a different form.
        if (typeof rule.venue === 'string' && rule.venue !== 'median') {
            rule.venue = venueAlias (rule.venue) || rule.venue.toLowerCase ();
        }
        if (Array.isArray (rule.venues)) {
            rule.venues = rule.venues.map ((v: string) => venueAlias (String (v)) || String (v).toLowerCase ());
        }
        const r = parseSpec (rule);
        if (!r.ok) {
            return { kind: 'clarify', html: 'I couldn\'t turn that into a valid alert (' + esc (r.error) + '). Try rephrasing, or use <code>/alert</code> with the examples in /help.' };
        }
        const problem = this.validateAgainstMarkets (r.spec);
        if (problem) {
            return { kind: 'clarify', html: problem };
        }
        const mode = parsed.mode === 'once' || parsed.mode === 'repeat' ? parsed.mode : (r.spec.kind === 'price' ? 'once' : 'repeat');
        const assumptions = Array.isArray (parsed.assumptions) ? parsed.assumptions.map ((a: unknown) => String (a).slice (0, 140)).slice (0, 3) : [];
        return { kind: 'proposal', spec: r.spec, mode, assumptions };
    }

    // Reject rules on coins or venues we cannot see, before the user saves them.
    validateAgainstMarkets (spec: RuleSpec): string | undefined {
        const known = new Set ([ ...this.state.markets.keys () ]);
        const venues: string[] = 'venues' in spec ? spec.venues : ('venue' in spec && spec.venue !== 'median' ? [ spec.venue ] : []);
        for (const v of venues) {
            if (!known.has (v) && CORE_VENUES.indexOf (v) === -1) {
                return 'I don\'t follow <b>' + esc (v) + '</b>. Supported: ' + esc (CORE_VENUES.join (', ')) + '.';
            }
        }
        if (spec.kind === 'price' || spec.kind === 'move') {
            const found = spec.venue === 'median'
                ? this.state.medianPrice (spec.base) !== undefined || [ ...this.state.markets.keys () ].some ((v) => this.state.resolve (v, spec.base, spec.market) !== undefined)
                : this.state.resolve (spec.venue, spec.base, spec.market) !== undefined;
            if (!found && this.state.markets.size > 0) {
                return 'I couldn\'t find a <b>' + esc (spec.base) + '</b> ' + spec.market + ' market' + (spec.venue !== 'median' ? ' on ' + esc (spec.venue) : '') + '. Check the symbol.';
            }
        }
        if ((spec.kind === 'funding' && spec.base !== '*') || spec.kind === 'fundinggap' || spec.kind === 'settle' || spec.kind === 'oi') {
            const found = [ ...this.state.markets.keys () ].some ((v) => this.state.resolve (v, spec.base, 'perp') !== undefined);
            if (!found && this.state.markets.size > 0) {
                return 'I couldn\'t find a <b>' + esc (spec.base) + '</b> perpetual on the venues I follow.';
            }
        }
        return undefined;
    }

    gather (q: { assets?: string[], venues?: string[], topics?: string[] }): Record<string, unknown> {
        const assets = (q.assets || []).map ((a) => String (a).toUpperCase ().replace (/[^A-Z0-9]/g, '')).filter (Boolean).slice (0, 3);
        const venues = (q.venues || []).map ((v) => venueAlias (String (v)) || String (v).toLowerCase ()).filter ((v) => CORE_VENUES.indexOf (v) !== -1);
        const topics = new Set ((q.topics && q.topics.length ? q.topics : [ 'price' ]).map (String));
        const data: Record<string, unknown> = { timeUtc: new Date (this.state.now ()).toISOString ().slice (0, 16).replace ('T', ' '), notes: 'Prices are in each market\'s quote currency; priceUsd converts stablecoins to USD. Funding percentages are already in percent.' };
        for (const a of assets) {
            const entry: Record<string, unknown> = {};
            if (topics.has ('price')) {
                const p = priceData (this.state, a);
                entry.price = venues.length ? { ...p, venues: p.venues.filter ((r) => venues.indexOf (r.venue) !== -1) } : p;
            }
            if (topics.has ('funding')) {
                entry.funding = fundingData (this.state, a);
            }
            if (topics.has ('oi')) {
                entry.openInterest = oiData (this.state, a);
            }
            if (topics.has ('wallet')) {
                entry.depositsWithdrawals = walletData (this.state, a, venues.length ? venues : CORE_VENUES);
            }
            if (topics.has ('news')) {
                entry.headlines = this.news.about (a).slice (0, 5).map ((c) => ({ title: c.title, publishers: c.publishers }));
            }
            data[a] = entry;
        }
        if (topics.has ('status')) {
            data.exchangeStatus = statusData (this.state, venues.length ? venues : CORE_VENUES);
        }
        if (topics.has ('listings')) {
            data.recentListings = this.store.recentEvents ('listing', 86_400_000).slice (0, 15).map ((e) => ({ venue: e.payload.venue, symbol: e.payload.symbol }));
        }
        if (topics.has ('news') && assets.length === 0) {
            data.headlines = this.news.top (6).map ((c) => ({ title: c.title, publishers: c.publishers }));
        }
        return data;
    }

    // Deterministic fallback when the model's answer fails the number check.
    templated (q: { assets?: string[], topics?: string[] }): string {
        const assets = (q.assets || []).map ((a) => String (a).toUpperCase ()).slice (0, 2);
        const topics = new Set (q.topics && q.topics.length ? q.topics : [ 'price' ]);
        const parts: string[] = [];
        for (const a of assets) {
            if (topics.has ('funding')) {
                parts.push (fundingView (this.state, a));
            }
            if (topics.has ('price') || !topics.has ('funding')) {
                parts.push (priceView (this.state, a));
            }
        }
        return parts.length ? parts.join ('\n\n') : 'I don\'t have data for that yet.';
    }

    async answer (chatId: number, question: string, q: any): Promise<AssistantReply> {
        const data = this.gather (q);
        const msgs: ChatMessage[] = [
            { role: 'system', content: ANSWER_SYSTEM },
            { role: 'user', content: 'DATA:\n' + JSON.stringify (data) + '\n\nQUESTION: ' + question.slice (0, 600) },
        ];
        let text: string;
        try {
            text = (await this.llm!.complete (msgs, { maxTokens: 400 })).trim ();
        } catch (e) {
            return { kind: 'answer', html: this.templated (q) + '\n\n<i>AI unavailable; showing the data directly.</i>' };
        }
        const check = numberCheck (text, data);
        this.store.logAiTurn (chatId, 'answer', check.ok, JSON.stringify ({ question, text, offending: check.offending }));
        if (!check.ok) {
            return { kind: 'answer', html: this.templated (q) + '\n\n<i>Showing the data directly (the AI answer did not match it).</i>' };
        }
        return { kind: 'answer', html: esc (text) + '\n\n<i>Data via CCXT · ' + esc (String (data.timeUtc)) + ' UTC · ' + DISCLAIMER + '</i>' };
    }

    async explain (chatId: number, ctx: DeliveryContext): Promise<string> {
        const base = ctx.base || (ctx.symbol ? ctx.symbol.split ('/')[0] : undefined) || ctx.code;
        if (!base) {
            return 'Nothing to explain for this alert.';
        }
        const data = this.gather ({ assets: [ base ], topics: [ 'price', 'funding', 'oi', 'news' ] });
        (data as any).alert = ctx;
        if (!this.llm) {
            return this.templated ({ assets: [ base ], topics: [ 'price', 'funding' ] });
        }
        try {
            const text = (await this.llm.complete ([ { role: 'system', content: EXPLAIN_SYSTEM }, { role: 'user', content: 'DATA:\n' + JSON.stringify (data) } ], { maxTokens: 300 })).trim ();
            const check = numberCheck (text, data);
            this.store.logAiTurn (chatId, 'explain', check.ok, JSON.stringify ({ ctx, text, offending: check.offending }));
            if (!check.ok) {
                return this.templated ({ assets: [ base ], topics: [ 'price', 'funding' ] }) + '\n\n<i>Cause unconfirmed. Showing the data directly.</i>';
            }
            return '<b>Why might this be?</b>\n' + esc (text) + '\n\n<i>AI note from CCXT data and linked headlines. ' + DISCLAIMER + '</i>';
        } catch {
            return this.templated ({ assets: [ base ], topics: [ 'price', 'funding' ] }) + '\n\n<i>AI unavailable. Cause unconfirmed.</i>';
        }
    }

    // One-line neutral summaries for news clusters; numbers must appear in the source headline/description.
    async summarizeNews (clusters: Array<{ id: string, title: string, items: Array<{ title: string, description: string }> }>): Promise<Record<string, string>> {
        if (!this.llm) {
            return {};
        }
        const input = clusters.map ((c) => ({ id: c.id, headlines: c.items.slice (0, 3).map ((i) => i.title), description: c.items[0]?.description?.slice (0, 280) || '' }));
        const raw = await this.llm.complete ([
            { role: 'system', content: 'For each news item write one neutral sentence (max 18 words) summarizing the headlines. Use only facts in the input; copy any numbers exactly. Reply as JSON: {"summaries":{"<id>":"<sentence>"}}' },
            { role: 'user', content: JSON.stringify (input) },
        ], { json: true, maxTokens: 700 });
        const parsed = extractJson (raw);
        const out: Record<string, string> = {};
        for (const c of input) {
            const s = parsed?.summaries?.[c.id];
            if (typeof s === 'string' && s.length > 10 && s.length < 220 && numberCheck (s, c).ok) {
                out[c.id] = s.trim ();
            }
        }
        return out;
    }
}
