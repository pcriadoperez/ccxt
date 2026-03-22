#!/usr/bin/env tsx
/**
 * Java Wrapper Generator for CCXT
 *
 * Reads TypeScript Exchange.ts via ast-transpiler to extract method signatures,
 * then generates ExchangeTyped.java with both sync and async typed methods.
 *
 * Usage: tsx build/generateJavaWrappers.ts
 */

import Transpiler from "ast-transpiler";
import * as fs from 'fs';

const TS_BASE_FILE = './ts/src/base/Exchange.ts';
const JAVA_OUTPUT_FILE = './java/lib/src/main/java/io/github/ccxt/ExchangeTyped.java';

// Known CCXT types that have Java equivalents in io.github.ccxt.types
const KNOWN_TYPES = new Set([
    'Ticker', 'Tickers', 'Trade', 'Order', 'OrderBook', 'OHLCV',
    'MarketInterface', 'Currencies', 'CurrencyInterface', 'Account', 'Balance', 'Balances',
    'Position', 'FundingRate', 'FundingRates', 'FundingRateHistory',
    'OpenInterest', 'OpenInterests', 'Liquidation',
    'LeverageTier', 'LeverageTiers', 'Leverage', 'Leverages',
    'MarginMode', 'MarginModes', 'MarginModification',
    'Transaction', 'DepositAddress', 'TransferEntry',
    'LedgerEntry', 'TradingFeeInterface', 'TradingFees',
    'Greeks', 'Option', 'OptionChain', 'Conversion',
    'LastPrice', 'LastPrices', 'LongShortRatio',
    'BorrowInterest', 'CrossBorrowRate', 'CrossBorrowRates',
    'IsolatedBorrowRate', 'IsolatedBorrowRates',
    'FundingHistory', 'DepositWithdrawFee',
    'OrderRequest', 'CancellationRequest', 'WithdrawalResponse',
]);

// --- Type helpers ---
function isStringType(t: string) { return t === 'Str' || t === 'string' || t === 'StringLiteral' || t === 'OrderSide' || t === 'OrderType' || t === 'MarketType'; }
function isNumberType(t: string) { return t === 'Num' || t === 'number' || t === 'NumericLiteral'; }
function isIntegerType(t: string) { return t !== undefined && t.toLowerCase() === 'int'; }
function isBooleanType(t: string) { return t === 'boolean' || t === 'Bool'; }
function isObjectType(t: string) { return t === 'any' || t === 'unknown' || t === 'Dict' || t === 'Object' || t === 'Dictionary<any>' || (t?.startsWith('{') && t?.endsWith('}')); }

function tsTypeToJavaType(tsType: string | undefined, isReturn = false): string {
    if (!tsType) return 'Object';
    if (isStringType(tsType)) return 'String';
    if (isIntegerType(tsType)) return 'Long';
    if (isNumberType(tsType)) return 'Double';
    if (isBooleanType(tsType)) return 'Boolean';
    if (tsType === 'Strings') return 'List<String>';
    if (isObjectType(tsType)) return isReturn ? 'Map<String, Object>' : 'Object';
    if (KNOWN_TYPES.has(tsType)) return tsType;
    return 'Object';
}

function tsReturnTypeToJava(methodName: string, tsReturnType: string): { javaType: string, isArray: boolean, elementType: string | null } | null {
    // Special cases
    if (methodName === 'fetchTime') return { javaType: 'Long', isArray: false, elementType: null };
    if (methodName.startsWith('watchOrderBook')) return { javaType: 'OrderBook', isArray: false, elementType: null };
    if (methodName === 'watchOHLCVForSymbols') return null; // complex nested type, skip

    const isPromise = tsReturnType.startsWith('Promise<') && tsReturnType.endsWith('>');
    let inner = isPromise ? tsReturnType.slice(8, -1) : tsReturnType;

    // Array type
    if (inner.endsWith('[]')) {
        const elem = inner.slice(0, -2);
        if (KNOWN_TYPES.has(elem)) return { javaType: `List<${elem}>`, isArray: true, elementType: elem };
        if (elem === 'string') return { javaType: 'List<String>', isArray: true, elementType: null };
        return null;
    }

    // Known type
    if (KNOWN_TYPES.has(inner)) return { javaType: inner, isArray: false, elementType: null };

    // Primitive
    if (isIntegerType(inner) || inner === 'number' && methodName === 'fetchTime') return { javaType: 'Long', isArray: false, elementType: null };
    if (isNumberType(inner)) return { javaType: 'Double', isArray: false, elementType: null };
    if (isStringType(inner)) return { javaType: 'String', isArray: false, elementType: null };
    if (isBooleanType(inner)) return { javaType: 'Boolean', isArray: false, elementType: null };

    // Dict/object - skip
    if (isObjectType(inner)) return null;
    if (inner === 'void') return null;
    if (inner.startsWith('Dictionary<')) return null;
    if (inner.startsWith('{')) return null;
    if (inner === 'string[][]') return null;

    return null;
}

// --- Allowed method filter (matches Go/C# transpiler logic) ---
const ALLOWED_PREFIXES = ['fetch', 'create', 'edit', 'cancel', 'setP', 'setM', 'setL', 'transfer', 'withdraw', 'watch', 'unWatch'];
const BLACKLIST = new Set([
    'fetch', 'fetchCurrenciesWs', 'fetchMarketsWs', 'setSandBoxMode', 'loadOrderBook',
    'loadMarketsHelper', 'createNetworksByIdObject', 'setMarketsFromExchange',
    'setProperty', 'setProxyAgents', 'watch', 'watchMultiple', 'watchMultipleSubscription',
    'watchPrivate', 'watchPublic', 'setPositionsCache', 'setPositionCache',
    'watchMany', 'watchMultiHelper', 'watchMultipleWrapper', 'watchMultiRequest',
    'watchMultiTicker', 'watchMultiTickerHelper', 'watchPrivateMultiple',
    'watchPrivateRequest', 'watchPrivateSubscribe', 'watchPublicMultiple',
    'watchSpotPrivate', 'watchSwapPrivate', 'watchSpotPublic', 'watchSwapPublic',
    'watchTopics', 'createContractOrder', 'createSpotOrder', 'createSwapOrder', 'createVault',
    'fetchPortfolioDetails', 'unWatch', 'unWatchChannel', 'unWatchMultiple',
    'unWatchPrivate', 'unWatchPublic', 'unWatchPublicMultiple', 'unWatchTopics',
]);

function shouldCreateWrapper(name: string): boolean {
    if (BLACKLIST.has(name)) return false;
    if (name.toLowerCase().includes('uta')) return false;
    if (name.includes('Snapshot') || name.includes('Subscription') || name.includes('Cache')) return false;
    return ALLOWED_PREFIXES.some(p => name.startsWith(p));
}

interface ParamInfo {
    name: string;
    javaType: string;
    isOptional: boolean;
    defaultValue: string | null;
}

interface MethodInfo {
    name: string;
    javaReturnType: string;
    isArray: boolean;
    elementType: string | null;
    requiredParams: ParamInfo[];
    optionalParams: ParamInfo[];
    isWatch: boolean;
}

function parseMethodsFromTS(): MethodInfo[] {
    const transpiler = new Transpiler({ verbose: false, csharp: { parser: { ELEMENT_ACCESS_WRAPPER_OPEN: "getValue(", ELEMENT_ACCESS_WRAPPER_CLOSE: ")" } } });
    const baseFile: any = transpiler.transpileJavaByPath(TS_BASE_FILE);
    const methodsTypes = baseFile.methodsTypes || [];

    const methods: MethodInfo[] = [];

    for (const m of methodsTypes) {
        if (!m.async) continue;
        if (!shouldCreateWrapper(m.name)) continue;

        const ret = tsReturnTypeToJava(m.name, m.returnType);
        if (!ret) continue;

        const requiredParams: ParamInfo[] = [];
        const optionalParams: ParamInfo[] = [];

        for (const p of m.parameters) {
            const isOptional = p.optional || p.initializer !== undefined;
            const isParams = p.name === 'params';
            const javaType = tsTypeToJavaType(p.type, false);

            if (isParams) {
                // params always goes last and is Map<String, Object>
                optionalParams.push({ name: 'params', javaType: 'Map<String, Object>', isOptional: true, defaultValue: 'null' });
            } else if (isOptional) {
                let defaultValue: string | null = null;
                if (p.initializer && p.initializer !== 'undefined' && p.initializer !== '{}') {
                    defaultValue = p.initializer.replace(/'/g, '"');
                }
                optionalParams.push({ name: safeName(p.name), javaType, isOptional: true, defaultValue });
            } else {
                requiredParams.push({ name: safeName(p.name), javaType, isOptional: false, defaultValue: null });
            }
        }

        // Ensure params is always present at the end
        if (!optionalParams.some(p => p.name === 'params')) {
            optionalParams.push({ name: 'params', javaType: 'Map<String, Object>', isOptional: true, defaultValue: 'null' });
        }

        methods.push({
            name: m.name,
            javaReturnType: ret.javaType,
            isArray: ret.isArray,
            elementType: ret.elementType,
            requiredParams,
            optionalParams,
            isWatch: m.name.startsWith('watch'),
        });
    }

    return methods;
}

function safeName(name: string): string {
    const reserved: Record<string, string> = { 'type': 'type', 'params': 'params' };
    return reserved[name] || name;
}

function camelCase(name: string): string {
    return name.charAt(0).toLowerCase() + name.slice(1);
}

function genReturnExpr(m: MethodInfo): string {
    if (m.isArray && m.elementType) return `toTypedList(res, ${m.elementType}::new)`;
    if (m.javaReturnType === 'Long') return '(res instanceof Number n) ? n.longValue() : null';
    if (m.javaReturnType === 'Double') return '(res instanceof Number n) ? n.doubleValue() : null';
    if (m.javaReturnType === 'String') return '(String) res';
    if (m.javaReturnType === 'Boolean') return '(Boolean) res';
    if (m.javaReturnType === 'Map<String, Object>') return '(Map<String, Object>) res';
    return `new ${m.javaReturnType}(res)`;
}

function genAsyncReturnExpr(m: MethodInfo): string {
    if (m.isArray && m.elementType) return `res -> toTypedList(res, ${m.elementType}::new)`;
    if (m.javaReturnType === 'Long') return 'res -> (res instanceof Number n) ? n.longValue() : null';
    if (m.javaReturnType === 'Double') return 'res -> (res instanceof Number n) ? n.doubleValue() : null';
    if (m.javaReturnType === 'String') return 'res -> (String) res';
    if (m.javaReturnType === 'Boolean') return 'res -> (Boolean) res';
    if (m.javaReturnType === 'Map<String, Object>') return 'res -> (Map<String, Object>) res';
    return `${m.javaReturnType}::new`;
}

function genMethod(m: MethodInfo): string {
    const methodName = camelCase(m.name);
    const allParams = [...m.requiredParams, ...m.optionalParams];
    const fullParamDecl = allParams.map(p => `${p.javaType} ${p.name}`).join(', ');
    const callArgs = allParams.map(p => p.name).join(', ');

    const lines: string[] = [];

    // Full sync method with all params
    lines.push(`    public ${m.javaReturnType} ${methodName}(${fullParamDecl}) {`);
    lines.push(`        Object res = exchange.${methodName}(${callArgs}).join();`);
    lines.push(`        return ${genReturnExpr(m)};`);
    lines.push(`    }`);

    // Convenience overload: required params only (optional params default to null)
    if (m.optionalParams.length > 0) {
        const reqDecl = m.requiredParams.map(p => `${p.javaType} ${p.name}`).join(', ');
        const reqArgs = m.requiredParams.map(p => p.name).join(', ');
        const defaults = m.optionalParams.map(p => {
            if (p.defaultValue && p.defaultValue !== 'null') return p.defaultValue;
            return 'null';
        }).join(', ');
        const sep = reqArgs ? ', ' : '';
        if (reqDecl) {
            lines.push(`    public ${m.javaReturnType} ${methodName}(${reqDecl}) { return ${methodName}(${reqArgs}${sep}${defaults}); }`);
        } else {
            lines.push(`    public ${m.javaReturnType} ${methodName}() { return ${methodName}(${defaults}); }`);
        }
    }

    // Async method (full params)
    if (!m.isWatch) {
        lines.push(`    public CompletableFuture<${m.javaReturnType}> ${methodName}Async(${fullParamDecl}) {`);
        lines.push(`        return exchange.${methodName}(${callArgs}).thenApply(${genAsyncReturnExpr(m)});`);
        lines.push(`    }`);
    }

    return lines.join('\n');
}

function categorize(name: string): string {
    if (/^fetch(Ticker|OrderBook|Trade|OHLCV|Market|Currenc|BidsAsks|MarkPrice|L2|Time)/.test(name)) return 'Market Data';
    if (/^(create|edit|cancel|fetchOrder|fetchOpen.*Order|fetchClosed|fetchCanceled|fetchMyTrade|fetchMyLiquid|fetchOrderTrade)/.test(name)) return 'Trading';
    if (/^(fetchBalance|fetchAccount|loadAccount)/.test(name)) return 'Account';
    if (/^(withdraw|transfer|fetchDeposit|fetchWithdraw|createDeposit|fetchTransaction)/.test(name)) return 'Funding';
    if (/^(fetchPosition|fetchFunding|fetchOpenInterest|fetchLeverage|setLeverage|setMargin|setPosition|fetchLong|fetchMarginAdj|fetchMarginMode|closePosition|closeAllPosition)/.test(name)) return 'Derivatives';
    if (/^fetchTrading(Fee)/.test(name)) return 'Fees';
    if (/^fetchLedger/.test(name)) return 'Ledger';
    if (/^(fetchBorrow|fetchCrossBorrow|fetchIsolatedBorrow)/.test(name)) return 'Borrow';
    if (/^watch/.test(name)) return 'WebSocket';
    return 'Other';
}

function generate(methods: MethodInfo[]): string {
    const cats: Record<string, MethodInfo[]> = {};
    for (const m of methods) {
        const cat = categorize(m.name);
        (cats[cat] = cats[cat] || []).push(m);
    }

    const sections: string[] = [];
    for (const [cat, ms] of Object.entries(cats)) {
        sections.push(`    // ==========================================`);
        sections.push(`    // ${cat}`);
        sections.push(`    // ==========================================\n`);
        for (const m of ms) {
            sections.push(genMethod(m));
            sections.push('');
        }
    }

    return `package io.github.ccxt;

import io.github.ccxt.types.*;

import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.stream.Collectors;

// PLEASE DO NOT EDIT THIS FILE, IT IS GENERATED AND WILL BE OVERWRITTEN:
// https://github.com/ccxt/ccxt/blob/master/CONTRIBUTING.md#how-to-contribute-code

@SuppressWarnings("unchecked")
public class ExchangeTyped {

    private final Exchange exchange;

    public ExchangeTyped(Exchange exchange) {
        this.exchange = exchange;
    }

    public Exchange getExchange() {
        return exchange;
    }

    private static <T> List<T> toTypedList(Object raw, java.util.function.Function<Object, T> ctor) {
        return ((List<Object>) raw).stream().map(ctor).collect(Collectors.toList());
    }

    // --- LoadMarkets (special: first arg is Boolean reload, not params) ---
    public Map<String, MarketInterface> loadMarkets(boolean reload) {
        Object res = exchange.loadMarkets(reload).join();
        java.util.LinkedHashMap<String, MarketInterface> result = new java.util.LinkedHashMap<>();
        for (Map.Entry<String, Object> entry : ((Map<String, Object>) res).entrySet()) {
            result.put(entry.getKey(), new MarketInterface(entry.getValue()));
        }
        return result;
    }
    public Map<String, MarketInterface> loadMarkets() { return loadMarkets(false); }
    public CompletableFuture<Map<String, MarketInterface>> loadMarketsAsync(boolean reload) {
        return exchange.loadMarkets(reload).thenApply(res -> {
            java.util.LinkedHashMap<String, MarketInterface> result = new java.util.LinkedHashMap<>();
            for (Map.Entry<String, Object> entry : ((Map<String, Object>) res).entrySet()) {
                result.put(entry.getKey(), new MarketInterface(entry.getValue()));
            }
            return result;
        });
    }
    public CompletableFuture<Map<String, MarketInterface>> loadMarketsAsync() { return loadMarketsAsync(false); }

${sections.join('\n')}
}
`;
}

// --- Main ---
console.log('Parsing TypeScript Exchange.ts...');
const methods = parseMethodsFromTS();
const restCount = methods.filter(m => !m.isWatch).length;
const wsCount = methods.filter(m => m.isWatch).length;
console.log(`Found ${methods.length} methods (REST: ${restCount}, WS: ${wsCount})`);

// Show a few examples with params
for (const m of methods.slice(0, 5)) {
    const allParams = [...m.requiredParams, ...m.optionalParams];
    console.log(`  ${m.name}(${allParams.map(p => `${p.javaType} ${p.name}${p.isOptional ? '?' : ''}`).join(', ')}) -> ${m.javaReturnType}`);
}

const output = generate(methods);
fs.writeFileSync(JAVA_OUTPUT_FILE, output, 'utf-8');
console.log(`Generated ${JAVA_OUTPUT_FILE} (${output.split('\n').length} lines)`);
