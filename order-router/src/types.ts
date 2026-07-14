export interface BookLevel {
    price: number;
    amount: number;
}

export interface CachedOrderBook {
    exchangeId: string;
    symbol: string;
    bids: BookLevel[];
    asks: BookLevel[];
    exchangeTimestamp: number | undefined;
    receivedAt: number;
    sequence: number;
}

export interface ExchangeHealth {
    exchangeId: string;
    connected: boolean;
    lastUpdateAt: number | undefined;
    updateCount: number;
    reconnectCount: number;
    lastError: string | undefined;
}

export interface RoutingQuote {
    exchangeId: string;
    side: 'buy' | 'sell';
    requestedAmount: number;
    filledAmount: number;
    averagePrice: number | undefined;
    effectivePriceWithFee: number | undefined;
    takerFeeRate: number;
    fullyFillable: boolean;
    bookAgeMs: number;
}

export interface RoutingResult {
    symbol: string;
    side: 'buy' | 'sell';
    amount: number;
    best: RoutingQuote | undefined;
    quotes: RoutingQuote[];
}
