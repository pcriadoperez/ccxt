// Typed WebSocket API demo — the `ccxt_pro::<Exchange>` wrappers expose each
// `watch_*` method with a native Rust return type (one decoded update per call)
// instead of the dynamic `Value`. This is the WS analog of `iexchange_demo`
// (REST).
//
// This demo actually connects and consumes a few live updates from public
// streams. No credentials, no private data.
//
// Build/run:
//   cargo run --bin ws_typed_demo --features ws
//   CCXT_EXCHANGE=kraken CCXT_SYMBOL=BTC/USD cargo run --bin ws_typed_demo --features ws
use std::time::Duration;

use ccxt::Value;
use ccxt_pro::{from_id, TypedExchange, TypedExchangeExt};

// Each watch_* resolves once per update, so a quiet market simply never
// returns. Every await is bounded so the demo always terminates.
const UPDATE_TIMEOUT: Duration = Duration::from_secs(30);
const UPDATES: usize = 3;

fn env_or(key: &str, default: &str) -> String {
    std::env::var(key).unwrap_or_else(|_| default.to_string())
}

#[tokio::main]
async fn main() {
    let id = env_or("CCXT_EXCHANGE", "binance");
    let symbol = env_or("CCXT_SYMBOL", "BTC/USDT");

    println!("=== ccxt_pro typed watch_* demo — {id} {symbol} ===\n");

    // ── A. pick the venue at runtime ─────────────────────────────────────────
    // `from_id` returns a boxed `TypedExchange`; the typed `watch_*` methods
    // come from `TypedExchangeExt`.
    let mut ex: Box<dyn TypedExchange> = match from_id(&id, None) {
        Some(e) => e,
        None => {
            eprintln!("unknown/unsupported WS exchange: {id}");
            std::process::exit(1);
        }
    };
    ex.load_markets(false).await;

    // ── B. watch_ticker -> Result<Ticker> ────────────────────────────────────
    println!("→ watch_ticker");
    for i in 1..=UPDATES {
        match tokio::time::timeout(UPDATE_TIMEOUT, ex.watch_ticker(&symbol, Value::Null)).await {
            Ok(Ok(t)) => println!("   #{i} last={:?} bid={:?} ask={:?}", t.last, t.bid, t.ask),
            Ok(Err(e)) => { eprintln!("   x [{}] {}", e.kind, e.message); break; }
            Err(_) => { eprintln!("   x no update within {UPDATE_TIMEOUT:?}"); break; }
        }
    }

    // ── C. watch_order_book -> Result<OrderBook> ─────────────────────────────
    // `limit` is best-effort: some venues only publish a full book, so expect
    // more levels than requested.
    println!("\n→ watch_order_book (limit 10)");
    for i in 1..=UPDATES {
        match tokio::time::timeout(UPDATE_TIMEOUT, ex.watch_order_book(&symbol, Some(10), Value::Null)).await {
            Ok(Ok(ob)) => println!("   #{i} bids={} asks={} top_bid={:?}",
                                   ob.bids.len(), ob.asks.len(), ob.bids.first()),
            Ok(Err(e)) => { eprintln!("   x [{}] {}", e.kind, e.message); break; }
            Err(_) => { eprintln!("   x no update within {UPDATE_TIMEOUT:?}"); break; }
        }
    }

    // ── D. watch_trades -> Result<Vec<Trade>> ────────────────────────────────
    // One update carries the batch of trades the venue published.
    println!("\n→ watch_trades");
    for i in 1..=UPDATES {
        match tokio::time::timeout(UPDATE_TIMEOUT, ex.watch_trades(&symbol, None, None, Value::Null)).await {
            Ok(Ok(tr)) => println!("   #{i} {} trade(s), first px={:?} amount={:?}",
                                   tr.len(),
                                   tr.first().and_then(|t| t.price),
                                   tr.first().and_then(|t| t.amount)),
            Ok(Err(e)) => { eprintln!("   x [{}] {}", e.kind, e.message); break; }
            Err(_) => { eprintln!("   x no update within {UPDATE_TIMEOUT:?}"); break; }
        }
    }

    println!("\ndone.");
}
