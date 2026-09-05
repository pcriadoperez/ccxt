import { EventEmitter } from 'node:events';

// Taker fees, keyed by (exchange, symbol). Populated directly by ExchangeConnector in
// single-process mode, or relayed over IPC from shard workers in sharded mode — either way the
// API layer reads from one shared instance without needing to reach into per-connector state
// (which isn't possible once connectors live in a different process).
export class FeeRegistry extends EventEmitter {
    private fees = new Map<string, number>();

    constructor () {
        super();
        this.setMaxListeners(0);
    }

    private key (exchangeId: string, symbol: string): string {
        return `${exchangeId}:${symbol}`;
    }

    setFee (exchangeId: string, symbol: string, takerFeeRate: number): void {
        this.fees.set(this.key(exchangeId, symbol), takerFeeRate);
        this.emit('fee', { exchangeId, symbol, takerFeeRate });
    }

    getFee (exchangeId: string, symbol: string, fallback = 0.001): number {
        return this.fees.get(this.key(exchangeId, symbol)) ?? fallback;
    }
}
