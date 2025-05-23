'use strict';

var bitfinex1$1 = require('./abstract/bitfinex1.js');
var errors = require('./base/errors.js');
var Precise = require('./base/Precise.js');
var number = require('./base/functions/number.js');
var sha512 = require('./static_dependencies/noble-hashes/sha512.js');

// ----------------------------------------------------------------------------
//  ---------------------------------------------------------------------------
/**
 * @class bitfinex1
 * @augments Exchange
 */
class bitfinex1 extends bitfinex1$1 {
    describe() {
        return this.deepExtend(super.describe(), {
            'id': 'bitfinex1',
            'name': 'Bitfinex',
            'countries': ['VG'],
            'version': 'v1',
            // cheapest is 90 requests a minute = 1.5 requests per second on average => ( 1000ms / 1.5) = 666.666 ms between requests on average
            'rateLimit': 666.666,
            'pro': true,
            // new metainfo interface
            'has': {
                'CORS': undefined,
                'spot': true,
                'margin': undefined,
                'swap': undefined,
                'future': undefined,
                'option': undefined,
                'cancelAllOrders': true,
                'cancelOrder': true,
                'createDepositAddress': true,
                'createOrder': true,
                'editOrder': true,
                'fetchBalance': true,
                'fetchClosedOrders': true,
                'fetchDepositAddress': true,
                'fetchDepositAddresses': false,
                'fetchDepositAddressesByNetwork': false,
                'fetchDeposits': false,
                'fetchDepositsWithdrawals': true,
                'fetchDepositWithdrawFee': 'emulated',
                'fetchDepositWithdrawFees': true,
                'fetchFundingHistory': false,
                'fetchFundingRate': false,
                'fetchFundingRateHistory': false,
                'fetchFundingRates': false,
                'fetchIndexOHLCV': false,
                'fetchLeverageTiers': false,
                'fetchMarginMode': false,
                'fetchMarkets': true,
                'fetchMarkOHLCV': false,
                'fetchMyTrades': true,
                'fetchOHLCV': true,
                'fetchOpenOrders': true,
                'fetchOrder': true,
                'fetchOrderBook': true,
                'fetchPositionMode': false,
                'fetchPositions': true,
                'fetchPremiumIndexOHLCV': false,
                'fetchTicker': true,
                'fetchTickers': true,
                'fetchTime': false,
                'fetchTrades': true,
                'fetchTradingFee': false,
                'fetchTradingFees': true,
                'fetchTransactionFees': true,
                'fetchTransactions': 'emulated',
                'transfer': true,
                'withdraw': true,
            },
            'timeframes': {
                '1m': '1m',
                '5m': '5m',
                '15m': '15m',
                '30m': '30m',
                '1h': '1h',
                '3h': '3h',
                '4h': '4h',
                '6h': '6h',
                '12h': '12h',
                '1d': '1D',
                '1w': '7D',
                '2w': '14D',
                '1M': '1M',
            },
            'urls': {
                'logo': 'https://github.com/user-attachments/assets/9147c6c5-7197-481e-827b-7483672bb0e9',
                'api': {
                    'v2': 'https://api-pub.bitfinex.com',
                    'public': 'https://api.bitfinex.com',
                    'private': 'https://api.bitfinex.com',
                },
                'www': 'https://www.bitfinex.com',
                'referral': 'https://www.bitfinex.com/?refcode=P61eYxFL',
                'doc': [
                    'https://docs.bitfinex.com/v1/docs',
                    'https://github.com/bitfinexcom/bitfinex-api-node',
                ],
            },
            'api': {
                // v2 symbol ids require a 't' prefix
                // just the public part of it (use bitfinex2 for everything else)
                'v2': {
                    'get': {
                        'platform/status': 3,
                        'tickers': 1,
                        'ticker/{symbol}': 1,
                        'tickers/hist': 1,
                        'trades/{symbol}/hist': 1,
                        'book/{symbol}/{precision}': 0.375,
                        'book/{symbol}/P0': 0.375,
                        'book/{symbol}/P1': 0.375,
                        'book/{symbol}/P2': 0.375,
                        'book/{symbol}/P3': 0.375,
                        'book/{symbol}/R0': 0.375,
                        'stats1/{key}:{size}:{symbol}:{side}/{section}': 1,
                        'stats1/{key}:{size}:{symbol}/{section}': 1,
                        'stats1/{key}:{size}:{symbol}:long/last': 1,
                        'stats1/{key}:{size}:{symbol}:long/hist': 1,
                        'stats1/{key}:{size}:{symbol}:short/last': 1,
                        'stats1/{key}:{size}:{symbol}:short/hist': 1,
                        'candles/trade:{timeframe}:{symbol}/{section}': 1,
                        'candles/trade:{timeframe}:{symbol}/last': 1,
                        'candles/trade:{timeframe}:{symbol}/hist': 1,
                    },
                },
                'public': {
                    'get': {
                        'book/{symbol}': 1,
                        // 'candles/{symbol}':0,
                        'lendbook/{currency}': 6,
                        'lends/{currency}': 3,
                        'pubticker/{symbol}': 3,
                        'stats/{symbol}': 6,
                        'symbols': 18,
                        'symbols_details': 18,
                        'tickers': 1,
                        'trades/{symbol}': 3, // 60 requests a minute = 1 request per second => (1000ms / rateLimit) / 1 = 1.5 ... but only works if set to 3
                    },
                },
                'private': {
                    'post': {
                        'account_fees': 18,
                        'account_infos': 6,
                        'balances': 9.036,
                        'basket_manage': 6,
                        'credits': 6,
                        'deposit/new': 18,
                        'funding/close': 6,
                        'history': 6,
                        'history/movements': 6,
                        'key_info': 6,
                        'margin_infos': 3,
                        'mytrades': 3,
                        'mytrades_funding': 6,
                        'offer/cancel': 6,
                        'offer/new': 6,
                        'offer/status': 6,
                        'offers': 6,
                        'offers/hist': 90.03,
                        'order/cancel': 0.2,
                        'order/cancel/all': 0.2,
                        'order/cancel/multi': 0.2,
                        'order/cancel/replace': 0.2,
                        'order/new': 0.2,
                        'order/new/multi': 0.2,
                        'order/status': 0.2,
                        'orders': 0.2,
                        'orders/hist': 90.03,
                        'position/claim': 18,
                        'position/close': 18,
                        'positions': 18,
                        'summary': 18,
                        'taken_funds': 6,
                        'total_taken_funds': 6,
                        'transfer': 18,
                        'unused_taken_funds': 6,
                        'withdraw': 18,
                    },
                },
            },
            'fees': {
                'trading': {
                    'feeSide': 'get',
                    'tierBased': true,
                    'percentage': true,
                    'maker': this.parseNumber('0.001'),
                    'taker': this.parseNumber('0.002'),
                    'tiers': {
                        'taker': [
                            [this.parseNumber('0'), this.parseNumber('0.002')],
                            [this.parseNumber('500000'), this.parseNumber('0.002')],
                            [this.parseNumber('1000000'), this.parseNumber('0.002')],
                            [this.parseNumber('2500000'), this.parseNumber('0.002')],
                            [this.parseNumber('5000000'), this.parseNumber('0.002')],
                            [this.parseNumber('7500000'), this.parseNumber('0.002')],
                            [this.parseNumber('10000000'), this.parseNumber('0.0018')],
                            [this.parseNumber('15000000'), this.parseNumber('0.0016')],
                            [this.parseNumber('20000000'), this.parseNumber('0.0014')],
                            [this.parseNumber('25000000'), this.parseNumber('0.0012')],
                            [this.parseNumber('30000000'), this.parseNumber('0.001')],
                        ],
                        'maker': [
                            [this.parseNumber('0'), this.parseNumber('0.001')],
                            [this.parseNumber('500000'), this.parseNumber('0.0008')],
                            [this.parseNumber('1000000'), this.parseNumber('0.0006')],
                            [this.parseNumber('2500000'), this.parseNumber('0.0004')],
                            [this.parseNumber('5000000'), this.parseNumber('0.0002')],
                            [this.parseNumber('7500000'), this.parseNumber('0')],
                            [this.parseNumber('10000000'), this.parseNumber('0')],
                            [this.parseNumber('15000000'), this.parseNumber('0')],
                            [this.parseNumber('20000000'), this.parseNumber('0')],
                            [this.parseNumber('25000000'), this.parseNumber('0')],
                            [this.parseNumber('30000000'), this.parseNumber('0')],
                        ],
                    },
                },
                'funding': {
                    'tierBased': false,
                    'percentage': false,
                    // Actually deposit fees are free for larger deposits (> $1000 USD equivalent)
                    // these values below are deprecated, we should not hardcode fees and limits anymore
                    // to be reimplemented with bitfinex funding fees from their API or web endpoints
                    'deposit': {},
                    'withdraw': {},
                },
            },
            // todo rewrite for https://api-pub.bitfinex.com//v2/conf/pub:map:tx:method
            'commonCurrencies': {
                'ALG': 'ALGO',
                'AMP': 'AMPL',
                'ATO': 'ATOM',
                'BCHABC': 'XEC',
                'BCHN': 'BCH',
                'DAT': 'DATA',
                'DOG': 'MDOGE',
                'DSH': 'DASH',
                // https://github.com/ccxt/ccxt/issues/7399
                // https://coinmarketcap.com/currencies/pnetwork/
                // https://en.cryptonomist.ch/blog/eidoo/the-edo-to-pnt-upgrade-what-you-need-to-know-updated/
                'EDO': 'PNT',
                'EUS': 'EURS',
                'EUT': 'EURT',
                'IDX': 'ID',
                'IOT': 'IOTA',
                'IQX': 'IQ',
                'LUNA': 'LUNC',
                'LUNA2': 'LUNA',
                'MNA': 'MANA',
                'ORS': 'ORS Group',
                'PAS': 'PASS',
                'QSH': 'QASH',
                'QTM': 'QTUM',
                'RBT': 'RBTC',
                'SNG': 'SNGLS',
                'STJ': 'STORJ',
                'TERRAUST': 'USTC',
                'TSD': 'TUSD',
                'YGG': 'YEED',
                'YYW': 'YOYOW',
                'UDC': 'USDC',
                'UST': 'USDT',
                'VSY': 'VSYS',
                'WAX': 'WAXP',
                'XCH': 'XCHF',
                'ZBT': 'ZB',
            },
            'exceptions': {
                'exact': {
                    'temporarily_unavailable': errors.ExchangeNotAvailable,
                    'Order could not be cancelled.': errors.OrderNotFound,
                    'No such order found.': errors.OrderNotFound,
                    'Order price must be positive.': errors.InvalidOrder,
                    'Could not find a key matching the given X-BFX-APIKEY.': errors.AuthenticationError,
                    'Key price should be a decimal number, e.g. "123.456"': errors.InvalidOrder,
                    'Key amount should be a decimal number, e.g. "123.456"': errors.InvalidOrder,
                    'ERR_RATE_LIMIT': errors.RateLimitExceeded,
                    'Ratelimit': errors.RateLimitExceeded,
                    'Nonce is too small.': errors.InvalidNonce,
                    'No summary found.': errors.ExchangeError,
                    'Cannot evaluate your available balance, please try again': errors.ExchangeNotAvailable,
                    'Unknown symbol': errors.BadSymbol,
                    'Cannot complete transfer. Exchange balance insufficient.': errors.InsufficientFunds,
                    'Momentary balance check. Please wait few seconds and try the transfer again.': errors.ExchangeError,
                },
                'broad': {
                    'Invalid X-BFX-SIGNATURE': errors.AuthenticationError,
                    'This API key does not have permission': errors.PermissionDenied,
                    'not enough exchange balance for ': errors.InsufficientFunds,
                    'minimum size for ': errors.InvalidOrder,
                    'Invalid order': errors.InvalidOrder,
                    'The available balance is only': errors.InsufficientFunds, // {"status":"error","message":"Cannot withdraw 1.0027 ETH from your exchange wallet. The available balance is only 0.0 ETH. If you have limit orders, open positions, unused or active margin funding, this will decrease your available balance. To increase it, you can cancel limit orders or reduce/close your positions.","withdrawal_id":0,"fees":"0.0027"}
                },
            },
            'precisionMode': number.SIGNIFICANT_DIGITS,
            'options': {
                'currencyNames': {
                    'AGI': 'agi',
                    'AID': 'aid',
                    'AIO': 'aio',
                    'ANT': 'ant',
                    'AVT': 'aventus',
                    'BAT': 'bat',
                    // https://github.com/ccxt/ccxt/issues/5833
                    'BCH': 'bab',
                    // 'BCH': 'bcash', // undocumented
                    'BCI': 'bci',
                    'BFT': 'bft',
                    'BSV': 'bsv',
                    'BTC': 'bitcoin',
                    'BTG': 'bgold',
                    'CFI': 'cfi',
                    'COMP': 'comp',
                    'DAI': 'dai',
                    'DADI': 'dad',
                    'DASH': 'dash',
                    'DATA': 'datacoin',
                    'DTH': 'dth',
                    'EDO': 'eidoo',
                    'ELF': 'elf',
                    'EOS': 'eos',
                    'ETC': 'ethereumc',
                    'ETH': 'ethereum',
                    'ETP': 'metaverse',
                    'FUN': 'fun',
                    'GNT': 'golem',
                    'IOST': 'ios',
                    'IOTA': 'iota',
                    // https://github.com/ccxt/ccxt/issues/5833
                    'LEO': 'let',
                    // 'LEO': 'les', // EOS chain
                    'LINK': 'link',
                    'LRC': 'lrc',
                    'LTC': 'litecoin',
                    'LYM': 'lym',
                    'MANA': 'mna',
                    'MIT': 'mit',
                    'MKR': 'mkr',
                    'MTN': 'mtn',
                    'NEO': 'neo',
                    'ODE': 'ode',
                    'OMG': 'omisego',
                    'OMNI': 'mastercoin',
                    'QASH': 'qash',
                    'QTUM': 'qtum',
                    'RCN': 'rcn',
                    'RDN': 'rdn',
                    'REP': 'rep',
                    'REQ': 'req',
                    'RLC': 'rlc',
                    'SAN': 'santiment',
                    'SNGLS': 'sng',
                    'SNT': 'status',
                    'SPANK': 'spk',
                    'STORJ': 'stj',
                    'TNB': 'tnb',
                    'TRX': 'trx',
                    'TUSD': 'tsd',
                    'USD': 'wire',
                    'USDC': 'udc',
                    'UTK': 'utk',
                    'USDT': 'tetheruso',
                    // 'USDT': 'tetheruse', // Tether on ERC20
                    // 'USDT': 'tetherusl', // Tether on Liquid
                    // 'USDT': 'tetherusx', // Tether on Tron
                    // 'USDT': 'tetheruss', // Tether on EOS
                    'VEE': 'vee',
                    'WAX': 'wax',
                    'XLM': 'xlm',
                    'XMR': 'monero',
                    'XRP': 'ripple',
                    'XVG': 'xvg',
                    'YOYOW': 'yoyow',
                    'ZEC': 'zcash',
                    'ZRX': 'zrx',
                    'XTZ': 'xtz',
                },
                'orderTypes': {
                    'limit': 'exchange limit',
                    'market': 'exchange market',
                },
                'fiat': {
                    'USD': 'USD',
                    'EUR': 'EUR',
                    'JPY': 'JPY',
                    'GBP': 'GBP',
                    'CNH': 'CNH',
                },
                'accountsByType': {
                    'spot': 'exchange',
                    'margin': 'trading',
                    'funding': 'deposit',
                    'swap': 'trading',
                },
            },
        });
    }
    /**
     * @method
     * @name bitfinex1#fetchTransactionFees
     * @deprecated
     * @description please use fetchDepositWithdrawFees instead
     * @see https://docs.bitfinex.com/v1/reference/rest-auth-fees
     * @param {string[]|undefined} codes list of unified currency codes
     * @param {object} [params] extra parameters specific to the exchange API endpoint
     * @returns {object[]} a list of [fees structures]{@link https://docs.ccxt.com/#/?id=fee-structure}
     */
    async fetchTransactionFees(codes = undefined, params = {}) {
        await this.loadMarkets();
        const result = {};
        const response = await this.privatePostAccountFees(params);
        //
        // {
        //     "withdraw": {
        //         "BTC": "0.0004",
        //     }
        // }
        //
        const fees = this.safeDict(response, 'withdraw', {});
        const ids = Object.keys(fees);
        for (let i = 0; i < ids.length; i++) {
            const id = ids[i];
            const code = this.safeCurrencyCode(id);
            if ((codes !== undefined) && !this.inArray(code, codes)) {
                continue;
            }
            result[code] = {
                'withdraw': this.safeNumber(fees, id),
                'deposit': {},
                'info': this.safeNumber(fees, id),
            };
        }
        return result;
    }
    /**
     * @method
     * @name bitfinex1#fetchDepositWithdrawFees
     * @description fetch deposit and withdraw fees
     * @see https://docs.bitfinex.com/v1/reference/rest-auth-fees
     * @param {string[]|undefined} codes list of unified currency codes
     * @param {object} [params] extra parameters specific to the exchange API endpoint
     * @returns {object[]} a list of [fees structures]{@link https://docs.ccxt.com/#/?id=fee-structure}
     */
    async fetchDepositWithdrawFees(codes = undefined, params = {}) {
        await this.loadMarkets();
        const response = await this.privatePostAccountFees(params);
        //
        //    {
        //        "withdraw": {
        //            "BTC": "0.0004",
        //            ...
        //        }
        //    }
        //
        const withdraw = this.safeList(response, 'withdraw');
        return this.parseDepositWithdrawFees(withdraw, codes);
    }
    parseDepositWithdrawFee(fee, currency = undefined) {
        //
        //    '0.0004'
        //
        return {
            'withdraw': {
                'fee': this.parseNumber(fee),
                'percentage': undefined,
            },
            'deposit': {
                'fee': undefined,
                'percentage': undefined,
            },
            'networks': {},
            'info': fee,
        };
    }
    /**
     * @method
     * @name bitfinex1#fetchTradingFees
     * @description fetch the trading fees for multiple markets
     * @see https://docs.bitfinex.com/v1/reference/rest-auth-summary
     * @param {object} [params] extra parameters specific to the exchange API endpoint
     * @returns {object} a dictionary of [fee structures]{@link https://docs.ccxt.com/#/?id=fee-structure} indexed by market symbols
     */
    async fetchTradingFees(params = {}) {
        await this.loadMarkets();
        const response = await this.privatePostSummary(params);
        //
        //     {
        //          "time": "2022-02-23T16:05:47.659000Z",
        //          "status": { resid_hint: null, login_last: "2022-02-23T16:05:48Z" },
        //          "is_locked": false,
        //          "leo_lev": "0",
        //          "leo_amount_avg": "0.0",
        //          "trade_vol_30d": [
        //          {
        //              "curr": "Total (USD)",
        //              "vol": "0.0",
        //              "vol_safe": "0.0",
        //              "vol_maker": "0.0",
        //              "vol_BFX": "0.0",
        //              "vol_BFX_safe": "0.0",
        //              "vol_BFX_maker": "0.0"
        //          }
        //          ],
        //          "fees_funding_30d": {},
        //          "fees_funding_total_30d": "0",
        //          "fees_trading_30d": {},
        //          "fees_trading_total_30d": "0",
        //          "rebates_trading_30d": {},
        //          "rebates_trading_total_30d": "0",
        //          "maker_fee": "0.001",
        //          "taker_fee": "0.002",
        //          "maker_fee_2crypto": "0.001",
        //          "maker_fee_2stablecoin": "0.001",
        //          "maker_fee_2fiat": "0.001",
        //          "maker_fee_2deriv": "0.0002",
        //          "taker_fee_2crypto": "0.002",
        //          "taker_fee_2stablecoin": "0.002",
        //          "taker_fee_2fiat": "0.002",
        //          "taker_fee_2deriv": "0.00065",
        //          "deriv_maker_rebate": "0.0002",
        //          "deriv_taker_fee": "0.00065",
        //          "trade_last": null
        //     }
        //
        const result = {};
        const fiat = this.safeDict(this.options, 'fiat', {});
        const makerFee = this.safeNumber(response, 'maker_fee');
        const takerFee = this.safeNumber(response, 'taker_fee');
        const makerFee2Fiat = this.safeNumber(response, 'maker_fee_2fiat');
        const takerFee2Fiat = this.safeNumber(response, 'taker_fee_2fiat');
        const makerFee2Deriv = this.safeNumber(response, 'maker_fee_2deriv');
        const takerFee2Deriv = this.safeNumber(response, 'taker_fee_2deriv');
        for (let i = 0; i < this.symbols.length; i++) {
            const symbol = this.symbols[i];
            const market = this.market(symbol);
            const fee = {
                'info': response,
                'symbol': symbol,
                'percentage': true,
                'tierBased': true,
            };
            if (market['quote'] in fiat) {
                fee['maker'] = makerFee2Fiat;
                fee['taker'] = takerFee2Fiat;
            }
            else if (market['contract']) {
                fee['maker'] = makerFee2Deriv;
                fee['taker'] = takerFee2Deriv;
            }
            else {
                fee['maker'] = makerFee;
                fee['taker'] = takerFee;
            }
            result[symbol] = fee;
        }
        return result;
    }
    /**
     * @method
     * @name bitfinex1#fetchMarkets
     * @description retrieves data on all markets for bitfinex
     * @see https://docs.bitfinex.com/v1/reference/rest-public-symbols
     * @see https://docs.bitfinex.com/v1/reference/rest-public-symbol-details
     * @param {object} [params] extra parameters specific to the exchange API endpoint
     * @returns {object[]} an array of objects representing market data
     */
    async fetchMarkets(params = {}) {
        const idsPromise = this.publicGetSymbols();
        //
        //     [ "btcusd", "ltcusd", "ltcbtc" ]
        //
        const detailsPromise = this.publicGetSymbolsDetails();
        //
        //     [
        //         {
        //             "pair":"btcusd",
        //             "price_precision":5,
        //             "initial_margin":"10.0",
        //             "minimum_margin":"5.0",
        //             "maximum_order_size":"2000.0",
        //             "minimum_order_size":"0.0002",
        //             "expiration":"NA",
        //             "margin":true
        //         },
        //     ]
        //
        const [ids, details] = await Promise.all([idsPromise, detailsPromise]);
        const result = [];
        for (let i = 0; i < details.length; i++) {
            const market = details[i];
            let id = this.safeString(market, 'pair');
            if (!this.inArray(id, ids)) {
                continue;
            }
            id = id.toUpperCase();
            let baseId = undefined;
            let quoteId = undefined;
            if (id.indexOf(':') >= 0) {
                const parts = id.split(':');
                baseId = parts[0];
                quoteId = parts[1];
            }
            else {
                baseId = id.slice(0, 3);
                quoteId = id.slice(3, 6);
            }
            const base = this.safeCurrencyCode(baseId);
            const quote = this.safeCurrencyCode(quoteId);
            const symbol = base + '/' + quote;
            let type = 'spot';
            if (id.indexOf('F0') > -1) {
                type = 'swap';
            }
            result.push({
                'id': id,
                'symbol': symbol,
                'base': base,
                'quote': quote,
                'settle': undefined,
                'baseId': baseId,
                'quoteId': quoteId,
                'settleId': undefined,
                'type': type,
                'spot': (type === 'spot'),
                'margin': this.safeBool(market, 'margin'),
                'swap': (type === 'swap'),
                'future': false,
                'option': false,
                'active': true,
                'contract': (type === 'swap'),
                'linear': undefined,
                'inverse': undefined,
                'contractSize': undefined,
                'expiry': undefined,
                'expiryDatetime': undefined,
                'strike': undefined,
                'optionType': undefined,
                'precision': {
                    // https://docs.bitfinex.com/docs/introduction#amount-precision
                    // The amount field allows up to 8 decimals.
                    // Anything exceeding this will be rounded to the 8th decimal.
                    'amount': parseInt('8'),
                    'price': this.safeInteger(market, 'price_precision'),
                },
                'limits': {
                    'leverage': {
                        'min': undefined,
                        'max': undefined,
                    },
                    'amount': {
                        'min': this.safeNumber(market, 'minimum_order_size'),
                        'max': this.safeNumber(market, 'maximum_order_size'),
                    },
                    'price': {
                        'min': this.parseNumber('1e-8'),
                        'max': undefined,
                    },
                    'cost': {
                        'min': undefined,
                        'max': undefined,
                    },
                },
                'created': undefined,
                'info': market,
            });
        }
        return result;
    }
    amountToPrecision(symbol, amount) {
        // https://docs.bitfinex.com/docs/introduction#amount-precision
        // The amount field allows up to 8 decimals.
        // Anything exceeding this will be rounded to the 8th decimal.
        symbol = this.safeSymbol(symbol);
        return this.decimalToPrecision(amount, number.TRUNCATE, this.markets[symbol]['precision']['amount'], number.DECIMAL_PLACES);
    }
    priceToPrecision(symbol, price) {
        symbol = this.safeSymbol(symbol);
        price = this.decimalToPrecision(price, number.ROUND, this.markets[symbol]['precision']['price'], this.precisionMode);
        // https://docs.bitfinex.com/docs/introduction#price-precision
        // The precision level of all trading prices is based on significant figures.
        // All pairs on Bitfinex use up to 5 significant digits and up to 8 decimals (e.g. 1.2345, 123.45, 1234.5, 0.00012345).
        // Prices submit with a precision larger than 5 will be cut by the API.
        return this.decimalToPrecision(price, number.TRUNCATE, 8, number.DECIMAL_PLACES);
    }
    /**
     * @method
     * @name bitfinex1#fetchBalance
     * @description query for balance and get the amount of funds available for trading or funds locked in orders
     * @see https://docs.bitfinex.com/v1/reference/rest-auth-wallet-balances
     * @param {object} [params] extra parameters specific to the exchange API endpoint
     * @returns {object} a [balance structure]{@link https://docs.ccxt.com/#/?id=balance-structure}
     */
    async fetchBalance(params = {}) {
        await this.loadMarkets();
        const accountsByType = this.safeDict(this.options, 'accountsByType', {});
        const requestedType = this.safeString(params, 'type', 'exchange');
        const accountType = this.safeString(accountsByType, requestedType, requestedType);
        if (accountType === undefined) {
            const keys = Object.keys(accountsByType);
            throw new errors.ExchangeError(this.id + ' fetchBalance() type parameter must be one of ' + keys.join(', '));
        }
        const query = this.omit(params, 'type');
        const response = await this.privatePostBalances(query);
        //    [ { type: "deposit",
        //        "currency": "btc",
        //        "amount": "0.00116721",
        //        "available": "0.00116721" },
        //      { type: "exchange",
        //        "currency": "ust",
        //        "amount": "0.0000002",
        //        "available": "0.0000002" },
        //      { type: "trading",
        //        "currency": "btc",
        //        "amount": "0.0005",
        //        "available": "0.0005" } ],
        const result = { 'info': response };
        const isDerivative = requestedType === 'derivatives';
        for (let i = 0; i < response.length; i++) {
            const balance = response[i];
            const type = this.safeString(balance, 'type');
            const currencyId = this.safeStringLower(balance, 'currency', '');
            const start = currencyId.length - 2;
            const isDerivativeCode = currencyId.slice(start) === 'f0';
            // this will only filter the derivative codes if the requestedType is 'derivatives'
            const derivativeCondition = (!isDerivative || isDerivativeCode);
            if ((accountType === type) && derivativeCondition) {
                const code = this.safeCurrencyCode(currencyId);
                // bitfinex had BCH previously, now it's BAB, but the old
                // BCH symbol is kept for backward-compatibility
                // we need a workaround here so that the old BCH balance
                // would not override the new BAB balance (BAB is unified to BCH)
                // https://github.com/ccxt/ccxt/issues/4989
                if (!(code in result)) {
                    const account = this.account();
                    account['free'] = this.safeString(balance, 'available');
                    account['total'] = this.safeString(balance, 'amount');
                    result[code] = account;
                }
            }
        }
        return this.safeBalance(result);
    }
    /**
     * @method
     * @name bitfinex1#transfer
     * @description transfer currency internally between wallets on the same account
     * @see https://docs.bitfinex.com/v1/reference/rest-auth-transfer-between-wallets
     * @param {string} code unified currency code
     * @param {float} amount amount to transfer
     * @param {string} fromAccount account to transfer from
     * @param {string} toAccount account to transfer to
     * @param {object} [params] extra parameters specific to the exchange API endpoint
     * @returns {object} a [transfer structure]{@link https://docs.ccxt.com/#/?id=transfer-structure}
     */
    async transfer(code, amount, fromAccount, toAccount, params = {}) {
        // transferring between derivatives wallet and regular wallet is not documented in their API
        // however we support it in CCXT (from just looking at web inspector)
        await this.loadMarkets();
        const accountsByType = this.safeDict(this.options, 'accountsByType', {});
        const fromId = this.safeString(accountsByType, fromAccount, fromAccount);
        const toId = this.safeString(accountsByType, toAccount, toAccount);
        const currency = this.currency(code);
        const fromCurrencyId = this.convertDerivativesId(currency['id'], fromAccount);
        const toCurrencyId = this.convertDerivativesId(currency['id'], toAccount);
        const requestedAmount = this.currencyToPrecision(code, amount);
        const request = {
            'amount': requestedAmount,
            'currency': fromCurrencyId,
            'currency_to': toCurrencyId,
            'walletfrom': fromId,
            'walletto': toId,
        };
        const response = await this.privatePostTransfer(this.extend(request, params));
        //
        //     [
        //         {
        //             "status": "success",
        //             "message": "0.0001 Bitcoin transfered from Margin to Exchange"
        //         }
        //     ]
        //
        const result = this.safeValue(response, 0);
        const message = this.safeString(result, 'message');
        if (message === undefined) {
            throw new errors.ExchangeError(this.id + ' transfer failed');
        }
        return this.extend(this.parseTransfer(result, currency), {
            'fromAccount': fromAccount,
            'toAccount': toAccount,
            'amount': this.parseNumber(requestedAmount),
        });
    }
    parseTransfer(transfer, currency = undefined) {
        //
        //     {
        //         "status": "success",
        //         "message": "0.0001 Bitcoin transfered from Margin to Exchange"
        //     }
        //
        return {
            'info': transfer,
            'id': undefined,
            'timestamp': undefined,
            'datetime': undefined,
            'currency': this.safeCurrencyCode(undefined, currency),
            'amount': undefined,
            'fromAccount': undefined,
            'toAccount': undefined,
            'status': this.parseTransferStatus(this.safeString(transfer, 'status')),
        };
    }
    parseTransferStatus(status) {
        const statuses = {
            'SUCCESS': 'ok',
        };
        return this.safeString(statuses, status, status);
    }
    convertDerivativesId(currencyId, type) {
        const start = currencyId.length - 2;
        const isDerivativeCode = currencyId.slice(start) === 'F0';
        if ((type !== 'derivatives' && type !== 'trading' && type !== 'margin') && isDerivativeCode) {
            currencyId = currencyId.slice(0, start);
        }
        else if (type === 'derivatives' && !isDerivativeCode) {
            currencyId = currencyId + 'F0';
        }
        return currencyId;
    }
    /**
     * @method
     * @name bitfinex1#fetchOrderBook
     * @description fetches information on open orders with bid (buy) and ask (sell) prices, volumes and other data
     * @see https://docs.bitfinex.com/v1/reference/rest-public-orderbook
     * @param {string} symbol unified symbol of the market to fetch the order book for
     * @param {int} [limit] the maximum amount of order book entries to return
     * @param {object} [params] extra parameters specific to the exchange API endpoint
     * @returns {object} A dictionary of [order book structures]{@link https://docs.ccxt.com/#/?id=order-book-structure} indexed by market symbols
     */
    async fetchOrderBook(symbol, limit = undefined, params = {}) {
        await this.loadMarkets();
        const market = this.market(symbol);
        const request = {
            'symbol': market['id'],
        };
        if (limit !== undefined) {
            request['limit_bids'] = limit;
            request['limit_asks'] = limit;
        }
        const response = await this.publicGetBookSymbol(this.extend(request, params));
        return this.parseOrderBook(response, market['symbol'], undefined, 'bids', 'asks', 'price', 'amount');
    }
    /**
     * @method
     * @name bitfinex1#fetchTickers
     * @description fetches price tickers for multiple markets, statistical information calculated over the past 24 hours for each market
     * @param {string[]} [symbols] unified symbols of the markets to fetch the ticker for, all market tickers are returned if not assigned
     * @param {object} [params] extra parameters specific to the exchange API endpoint
     * @returns {object} a dictionary of [ticker structures]{@link https://docs.ccxt.com/#/?id=ticker-structure}
     */
    async fetchTickers(symbols = undefined, params = {}) {
        await this.loadMarkets();
        symbols = this.marketSymbols(symbols);
        const response = await this.publicGetTickers(params);
        const result = {};
        for (let i = 0; i < response.length; i++) {
            const ticker = this.parseTicker(response[i]);
            const symbol = ticker['symbol'];
            result[symbol] = ticker;
        }
        return this.filterByArrayTickers(result, 'symbol', symbols);
    }
    /**
     * @method
     * @name bitfinex1#fetchTicker
     * @description fetches a price ticker, a statistical calculation with the information calculated over the past 24 hours for a specific market
     * @see https://docs.bitfinex.com/v1/reference/rest-public-ticker
     * @param {string} symbol unified symbol of the market to fetch the ticker for
     * @param {object} [params] extra parameters specific to the exchange API endpoint
     * @returns {object} a [ticker structure]{@link https://docs.ccxt.com/#/?id=ticker-structure}
     */
    async fetchTicker(symbol, params = {}) {
        await this.loadMarkets();
        const market = this.market(symbol);
        const request = {
            'symbol': market['id'],
        };
        const ticker = await this.publicGetPubtickerSymbol(this.extend(request, params));
        //
        //    {
        //        mid: '63560.5',
        //        bid: '63560.0',
        //        ask: '63561.0',
        //        last_price: '63547.0',
        //        low: '62812.0',
        //        high: '64480.0',
        //        volume: '517.25634977',
        //        timestamp: '1715102384.9849467'
        //    }
        //
        return this.parseTicker(ticker, market);
    }
    parseTicker(ticker, market = undefined) {
        //
        //    {
        //        mid: '63560.5',
        //        bid: '63560.0',
        //        ask: '63561.0',
        //        last_price: '63547.0',
        //        low: '62812.0',
        //        high: '64480.0',
        //        volume: '517.25634977',
        //        timestamp: '1715102384.9849467'
        //    }
        //
        const timestamp = this.safeTimestamp(ticker, 'timestamp');
        const marketId = this.safeString(ticker, 'pair');
        market = this.safeMarket(marketId, market);
        const symbol = market['symbol'];
        const last = this.safeString(ticker, 'last_price');
        return this.safeTicker({
            'symbol': symbol,
            'timestamp': timestamp,
            'datetime': this.iso8601(timestamp),
            'high': this.safeString(ticker, 'high'),
            'low': this.safeString(ticker, 'low'),
            'bid': this.safeString(ticker, 'bid'),
            'bidVolume': undefined,
            'ask': this.safeString(ticker, 'ask'),
            'askVolume': undefined,
            'vwap': undefined,
            'open': undefined,
            'close': last,
            'last': last,
            'previousClose': undefined,
            'change': undefined,
            'percentage': undefined,
            'average': this.safeString(ticker, 'mid'),
            'baseVolume': this.safeString(ticker, 'volume'),
            'quoteVolume': undefined,
            'info': ticker,
        }, market);
    }
    parseTrade(trade, market = undefined) {
        //
        // fetchTrades (public) v1
        //
        //     {
        //          "timestamp":1637258380,
        //          "tid":894452833,
        //          "price":"0.99941",
        //          "amount":"261.38",
        //          "exchange":"bitfinex",
        //          "type":"sell"
        //     }
        //
        // fetchMyTrades (private) v1
        //
        //     {
        //          "price":"0.99941",
        //          "amount":"261.38",
        //          "timestamp":"1637258380.0",
        //          "type":"Sell",
        //          "fee_currency":"UST",
        //          "fee_amount":"-0.52245157",
        //          "tid":894452833,
        //          "order_id":78819731373
        //     }
        //
        //     {
        //         "price":"0.99958",
        //         "amount":"261.90514",
        //         "timestamp":"1637258238.0",
        //         "type":"Buy",
        //         "fee_currency":"UDC",
        //         "fee_amount":"-0.52381028",
        //         "tid":894452800,
        //         "order_id":78819504838
        //     }
        //
        const id = this.safeString(trade, 'tid');
        const timestamp = this.safeTimestamp(trade, 'timestamp');
        const type = undefined;
        const side = this.safeStringLower(trade, 'type');
        const orderId = this.safeString(trade, 'order_id');
        const priceString = this.safeString(trade, 'price');
        const amountString = this.safeString(trade, 'amount');
        let fee = undefined;
        if ('fee_amount' in trade) {
            const feeCostString = Precise["default"].stringNeg(this.safeString(trade, 'fee_amount'));
            const feeCurrencyId = this.safeString(trade, 'fee_currency');
            const feeCurrencyCode = this.safeCurrencyCode(feeCurrencyId);
            fee = {
                'cost': feeCostString,
                'currency': feeCurrencyCode,
            };
        }
        return this.safeTrade({
            'id': id,
            'info': trade,
            'timestamp': timestamp,
            'datetime': this.iso8601(timestamp),
            'symbol': market['symbol'],
            'type': type,
            'order': orderId,
            'side': side,
            'takerOrMaker': undefined,
            'price': priceString,
            'amount': amountString,
            'cost': undefined,
            'fee': fee,
        }, market);
    }
    /**
     * @method
     * @name bitfinex1#fetchTrades
     * @description get the list of most recent trades for a particular symbol
     * @see https://docs.bitfinex.com/v1/reference/rest-public-trades
     * @param {string} symbol unified symbol of the market to fetch trades for
     * @param {int} [since] timestamp in ms of the earliest trade to fetch
     * @param {int} [limit] the maximum amount of trades to fetch
     * @param {object} [params] extra parameters specific to the exchange API endpoint
     * @returns {Trade[]} a list of [trade structures]{@link https://docs.ccxt.com/#/?id=public-trades}
     */
    async fetchTrades(symbol, since = undefined, limit = 50, params = {}) {
        await this.loadMarkets();
        const market = this.market(symbol);
        const request = {
            'symbol': market['id'],
            'limit_trades': limit,
        };
        if (since !== undefined) {
            request['timestamp'] = this.parseToInt(since / 1000);
        }
        const response = await this.publicGetTradesSymbol(this.extend(request, params));
        //
        //    [
        //        {
        //            "timestamp": "1694284565",
        //            "tid": "1415415034",
        //            "price": "25862.0",
        //            "amount": "0.00020685",
        //            "exchange": "bitfinex",
        //            "type": "buy"
        //        },
        //    ]
        //
        return this.parseTrades(response, market, since, limit);
    }
    /**
     * @method
     * @name bitfinex1#fetchMyTrades
     * @description fetch all trades made by the user
     * @see https://docs.bitfinex.com/v1/reference/rest-auth-past-trades
     * @param {string} symbol unified market symbol
     * @param {int} [since] the earliest time in ms to fetch trades for
     * @param {int} [limit] the maximum number of trades structures to retrieve
     * @param {object} [params] extra parameters specific to the exchange API endpoint
     * @returns {Trade[]} a list of [trade structures]{@link https://docs.ccxt.com/#/?id=trade-structure}
     */
    async fetchMyTrades(symbol = undefined, since = undefined, limit = undefined, params = {}) {
        if (symbol === undefined) {
            throw new errors.ArgumentsRequired(this.id + ' fetchMyTrades() requires a symbol argument');
        }
        await this.loadMarkets();
        const market = this.market(symbol);
        const request = {
            'symbol': market['id'],
        };
        if (limit !== undefined) {
            request['limit_trades'] = limit;
        }
        if (since !== undefined) {
            request['timestamp'] = this.parseToInt(since / 1000);
        }
        const response = await this.privatePostMytrades(this.extend(request, params));
        return this.parseTrades(response, market, since, limit);
    }
    /**
     * @method
     * @name bitfinex1#createOrder
     * @description create a trade order
     * @see https://docs.bitfinex.com/v1/reference/rest-auth-new-order
     * @param {string} symbol unified symbol of the market to create an order in
     * @param {string} type 'market' or 'limit'
     * @param {string} side 'buy' or 'sell'
     * @param {float} amount how much of currency you want to trade in units of base currency
     * @param {float} [price] the price at which the order is to be fulfilled, in units of the quote currency, ignored in market orders
     * @param {object} [params] extra parameters specific to the exchange API endpoint
     * @returns {object} an [order structure]{@link https://docs.ccxt.com/#/?id=order-structure}
     */
    async createOrder(symbol, type, side, amount, price = undefined, params = {}) {
        await this.loadMarkets();
        const market = this.market(symbol);
        const postOnly = this.safeBool(params, 'postOnly', false);
        type = type.toLowerCase();
        params = this.omit(params, ['postOnly']);
        if (market['spot']) {
            // although they claim that type needs to be 'exchange limit' or 'exchange market'
            // in fact that's not the case for swap markets
            type = this.safeStringLower(this.options['orderTypes'], type, type);
        }
        const request = {
            'symbol': market['id'],
            'side': side,
            'amount': this.amountToPrecision(symbol, amount),
            'type': type,
            'ocoorder': false,
            'buy_price_oco': 0,
            'sell_price_oco': 0,
        };
        if (type.indexOf('market') > -1) {
            request['price'] = this.nonce().toString();
        }
        else {
            request['price'] = this.priceToPrecision(symbol, price);
        }
        if (postOnly) {
            request['is_postonly'] = true;
        }
        const response = await this.privatePostOrderNew(this.extend(request, params));
        return this.parseOrder(response, market);
    }
    async editOrder(id, symbol, type, side, amount = undefined, price = undefined, params = {}) {
        await this.loadMarkets();
        const order = {
            'order_id': parseInt(id),
        };
        if (price !== undefined) {
            order['price'] = this.priceToPrecision(symbol, price);
        }
        if (amount !== undefined) {
            order['amount'] = this.numberToString(amount);
        }
        if (symbol !== undefined) {
            order['symbol'] = this.marketId(symbol);
        }
        if (side !== undefined) {
            order['side'] = side;
        }
        if (type !== undefined) {
            order['type'] = this.safeString(this.options['orderTypes'], type, type);
        }
        const response = await this.privatePostOrderCancelReplace(this.extend(order, params));
        return this.parseOrder(response);
    }
    /**
     * @method
     * @name bitfinex1#cancelOrder
     * @description cancels an open order
     * @see https://docs.bitfinex.com/v1/reference/rest-auth-cancel-order
     * @param {string} id order id
     * @param {string} symbol not used by bitfinex cancelOrder ()
     * @param {object} [params] extra parameters specific to the exchange API endpoint
     * @returns {object} An [order structure]{@link https://docs.ccxt.com/#/?id=order-structure}
     */
    async cancelOrder(id, symbol = undefined, params = {}) {
        await this.loadMarkets();
        const request = {
            'order_id': parseInt(id),
        };
        const response = await this.privatePostOrderCancel(this.extend(request, params));
        //
        //    {
        //        id: '161236928925',
        //        cid: '1720172026812',
        //        cid_date: '2024-07-05',
        //        gid: null,
        //        symbol: 'adaust',
        //        exchange: 'bitfinex',
        //        price: '0.33',
        //        avg_execution_price: '0.0',
        //        side: 'buy',
        //        type: 'exchange limit',
        //        timestamp: '1720172026.813',
        //        is_live: true,
        //        is_cancelled: false,
        //        is_hidden: false,
        //        oco_order: null,
        //        was_forced: false,
        //        original_amount: '10.0',
        //        remaining_amount: '10.0',
        //        executed_amount: '0.0',
        //        src: 'api',
        //        meta: {}
        //    }
        //
        return this.parseOrder(response);
    }
    /**
     * @method
     * @name bitfinex1#cancelAllOrders
     * @description cancel all open orders
     * @see https://docs.bitfinex.com/v1/reference/rest-auth-cancel-all-orders
     * @param {string} symbol not used by bitfinex cancelAllOrders
     * @param {object} [params] extra parameters specific to the exchange API endpoint
     * @returns {object} response from exchange
     */
    async cancelAllOrders(symbol = undefined, params = {}) {
        const response = await this.privatePostOrderCancelAll(params);
        //
        //    { result: 'Submitting 1 order cancellations.' }
        //
        return [
            this.safeOrder({
                'info': response,
            }),
        ];
    }
    parseOrder(order, market = undefined) {
        //
        //     {
        //           "id": 57334010955,
        //           "cid": 1611584840966,
        //           "cid_date": null,
        //           "gid": null,
        //           "symbol": "ltcbtc",
        //           "exchange": null,
        //           "price": "0.0042125",
        //           "avg_execution_price": "0.0042097",
        //           "side": "sell",
        //           "type": "exchange market",
        //           "timestamp": "1611584841.0",
        //           "is_live": false,
        //           "is_cancelled": false,
        //           "is_hidden": 0,
        //           "oco_order": 0,
        //           "was_forced": false,
        //           "original_amount": "0.205176",
        //           "remaining_amount": "0.0",
        //           "executed_amount": "0.205176",
        //           "src": "web"
        //     }
        //
        const side = this.safeString(order, 'side');
        const open = this.safeBool(order, 'is_live');
        const canceled = this.safeBool(order, 'is_cancelled');
        let status = undefined;
        if (open) {
            status = 'open';
        }
        else if (canceled) {
            status = 'canceled';
        }
        else {
            status = 'closed';
        }
        const marketId = this.safeStringUpper(order, 'symbol');
        const symbol = this.safeSymbol(marketId, market);
        let orderType = this.safeString(order, 'type', '');
        const exchange = orderType.indexOf('exchange ') >= 0;
        if (exchange) {
            const parts = order['type'].split(' ');
            orderType = parts[1];
        }
        const timestamp = this.safeTimestamp(order, 'timestamp');
        const id = this.safeString(order, 'id');
        return this.safeOrder({
            'info': order,
            'id': id,
            'clientOrderId': undefined,
            'timestamp': timestamp,
            'datetime': this.iso8601(timestamp),
            'lastTradeTimestamp': undefined,
            'symbol': symbol,
            'type': orderType,
            'timeInForce': undefined,
            'postOnly': undefined,
            'side': side,
            'price': this.safeString(order, 'price'),
            'triggerPrice': undefined,
            'average': this.safeString(order, 'avg_execution_price'),
            'amount': this.safeString(order, 'original_amount'),
            'remaining': this.safeString(order, 'remaining_amount'),
            'filled': this.safeString(order, 'executed_amount'),
            'status': status,
            'fee': undefined,
            'cost': undefined,
            'trades': undefined,
        }, market);
    }
    /**
     * @method
     * @name bitfinex1#fetchOpenOrders
     * @description fetch all unfilled currently open orders
     * @see https://docs.bitfinex.com/v1/reference/rest-auth-active-orders
     * @param {string} symbol unified market symbol
     * @param {int} [since] the earliest time in ms to fetch open orders for
     * @param {int} [limit] the maximum number of  open orders structures to retrieve
     * @param {object} [params] extra parameters specific to the exchange API endpoint
     * @returns {Order[]} a list of [order structures]{@link https://docs.ccxt.com/#/?id=order-structure}
     */
    async fetchOpenOrders(symbol = undefined, since = undefined, limit = undefined, params = {}) {
        await this.loadMarkets();
        if (symbol !== undefined) {
            if (!(symbol in this.markets)) {
                throw new errors.ExchangeError(this.id + ' has no symbol ' + symbol);
            }
        }
        const response = await this.privatePostOrders(params);
        let orders = this.parseOrders(response, undefined, since, limit);
        if (symbol !== undefined) {
            orders = this.filterBy(orders, 'symbol', symbol);
        }
        return orders;
    }
    /**
     * @method
     * @name bitfinex1#fetchClosedOrders
     * @description fetches information on multiple closed orders made by the user
     * @see https://docs.bitfinex.com/v1/reference/rest-auth-orders-history
     * @param {string} symbol unified market symbol of the market orders were made in
     * @param {int} [since] the earliest time in ms to fetch orders for
     * @param {int} [limit] the maximum number of order structures to retrieve
     * @param {object} [params] extra parameters specific to the exchange API endpoint
     * @returns {Order[]} a list of [order structures]{@link https://docs.ccxt.com/#/?id=order-structure}
     */
    async fetchClosedOrders(symbol = undefined, since = undefined, limit = undefined, params = {}) {
        await this.loadMarkets();
        symbol = this.symbol(symbol);
        const request = {};
        if (limit !== undefined) {
            request['limit'] = limit;
        }
        const response = await this.privatePostOrdersHist(this.extend(request, params));
        let orders = this.parseOrders(response, undefined, since, limit);
        if (symbol !== undefined) {
            orders = this.filterBy(orders, 'symbol', symbol);
        }
        orders = this.filterByArray(orders, 'status', ['closed', 'canceled'], false);
        return orders;
    }
    /**
     * @method
     * @name bitfinex1#fetchOrder
     * @description fetches information on an order made by the user
     * @see https://docs.bitfinex.com/v1/reference/rest-auth-order-status
     * @param {string} id the order id
     * @param {string} symbol not used by bitfinex fetchOrder
     * @param {object} [params] extra parameters specific to the exchange API endpoint
     * @returns {object} An [order structure]{@link https://docs.ccxt.com/#/?id=order-structure}
     */
    async fetchOrder(id, symbol = undefined, params = {}) {
        await this.loadMarkets();
        const request = {
            'order_id': parseInt(id),
        };
        const response = await this.privatePostOrderStatus(this.extend(request, params));
        return this.parseOrder(response);
    }
    parseOHLCV(ohlcv, market = undefined) {
        //
        //     [
        //         1457539800000,
        //         0.02594,
        //         0.02594,
        //         0.02594,
        //         0.02594,
        //         0.1
        //     ]
        //
        return [
            this.safeInteger(ohlcv, 0),
            this.safeNumber(ohlcv, 1),
            this.safeNumber(ohlcv, 3),
            this.safeNumber(ohlcv, 4),
            this.safeNumber(ohlcv, 2),
            this.safeNumber(ohlcv, 5),
        ];
    }
    /**
     * @method
     * @name bitfinex1#fetchOHLCV
     * @description fetches historical candlestick data containing the open, high, low, and close price, and the volume of a market
     * @see https://docs.bitfinex.com/reference/rest-public-candles#aggregate-funding-currency-candles
     * @param {string} symbol unified symbol of the market to fetch OHLCV data for
     * @param {string} timeframe the length of time each candle represents
     * @param {int} [since] timestamp in ms of the earliest candle to fetch
     * @param {int} [limit] the maximum amount of candles to fetch
     * @param {object} [params] extra parameters specific to the exchange API endpoint
     * @param {int} [params.until] timestamp in ms of the latest candle to fetch
     * @returns {int[][]} A list of candles ordered as timestamp, open, high, low, close, volume
     */
    async fetchOHLCV(symbol, timeframe = '1m', since = undefined, limit = undefined, params = {}) {
        await this.loadMarkets();
        if (limit === undefined) {
            limit = 100;
        }
        else {
            limit = Math.min(limit, 10000);
        }
        const market = this.market(symbol);
        const v2id = 't' + market['id'];
        const request = {
            'symbol': v2id,
            'timeframe': this.safeString(this.timeframes, timeframe, timeframe),
            'sort': 1,
            'limit': limit,
        };
        const until = this.safeInteger(params, 'until');
        if (since !== undefined) {
            request['start'] = since;
        }
        else if (until !== undefined) {
            const duration = this.parseTimeframe(timeframe);
            request['start'] = until - ((limit - 1) * duration * 1000);
        }
        if (until !== undefined) {
            request['end'] = until;
        }
        params = this.omit(params, 'until');
        const response = await this.v2GetCandlesTradeTimeframeSymbolHist(this.extend(request, params));
        //
        //     [
        //         [1457539800000,0.02594,0.02594,0.02594,0.02594,0.1],
        //         [1457547300000,0.02577,0.02577,0.02577,0.02577,0.01],
        //         [1457550240000,0.0255,0.0253,0.0255,0.0252,3.2640000000000002],
        //     ]
        //
        return this.parseOHLCVs(response, market, timeframe, since, limit);
    }
    getCurrencyName(code) {
        // todo rewrite for https://api-pub.bitfinex.com//v2/conf/pub:map:tx:method
        if (code in this.options['currencyNames']) {
            return this.options['currencyNames'][code];
        }
        throw new errors.NotSupported(this.id + ' ' + code + ' not supported for withdrawal');
    }
    /**
     * @method
     * @name bitfinex1#createDepositAddress
     * @description create a currency deposit address
     * @see https://docs.bitfinex.com/v1/reference/rest-auth-deposit
     * @param {string} code unified currency code of the currency for the deposit address
     * @param {object} [params] extra parameters specific to the exchange API endpoint
     * @returns {object} an [address structure]{@link https://docs.ccxt.com/#/?id=address-structure}
     */
    async createDepositAddress(code, params = {}) {
        await this.loadMarkets();
        const request = {
            'renew': 1,
        };
        return await this.fetchDepositAddress(code, this.extend(request, params));
    }
    /**
     * @method
     * @name bitfinex1#fetchDepositAddress
     * @description fetch the deposit address for a currency associated with this account
     * @see https://docs.bitfinex.com/v1/reference/rest-auth-deposit
     * @param {string} code unified currency code
     * @param {object} [params] extra parameters specific to the exchange API endpoint
     * @returns {object} an [address structure]{@link https://docs.ccxt.com/#/?id=address-structure}
     */
    async fetchDepositAddress(code, params = {}) {
        await this.loadMarkets();
        // todo rewrite for https://api-pub.bitfinex.com//v2/conf/pub:map:tx:method
        const name = this.getCurrencyName(code);
        const request = {
            'method': name,
            'wallet_name': 'exchange',
            'renew': 0, // a value of 1 will generate a new address
        };
        const response = await this.privatePostDepositNew(this.extend(request, params));
        let address = this.safeValue(response, 'address');
        let tag = undefined;
        if ('address_pool' in response) {
            tag = address;
            address = response['address_pool'];
        }
        this.checkAddress(address);
        return {
            'currency': code,
            'address': address,
            'tag': tag,
            'network': undefined,
            'info': response,
        };
    }
    /**
     * @method
     * @name bitfinex1#fetchDepositsWithdrawals
     * @description fetch history of deposits and withdrawals
     * @see https://docs.bitfinex.com/v1/reference/rest-auth-deposit-withdrawal-history
     * @param {string} code unified currency code for the currency of the deposit/withdrawals
     * @param {int} [since] timestamp in ms of the earliest deposit/withdrawal, default is undefined
     * @param {int} [limit] max number of deposit/withdrawals to return, default is undefined
     * @param {object} [params] extra parameters specific to the exchange API endpoint
     * @returns {object} a list of [transaction structure]{@link https://docs.ccxt.com/#/?id=transaction-structure}
     */
    async fetchDepositsWithdrawals(code = undefined, since = undefined, limit = undefined, params = {}) {
        await this.loadMarkets();
        let currencyId = this.safeString(params, 'currency');
        const query = this.omit(params, 'currency');
        let currency = undefined;
        if (currencyId === undefined) {
            if (code === undefined) {
                throw new errors.ArgumentsRequired(this.id + ' fetchDepositsWithdrawals() requires a currency `code` argument or a `currency` parameter');
            }
            else {
                currency = this.currency(code);
                currencyId = currency['id'];
            }
        }
        query['currency'] = currencyId;
        if (since !== undefined) {
            query['since'] = this.parseToInt(since / 1000);
        }
        const response = await this.privatePostHistoryMovements(this.extend(query, params));
        //
        //     [
        //         {
        //             "id": 581183,
        //             "txid":  123456,
        //             "currency": "BTC",
        //             "method": "BITCOIN",
        //             "type": "WITHDRAWAL",
        //             "amount": ".01",
        //             "description": "3QXYWgRGX2BPYBpUDBssGbeWEa5zq6snBZ, offchain transfer ",
        //             "address": "3QXYWgRGX2BPYBpUDBssGbeWEa5zq6snBZ",
        //             "status": "COMPLETED",
        //             "timestamp": "1443833327.0",
        //             "timestamp_created":  "1443833327.1",
        //             "fee":  0.1,
        //         }
        //     ]
        //
        return this.parseTransactions(response, currency, since, limit);
    }
    parseTransaction(transaction, currency = undefined) {
        //
        // crypto
        //
        //     {
        //         "id": 12042490,
        //         "fee": "-0.02",
        //         "txid": "EA5B5A66000B66855865EFF2494D7C8D1921FCBE996482157EBD749F2C85E13D",
        //         "type": "DEPOSIT",
        //         "amount": "2099.849999",
        //         "method": "RIPPLE",
        //         "status": "COMPLETED",
        //         "address": "2505189261",
        //         "currency": "XRP",
        //         "timestamp": "1551730524.0",
        //         "description": "EA5B5A66000B66855865EFF2494D7C8D1921FCBE996482157EBD749F2C85E13D",
        //         "timestamp_created": "1551730523.0"
        //     }
        //
        // fiat
        //
        //     {
        //         "id": 12725095,
        //         "fee": "-60.0",
        //         "txid": null,
        //         "type": "WITHDRAWAL",
        //         "amount": "9943.0",
        //         "method": "WIRE",
        //         "status": "SENDING",
        //         "address": null,
        //         "currency": "EUR",
        //         "timestamp": "1561802484.0",
        //         "description": "Name: bob, AccountAddress: some address, Account: someaccountno, Bank: bank address, SWIFT: foo, Country: UK, Details of Payment: withdrawal name, Intermediary Bank Name: , Intermediary Bank Address: , Intermediary Bank City: , Intermediary Bank Country: , Intermediary Bank Account: , Intermediary Bank SWIFT: , Fee: -60.0",
        //         "timestamp_created": "1561716066.0"
        //     }
        //
        // withdraw
        //
        //     {
        //         "status": "success",
        //         "message": "Your withdrawal request has been successfully submitted.",
        //         "withdrawal_id": 586829
        //     }
        //
        const timestamp = this.safeTimestamp(transaction, 'timestamp_created');
        const currencyId = this.safeString(transaction, 'currency');
        const code = this.safeCurrencyCode(currencyId, currency);
        let feeCost = this.safeString(transaction, 'fee');
        if (feeCost !== undefined) {
            feeCost = Precise["default"].stringAbs(feeCost);
        }
        return {
            'info': transaction,
            'id': this.safeString2(transaction, 'id', 'withdrawal_id'),
            'txid': this.safeString(transaction, 'txid'),
            'type': this.safeStringLower(transaction, 'type'),
            'currency': code,
            'network': undefined,
            'amount': this.safeNumber(transaction, 'amount'),
            'status': this.parseTransactionStatus(this.safeString(transaction, 'status')),
            'timestamp': timestamp,
            'datetime': this.iso8601(timestamp),
            'address': this.safeString(transaction, 'address'),
            'addressFrom': undefined,
            'addressTo': undefined,
            'tag': this.safeString(transaction, 'description'),
            'tagFrom': undefined,
            'tagTo': undefined,
            'updated': this.safeTimestamp(transaction, 'timestamp'),
            'comment': undefined,
            'internal': undefined,
            'fee': {
                'currency': code,
                'cost': this.parseNumber(feeCost),
                'rate': undefined,
            },
        };
    }
    parseTransactionStatus(status) {
        const statuses = {
            'SENDING': 'pending',
            'CANCELED': 'canceled',
            'ZEROCONFIRMED': 'failed',
            'COMPLETED': 'ok',
        };
        return this.safeString(statuses, status, status);
    }
    /**
     * @method
     * @name bitfinex1#withdraw
     * @description make a withdrawal
     * @see https://docs.bitfinex.com/v1/reference/rest-auth-withdrawal
     * @param {string} code unified currency code
     * @param {float} amount the amount to withdraw
     * @param {string} address the address to withdraw to
     * @param {string} tag
     * @param {object} [params] extra parameters specific to the exchange API endpoint
     * @returns {object} a [transaction structure]{@link https://docs.ccxt.com/#/?id=transaction-structure}
     */
    async withdraw(code, amount, address, tag = undefined, params = {}) {
        [tag, params] = this.handleWithdrawTagAndParams(tag, params);
        this.checkAddress(address);
        await this.loadMarkets();
        // todo rewrite for https://api-pub.bitfinex.com//v2/conf/pub:map:tx:method
        const name = this.getCurrencyName(code);
        const currency = this.currency(code);
        const request = {
            'withdraw_type': name,
            'walletselected': 'exchange',
            'amount': this.numberToString(amount),
            'address': address,
        };
        if (tag !== undefined) {
            request['payment_id'] = tag;
        }
        const responses = await this.privatePostWithdraw(this.extend(request, params));
        //
        //     [
        //         {
        //             "status":"success",
        //             "message":"Your withdrawal request has been successfully submitted.",
        //             "withdrawal_id":586829
        //         }
        //     ]
        //
        const response = this.safeDict(responses, 0, {});
        const id = this.safeInteger(response, 'withdrawal_id');
        const message = this.safeString(response, 'message');
        const errorMessage = this.findBroadlyMatchedKey(this.exceptions['broad'], message);
        if (id === 0) {
            if (errorMessage !== undefined) {
                const ExceptionClass = this.exceptions['broad'][errorMessage];
                throw new ExceptionClass(this.id + ' ' + message);
            }
            throw new errors.ExchangeError(this.id + ' withdraw returned an id of zero: ' + this.json(response));
        }
        return this.parseTransaction(response, currency);
    }
    /**
     * @method
     * @name bitfinex1#fetchPositions
     * @description fetch all open positions
     * @see https://docs.bitfinex.com/v1/reference/rest-auth-active-positions
     * @param {string[]|undefined} symbols list of unified market symbols
     * @param {object} [params] extra parameters specific to the exchange API endpoint
     * @returns {object[]} a list of [position structure]{@link https://docs.ccxt.com/#/?id=position-structure}
     */
    async fetchPositions(symbols = undefined, params = {}) {
        await this.loadMarkets();
        const response = await this.privatePostPositions(params);
        //
        //     [
        //         {
        //             "id":943715,
        //             "symbol":"btcusd",
        //             "status":"ACTIVE",
        //             "base":"246.94",
        //             "amount":"1.0",
        //             "timestamp":"1444141857.0",
        //             "swap":"0.0",
        //             "pl":"-2.22042"
        //         }
        //     ]
        //
        // todo unify parsePosition/parsePositions
        return response;
    }
    nonce() {
        return this.microseconds();
    }
    sign(path, api = 'public', method = 'GET', params = {}, headers = undefined, body = undefined) {
        let request = '/' + this.implodeParams(path, params);
        if (api === 'v2') {
            request = '/' + api + request;
        }
        else {
            request = '/' + this.version + request;
        }
        let query = this.omit(params, this.extractParams(path));
        let url = this.urls['api'][api] + request;
        if ((api === 'public') || (path.indexOf('/hist') >= 0)) {
            if (Object.keys(query).length) {
                const suffix = '?' + this.urlencode(query);
                url += suffix;
                request += suffix;
            }
        }
        if (api === 'private') {
            this.checkRequiredCredentials();
            const nonce = this.nonce();
            query = this.extend({
                'nonce': nonce.toString(),
                'request': request,
            }, query);
            body = this.json(query);
            const payload = this.stringToBase64(body);
            const secret = this.encode(this.secret);
            const signature = this.hmac(this.encode(payload), secret, sha512.sha384);
            headers = {
                'X-BFX-APIKEY': this.apiKey,
                'X-BFX-PAYLOAD': payload,
                'X-BFX-SIGNATURE': signature,
                'Content-Type': 'application/json',
            };
        }
        return { 'url': url, 'method': method, 'body': body, 'headers': headers };
    }
    handleErrors(code, reason, url, method, headers, body, response, requestHeaders, requestBody) {
        if (response === undefined) {
            return undefined;
        }
        let throwError = false;
        if (code >= 400) {
            if (body[0] === '{') {
                throwError = true;
            }
        }
        else {
            // json response with error, i.e:
            // [{"status":"error","message":"Momentary balance check. Please wait few seconds and try the transfer again."}]
            const responseObject = this.safeDict(response, 0, {});
            const status = this.safeString(responseObject, 'status', '');
            if (status === 'error') {
                throwError = true;
            }
        }
        if (throwError) {
            const feedback = this.id + ' ' + body;
            const message = this.safeString2(response, 'message', 'error');
            this.throwExactlyMatchedException(this.exceptions['exact'], message, feedback);
            this.throwBroadlyMatchedException(this.exceptions['broad'], message, feedback);
            throw new errors.ExchangeError(feedback); // unknown message
        }
        return undefined;
    }
}

module.exports = bitfinex1;
