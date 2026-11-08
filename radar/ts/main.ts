// CCXT Radar entry point: wires ingestion, engine, delivery, news, AI and the Telegram bot.
// Without TELEGRAM_BOT_TOKEN it runs headless and prints alerts to the console (useful for testing data).

import { loadConfig } from './config.js';
import { Store } from './db.js';
import { EventBus } from './events.js';
import { MarketState } from './market/state.js';
import { Ingestor } from './market/ingest.js';
import { Engine } from './engine.js';
import { Dispatcher } from './delivery.js';
import type { SendFn } from './delivery.js';
import { NewsDesk } from './news.js';
import { MacroCalendar } from './calendar.js';
import { OpenRouterClient } from './ai/llm.js';
import { Assistant } from './ai/assistant.js';
import { Channels } from './channels.js';
import { Scheduler } from './scheduler.js';
import { createBot, alertKeyboard, BOT_COMMANDS, GROUP_COMMANDS } from './bot.js';

async function main (): Promise<void> {
    try {
        process.loadEnvFile ('.env'); // optional: settings can also come from the real environment
    } catch {
        // no .env file
    }
    const cfg = loadConfig ();
    const store = new Store (cfg.dbPath);
    const state = new MarketState ();
    const bus = new EventBus ();
    const ingestor = new Ingestor (cfg, state, bus, store);
    const news = new NewsDesk (bus);
    const calendar = new MacroCalendar ();
    const llm = cfg.ai.apiKey ? new OpenRouterClient (cfg.ai.apiKey, cfg.ai.model, cfg.ai.baseUrl, cfg.ai.dailyGlobalRequests) : undefined;
    const assistant = new Assistant (llm, state, store, news);
    news.summarizer = (clusters) => assistant.summarizeNews (clusters);

    let send: SendFn;
    let bot: ReturnType<typeof createBot> | undefined;
    if (cfg.telegramToken) {
        // created below; the dispatcher only calls send after start
        send = async (chatId, html, markup) => bot!.api.sendMessage (chatId, html, { parse_mode: 'HTML', link_preview_options: { is_disabled: true }, reply_markup: markup as any });
    } else {
        let n = 0;
        send = async (chatId, html) => {
            console.log ('\n[alert → ' + chatId + ']\n' + html.replace (/<[^>]+>/g, ''));
            return { message_id: ++n };
        };
    }
    const dispatcher = new Dispatcher (store, send, (did, alert) => alertKeyboard (did, alert), cfg.limits.globalMessagesPerSecond);
    const engine = new Engine (store, state, bus, (a) => dispatcher.enqueue (a));
    engine.onWatchChange = (perpBases, codes) => {
        ingestor.extraPerpBases = perpBases;
        ingestor.trackedWalletCodes = codes;
    };
    const channels = new Channels (cfg, bus, dispatcher, state);
    const scheduler = new Scheduler ({ cfg, store, state, news, calendar, dispatcher, bus, channels });

    console.log ('[radar] venues: ' + cfg.venues.join (', ') + ' · listing venues: ' + cfg.listingVenues.join (', '));
    console.log ('[radar] AI: ' + (llm ? 'OpenRouter ' + cfg.ai.model : 'off (set OPENROUTER_API_KEY)') + ' · db: ' + cfg.dbPath);
    ingestor.start ();
    const engineTimer = setInterval (() => engine.tick (), cfg.intervals.engineMs);
    dispatcher.start ();
    scheduler.start ();
    void news.refresh ().catch ((e) => console.error ('[news]', e));
    const newsTimer = setInterval (() => void news.refresh ().catch ((e) => console.error ('[news]', e)), cfg.intervals.newsMs);
    void calendar.refresh ();
    const calTimer = setInterval (() => void calendar.refresh (), 12 * 3_600_000);

    if (cfg.telegramToken) {
        bot = createBot (cfg.telegramToken, { cfg, store, state, engine, assistant, news, calendar, getExchange: (id) => ingestor.exchange (id) });
        await bot.api.setMyCommands (BOT_COMMANDS).catch ((e) => console.error ('[bot] setMyCommands', e?.description || e));
        await bot.api.setMyCommands (GROUP_COMMANDS, { scope: { type: 'all_group_chats' } }).catch (() => undefined);
        void bot.start ({
            allowed_updates: [ 'message', 'callback_query', 'my_chat_member' ],
            onStart: (me) => console.log ('[radar] bot @' + me.username + ' is running. Open https://t.me/' + me.username + ' and send /start'),
        });
    } else {
        console.log ('[radar] TELEGRAM_BOT_TOKEN not set: running headless, alerts print here.');
    }

    const statusTimer = setInterval (() => {
        const ok = cfg.venues.filter ((v) => !state.isDegraded (v));
        console.log ('[radar] venues ok ' + ok.length + '/' + cfg.venues.length + ' (' + ok.join (',') + ') · queue ' + dispatcher.pending () + ' · sent ' + dispatcher.stats.sent + ' · news ' + news.clusters.length);
    }, 60_000);

    const shutdown = async () => {
        console.log ('[radar] shutting down');
        clearInterval (engineTimer);
        clearInterval (newsTimer);
        clearInterval (calTimer);
        clearInterval (statusTimer);
        scheduler.stop ();
        ingestor.stop ();
        dispatcher.stop ();
        if (bot) {
            await bot.stop ();
        }
        store.close ();
        process.exit (0);
    };
    process.once ('SIGINT', shutdown);
    process.once ('SIGTERM', shutdown);
}

main ().catch ((e) => {
    console.error (e);
    process.exit (1);
});
