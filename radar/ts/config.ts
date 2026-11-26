// Runtime configuration, read once from the environment.

export const CORE_VENUES = [ 'binance', 'bybit', 'okx', 'coinbase', 'kraken', 'bitget', 'gate', 'kucoin', 'hyperliquid', 'mexc' ];
export const LISTING_ONLY_VENUES = [ 'upbit', 'bithumb', 'htx', 'cryptocom', 'bingx' ];
// Venues whose spot side is the only thing we ingest (no perps, or perps not useful for alerts).
export const SPOT_ONLY_VENUES = new Set ([ 'coinbase', 'kraken', 'upbit', 'bithumb' ]);
// Venues used for the "median" price shown in briefs and median-based move rules.
export const MEDIAN_VENUES = [ 'binance', 'coinbase', 'kraken', 'okx', 'bybit' ];
export const MAJORS = [ 'BTC', 'ETH', 'SOL', 'XRP', 'DOGE', 'BNB' ];
export const STABLECOINS = [ 'USDT', 'USDC', 'USDE', 'DAI' ];

function list (value: string | undefined, fallback: string[]): string[] {
    if (!value) {
        return fallback;
    }
    return value.split (',').map ((s) => s.trim ().toLowerCase ()).filter ((s) => s.length > 0);
}

function int (value: string | undefined, fallback: number): number {
    const n = value === undefined ? NaN : Number (value);
    return Number.isFinite (n) ? n : fallback;
}

export interface ExchangeCredentials {
    apiKey?: string;
    secret?: string;
    password?: string;
}

export interface Config {
    telegramToken: string | undefined;
    botUsername: string;
    dbPath: string;
    venues: string[];
    listingVenues: string[];
    intervals: {
        tickersMs: number;
        fundingMs: number;
        openInterestMs: number;
        currenciesMs: number;
        statusMs: number;
        marketsCoreMs: number;
        marketsListingMs: number;
        engineMs: number;
        newsMs: number;
    };
    ai: {
        apiKey: string | undefined;
        model: string;
        baseUrl: string;
        dailyPerUser: number;
        newUserAllowance: number;
        dailyGlobalRequests: number;
    };
    limits: {
        maxRulesPerUser: number;
        defaultDailyBudget: number;
        maxDailyBudget: number;
        globalMessagesPerSecond: number;
        groupMessagesPerMinute: number;
        groupMemberCooldownMs: number;
    };
    channels: {
        listings?: string;
        movers?: string;
        funding?: string;
        status?: string;
        brief?: string;
    };
    adminIds: number[];
    credentials: Record<string, ExchangeCredentials>;
}

export function loadConfig (env: NodeJS.ProcessEnv = process.env): Config {
    const venues = list (env.RADAR_VENUES, CORE_VENUES);
    const listingVenues = list (env.RADAR_LISTING_VENUES, [ ...venues, ...LISTING_ONLY_VENUES ]);
    const credentials: Record<string, ExchangeCredentials> = {};
    for (const id of new Set ([ ...venues, ...listingVenues ])) {
        const prefix = id.toUpperCase ();
        const apiKey = env[prefix + '_APIKEY'];
        const secret = env[prefix + '_SECRET'];
        if (apiKey && secret) {
            credentials[id] = { apiKey, secret, password: env[prefix + '_PASSWORD'] };
        }
    }
    return {
        telegramToken: env.TELEGRAM_BOT_TOKEN,
        botUsername: env.RADAR_BOT_USERNAME || 'ccxt_radar_bot',
        dbPath: env.RADAR_DB || 'data/radar.sqlite',
        venues,
        listingVenues,
        intervals: {
            tickersMs: int (env.RADAR_TICKERS_MS, 10_000),
            fundingMs: int (env.RADAR_FUNDING_MS, 60_000),
            openInterestMs: int (env.RADAR_OI_MS, 60_000),
            currenciesMs: int (env.RADAR_CURRENCIES_MS, 300_000),
            statusMs: int (env.RADAR_STATUS_MS, 60_000),
            marketsCoreMs: int (env.RADAR_MARKETS_CORE_MS, 90_000),
            marketsListingMs: int (env.RADAR_MARKETS_LISTING_MS, 180_000),
            engineMs: int (env.RADAR_ENGINE_MS, 5_000),
            newsMs: int (env.RADAR_NEWS_MS, 30 * 60_000),
        },
        ai: {
            apiKey: env.OPENROUTER_API_KEY,
            model: env.OPENROUTER_MODEL || 'openrouter/free',
            baseUrl: env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1',
            dailyPerUser: int (env.RADAR_AI_DAILY, 20),
            newUserAllowance: int (env.RADAR_AI_NEW_USER, 3),
            dailyGlobalRequests: int (env.RADAR_AI_GLOBAL_DAILY, 2000),
        },
        limits: {
            maxRulesPerUser: int (env.RADAR_MAX_RULES, 30),
            defaultDailyBudget: int (env.RADAR_DAILY_BUDGET, 10),
            maxDailyBudget: 50,
            globalMessagesPerSecond: int (env.RADAR_MSG_PER_SEC, 25),
            groupMessagesPerMinute: 20,
            groupMemberCooldownMs: 30_000,
        },
        channels: {
            listings: env.RADAR_CHANNEL_LISTINGS,
            movers: env.RADAR_CHANNEL_MOVERS,
            funding: env.RADAR_CHANNEL_FUNDING,
            status: env.RADAR_CHANNEL_STATUS,
            brief: env.RADAR_CHANNEL_BRIEF,
        },
        adminIds: list (env.RADAR_ADMIN_IDS, []).map (Number).filter (Number.isFinite),
        credentials,
    };
}
