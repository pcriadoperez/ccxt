// Global market events (one per real-world change), fanned out to subscribed rules by the engine.

export type EventType = 'listing' | 'delisting' | 'wallet' | 'status' | 'depeg' | 'bigmove' | 'macro' | 'exploit';

export interface MarketEvent {
    key: string; // natural key, used for dedupe
    type: EventType;
    venue?: string;
    symbol?: string;
    base?: string;
    code?: string;
    data: Record<string, any>;
    ts: number;
}

export type EventListener = (ev: MarketEvent) => void;

export class EventBus {
    private listeners: EventListener[] = [];

    on (fn: EventListener): void {
        this.listeners.push (fn);
    }

    emit (ev: MarketEvent): void {
        for (const fn of this.listeners) {
            try {
                fn (ev);
            } catch (e) {
                console.error ('[events] listener failed', e);
            }
        }
    }
}
