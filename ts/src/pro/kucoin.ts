
//  ---------------------------------------------------------------------------

import kucoinRest from '../kucoin.js';
import { ExchangeError, ArgumentsRequired } from '../base/errors.js';
import { ArrayCache, ArrayCacheByTimestamp, ArrayCacheBySymbolById } from '../base/ws/Cache.js';
import type { Int, Str, Strings, OrderBook, Order, Trade, Ticker, Tickers, OHLCV, Balances } from '../base/types.js';
import Client from '../base/ws/Client.js';

//  ---------------------------------------------------------------------------

export default class kucoin extends kucoinRest {
    describe () {
        return this.deepExtend (super.describe (), {
            'has': {
                'ws': true,
                'createOrderWs': false,
                'editOrderWs': false,
                'fetchOpenOrdersWs': false,
                'fetchOrderWs': false,
                'cancelOrderWs': false,
                'cancelOrdersWs': false,
                'cancelAllOrdersWs': false,
                'watchBidsAsks': true,
                'watchOrderBook': true,
                'watchOrders': true,
                'watchMyTrades': true,
                'watchTickers': true,
                'watchTicker': true,
                'watchTrades': true,
                'watchTradesForSymbols': true,
                'watchOrderBookForSymbols': true,
                'watchBalance': true,
                'watchOHLCV': true,
            },
            'options': {
                'tradesLimit': 1000,
                'watchTicker': {
                    'name': 'market/snapshot', // market/ticker
                },
                'watchOrderBook': {
                    'snapshotDelay': 5,
                    'snapshotMaxRetries': 3,
                    'method': '/market/level2', // '/spotMarket/level2Depth5' or '/spotMarket/level2Depth50'
                },
            },
            'streaming': {
                // kucoin does not support built-in ws protocol-level ping-pong
                // instead it requires a custom json-based text ping-pong
                // https://docs.kucoin.com/#ping
                'ping': this.ping,
            },
        });
    }

    async negotiate (privateChannel, params = {}) {
        const connectId = privateChannel ? 'private' : 'public';
        const urls = this.safeValue (this.options, 'urls', {});
        const spawaned = this.safeValue (urls, connectId);
        if (spawaned !== undefined) {
            return await spawaned;
        }
        // we store an awaitable to the url
        // so that multiple calls don't asynchronously
        // fetch different urls and overwrite each other
        urls[connectId] = this.spawn (this.negotiateHelper, privateChannel, params);
        this.options['urls'] = urls;
        const future = urls[connectId];
        return await future;
    }

    async negotiateHelper (privateChannel, params = {}) {
        let response = undefined;
        const connectId = privateChannel ? 'private' : 'public';
        try {
            if (privateChannel) {
                response = await this.privatePostBulletPrivate (params);
                //
                //     {
                //         "code": "200000",
                //         "data": {
                //             "instanceServers": [
                //                 {
                //                     "pingInterval":  50000,
                //                     "endpoint": "wss://push-private.kucoin.com/endpoint",
                //                     "protocol": "websocket",
                //                     "encrypt": true,
                //                     "pingTimeout": 10000
                //                 }
                //             ],
                //             "token": "2neAiuYvAU61ZDXANAGAsiL4-iAExhsBXZxftpOeh_55i3Ysy2q2LEsEWU64mdzUOPusi34M_wGoSf7iNyEWJ1UQy47YbpY4zVdzilNP-Bj3iXzrjjGlWtiYB9J6i9GjsxUuhPw3BlrzazF6ghq4Lzf7scStOz3KkxjwpsOBCH4=.WNQmhZQeUKIkh97KYgU0Lg=="
                //         }
                //     }
                //
            } else {
                response = await this.publicPostBulletPublic (params);
            }
            const data = this.safeValue (response, 'data', {});
            const instanceServers = this.safeValue (data, 'instanceServers', []);
            const firstInstanceServer = this.safeValue (instanceServers, 0);
            const pingInterval = this.safeInteger (firstInstanceServer, 'pingInterval');
            const endpoint = this.safeString (firstInstanceServer, 'endpoint');
            const token = this.safeString (data, 'token');
            const result = endpoint + '?' + this.urlencode ({
                'token': token,
                'privateChannel': privateChannel,
                'connectId': connectId,
            });
            const client = this.client (result);
            client.keepAlive = pingInterval;
            return result;
        } catch (e) {
            const future = this.safeValue (this.options['urls'], connectId);
            future.reject (e);
            delete this.options['urls'][connectId];
        }
        return undefined;
    }

    requestId () {
        const requestId = this.sum (this.safeInteger (this.options, 'requestId', 0), 1);
        this.options['requestId'] = requestId;
        return requestId;
    }

    async subscribe (url, messageHash, subscriptionHash, params = {}, subscription = undefined) {
        const requestId = this.requestId ().toString ();
        const request = {
            'id': requestId,
            'type': 'subscribe',
            'topic': subscriptionHash,
            'response': true,
        };
        const message = this.extend (request, params);
        const client = this.client (url);
        if (!(subscriptionHash in client.subscriptions)) {
            client.subscriptions[requestId] = subscriptionHash;
        }
        return await this.watch (url, messageHash, message, subscriptionHash, subscription);
    }

    async subscribeMultiple (url, messageHashes, topic, subscriptionHashes, params = {}, subscription = undefined) {
        const requestId = this.requestId ().toString ();
        const request = {
            'id': requestId,
            'type': 'subscribe',
            'topic': topic,
            'response': true,
        };
        const message = this.extend (request, params);
        const client = this.client (url);
        for (let i = 0; i < subscriptionHashes.length; i++) {
            const subscriptionHash = subscriptionHashes[i];
            if (!(subscriptionHash in client.subscriptions)) {
                client.subscriptions[requestId] = subscriptionHash;
            }
        }
        return await this.watchMultiple (url, messageHashes, message, subscriptionHashes, subscription);
    }

    async watchTicker (symbol: string, params = {}): Promise<Ticker> {
        /**
         * @method
         * @name kucoin#watchTicker
         * @description watches a price ticker, a statistical calculation with the information calculated over the past 24 hours for a specific market
         * @param {string} symbol unified symbol of the market to fetch the ticker for
         * @param {object} [params] extra parameters specific to the exchange API endpoint
         * @returns {object} a [ticker structure]{@link https://docs.ccxt.com/#/?id=ticker-structure}
         */
        await this.loadMarkets ();
        const market = this.market (symbol);
        symbol = market['symbol'];
        const url = await this.negotiate (false);
        const [ method, query ] = this.handleOptionAndParams (params, 'watchTicker', 'method', '/market/snapshot');
        const topic = method + ':' + market['id'];
        const messageHash = 'ticker:' + symbol;
        return await this.subscribe (url, messageHash, topic, query);
    }

    async watchTickers (symbols: Strings = undefined, params = {}): Promise<Tickers> {
        /**
         * @method
         * @name kucoin#watchTickers
         * @description watches a price ticker, a statistical calculation with the information calculated over the past 24 hours for all markets of a specific list
         * @param {string[]} symbols unified symbol of the market to fetch the ticker for
         * @param {object} [params] extra parameters specific to the exchange API endpoint
         * @returns {object} a [ticker structure]{@link https://docs.ccxt.com/#/?id=ticker-structure}
         */
        await this.loadMarkets ();
        symbols = this.marketSymbols (symbols);
        let messageHash = 'tickers';
        if (symbols !== undefined) {
            messageHash = 'tickers::' + symbols.join (',');
        }
        const url = await this.negotiate (false);
        const topic = `/market/ticker:${symbols !== undefined ? symbols.join (',') : "all"}`;
        const tickers = await this.subscribe (url, messageHash, topic, params);
        if (this.newUpdates) {
            return tickers;
        }
        return this.filterByArray (this.tickers, 'symbol', symbols);
    }

    handleTicker (client: Client, message) {
        //
        // market/snapshot
        //
        // updates come in every 2 sec unless there
        // were no changes since the previous update
        //
        //     {
        //         "data": {
        //             "sequence": "1545896669291",
        //             "data": {
        //                 "trading": true,
        //                 "symbol": "KCS-BTC",
        //                 "buy": 0.00011,
        //                 "sell": 0.00012,
        //                 "sort": 100,
        //                 "volValue": 3.13851792584, // total
        //                 "baseCurrency": "KCS",
        //                 "market": "BTC",
        //                 "quoteCurrency": "BTC",
        //                 "symbolCode": "KCS-BTC",
        //                 "datetime": 1548388122031,
        //                 "high": 0.00013,
        //                 "vol": 27514.34842,
        //                 "low": 0.0001,
        //                 "changePrice": -1.0e-5,
        //                 "changeRate": -0.0769,
        //                 "lastTradedPrice": 0.00012,
        //                 "board": 0,
        //                 "mark": 0
        //             }
        //         },
        //         "subject": "trade.snapshot",
        //         "topic": "/market/snapshot:KCS-BTC",
        //         "type": "message"
        //     }
        //
        // market/ticker
        //
        //     {
        //         "type": "message",
        //         "topic": "/market/ticker:BTC-USDT",
        //         "subject": "trade.ticker",
        //         "data": {
        //             "bestAsk": "62163",
        //             "bestAskSize": "0.99011388",
        //             "bestBid": "62162.9",
        //             "bestBidSize": "0.04794181",
        //             "price": "62162.9",
        //             "sequence": "1621383371852",
        //             "size": "0.00832274",
        //             "time": 1634641987564
        //         }
        //     }
        //
        const topic = this.safeString (message, 'topic');
        let market = undefined;
        if (topic !== undefined) {
            const parts = topic.split (':');
            const first = this.safeString (parts, 1);
            let marketId = undefined;
            if (first === 'all') {
                marketId = this.safeString (message, 'subject');
            } else {
                marketId = first;
            }
            market = this.safeMarket (marketId, market, '-');
        }
        const data = this.safeValue (message, 'data', {});
        const rawTicker = this.safeValue (data, 'data', data);
        const ticker = this.parseTicker (rawTicker, market);
        const symbol = ticker['symbol'];
        this.tickers[symbol] = ticker;
        const messageHash = 'ticker:' + symbol;
        client.resolve (ticker, messageHash);
        // watchTickers
        const allTickers = {};
        allTickers[symbol] = ticker;
        client.resolve (allTickers, 'tickers');
        const messageHashes = this.findMessageHashes (client, 'tickers::');
        for (let i = 0; i < messageHashes.length; i++) {
            const currentMessageHash = messageHashes[i];
            const parts = currentMessageHash.split ('::');
            const symbolsString = parts[1];
            const symbols = symbolsString.split (',');
            const tickers = this.filterByArray (this.tickers, 'symbol', symbols);
            const tickersSymbols = Object.keys (tickers);
            const numTickers = tickersSymbols.length;
            if (numTickers > 0) {
                client.resolve (tickers, currentMessageHash);
            }
        }
    }

    async watchBidsAsks (symbols: Strings = undefined, params = {}): Promise<Tickers> {
        /**
         * @method
         * @name kucoin#watchBidsAsks
         * @see https://www.kucoin.com/docs/websocket/spot-trading/public-channels/level1-bbo-market-data
         * @description watches best bid & ask for symbols
         * @param {string[]} symbols unified symbol of the market to fetch the ticker for
         * @param {object} [params] extra parameters specific to the exchange API endpoint
         * @returns {object} a [ticker structure]{@link https://docs.ccxt.com/#/?id=ticker-structure}
         */
        const ticker = await this.watchMultiHelper ('watchBidsAsks', '/spotMarket/level1:', symbols, params);
        if (this.newUpdates) {
            const tickers = {};
            tickers[ticker['symbol']] = ticker;
            return tickers;
        }
        return this.filterByArray (this.bidsasks, 'symbol', symbols);
    }

    async watchMultiHelper (methodName, channelName: string, symbols: Strings = undefined, params = {}) {
        await this.loadMarkets ();
        symbols = this.marketSymbols (symbols, undefined, false, true, false);
        const length = symbols.length;
        if (length > 100) {
            throw new ArgumentsRequired (this.id + ' ' + methodName + '() accepts a maximum of 100 symbols');
        }
        const messageHashes = [];
        for (let i = 0; i < symbols.length; i++) {
            const symbol = symbols[i];
            const market = this.market (symbol);
            messageHashes.push ('bidask@' + market['symbol']);
        }
        const url = await this.negotiate (false);
        const marketIds = this.marketIds (symbols);
        const joined = marketIds.join (',');
        const requestId = this.requestId ().toString ();
        const request = {
            'id': requestId,
            'type': 'subscribe',
            'topic': channelName + joined,
            'response': true,
        };
        const message = this.extend (request, params);
        return await this.watchMultiple (url, messageHashes, message, messageHashes);
    }

    handleBidAsk (client: Client, message) {
        //
        // arrives one symbol dict
        //
        //     {
        //         topic: '/spotMarket/level1:ETH-USDT',
        //         type: 'message',
        //         data: {
        //             asks: [ '3347.42', '2.0778387' ],
        //             bids: [ '3347.41', '6.0411697' ],
        //             timestamp: 1712231142085
        //         },
        //         subject: 'level1'
        //     }
        //
        const parsedTicker = this.parseWsBidAsk (message);
        const symbol = parsedTicker['symbol'];
        this.bidsasks[symbol] = parsedTicker;
        const messageHash = 'bidask@' + symbol;
        client.resolve (parsedTicker, messageHash);
    }

    parseWsBidAsk (ticker, market = undefined) {
        const topic = this.safeString (ticker, 'topic');
        const parts = topic.split (':');
        const marketId = parts[1];
        market = this.safeMarket (marketId, market);
        const symbol = this.safeString (market, 'symbol');
        const data = this.safeDict (ticker, 'data', {});
        const ask = this.safeList (data, 'asks', []);
        const bid = this.safeList (data, 'bids', []);
        const timestamp = this.safeInteger (data, 'timestamp');
        return this.safeTicker ({
            'symbol': symbol,
            'timestamp': timestamp,
            'datetime': this.iso8601 (timestamp),
            'ask': this.safeNumber (ask, 0),
            'askVolume': this.safeNumber (ask, 1),
            'bid': this.safeNumber (bid, 0),
            'bidVolume': this.safeNumber (bid, 1),
            'info': ticker,
        }, market);
    }

    async watchOHLCV (symbol: string, timeframe = '1m', since: Int = undefined, limit: Int = undefined, params = {}): Promise<OHLCV[]> {
        /**
         * @method
         * @name kucoin#watchOHLCV
         * @description watches historical candlestick data containing the open, high, low, and close price, and the volume of a market
         * @param {string} symbol unified symbol of the market to fetch OHLCV data for
         * @param {string} timeframe the length of time each candle represents
         * @param {int} [since] timestamp in ms of the earliest candle to fetch
         * @param {int} [limit] the maximum amount of candles to fetch
         * @param {object} [params] extra parameters specific to the exchange API endpoint
         * @returns {int[][]} A list of candles ordered as timestamp, open, high, low, close, volume
         */
        await this.loadMarkets ();
        const url = await this.negotiate (false);
        const market = this.market (symbol);
        symbol = market['symbol'];
        const period = this.safeString (this.timeframes, timeframe, timeframe);
        const topic = '/market/candles:' + market['id'] + '_' + period;
        const messageHash = 'candles:' + symbol + ':' + timeframe;
        const ohlcv = await this.subscribe (url, messageHash, topic, params);
        if (this.newUpdates) {
            limit = ohlcv.getLimit (symbol, limit);
        }
        return this.filterBySinceLimit (ohlcv, since, limit, 0, true);
    }

    handleOHLCV (client: Client, message) {
        //
        //     {
        //         "data": {
        //             "symbol": "BTC-USDT",
        //             "candles": [
        //                 "1624881240",
        //                 "34138.8",
        //                 "34121.6",
        //                 "34138.8",
        //                 "34097.9",
        //                 "3.06097133",
        //                 "104430.955068564"
        //             ],
        //             "time": 1624881284466023700
        //         },
        //         "subject": "trade.candles.update",
        //         "topic": "/market/candles:BTC-USDT_1min",
        //         "type": "message"
        //     }
        //
        const data = this.safeValue (message, 'data', {});
        const marketId = this.safeString (data, 'symbol');
        const candles = this.safeValue (data, 'candles', []);
        const topic = this.safeString (message, 'topic');
        const parts = topic.split ('_');
        const interval = this.safeString (parts, 1);
        // use a reverse lookup in a static map instead
        const timeframe = this.findTimeframe (interval);
        const market = this.safeMarket (marketId);
        const symbol = market['symbol'];
        const messageHash = 'candles:' + symbol + ':' + timeframe;
        this.ohlcvs[symbol] = this.safeValue (this.ohlcvs, symbol, {});
        let stored = this.safeValue (this.ohlcvs[symbol], timeframe);
        if (stored === undefined) {
            const limit = this.safeInteger (this.options, 'OHLCVLimit', 1000);
            stored = new ArrayCacheByTimestamp (limit);
            this.ohlcvs[symbol][timeframe] = stored;
        }
        const ohlcv = this.parseOHLCV (candles, market);
        stored.append (ohlcv);
        client.resolve (stored, messageHash);
    }

    async watchTrades (symbol: string, since: Int = undefined, limit: Int = undefined, params = {}): Promise<Trade[]> {
        /**
         * @method
         * @name kucoin#watchTrades
         * @description get the list of most recent trades for a particular symbol
         * @param {string} symbol unified symbol of the market to fetch trades for
         * @param {int} [since] timestamp in ms of the earliest trade to fetch
         * @param {int} [limit] the maximum amount of trades to fetch
         * @param {object} [params] extra parameters specific to the exchange API endpoint
         * @returns {object[]} a list of [trade structures]{@link https://docs.ccxt.com/#/?id=public-trades}
         */
        return await this.watchTradesForSymbols ([ symbol ], since, limit, params);
    }

    async watchTradesForSymbols (symbols: string[], since: Int = undefined, limit: Int = undefined, params = {}): Promise<Trade[]> {
        /**
         * @method
         * @name kucoin#watchTrades
         * @description get the list of most recent trades for a particular symbol
         * @param {string} symbol unified symbol of the market to fetch trades for
         * @param {int} [since] timestamp in ms of the earliest trade to fetch
         * @param {int} [limit] the maximum amount of trades to fetch
         * @param {object} [params] extra parameters specific to the exchange API endpoint
         * @returns {object[]} a list of [trade structures]{@link https://docs.ccxt.com/#/?id=public-trades}
         */
        const symbolsLength = symbols.length;
        if (symbolsLength === 0) {
            throw new ArgumentsRequired (this.id + ' watchTradesForSymbols() requires a non-empty array of symbols');
        }
        await this.loadMarkets ();
        symbols = this.marketSymbols (symbols);
        const marketIds = this.marketIds (symbols);
        const url = await this.negotiate (false);
        const messageHashes = [];
        const subscriptionHashes = [];
        const topic = '/market/match:' + marketIds.join (',');
        for (let i = 0; i < symbols.length; i++) {
            const symbol = symbols[i];
            messageHashes.push ('trades:' + symbol);
            const marketId = marketIds[i];
            subscriptionHashes.push ('/market/match:' + marketId);
        }
        const trades = await this.subscribeMultiple (url, messageHashes, topic, subscriptionHashes, params);
        if (this.newUpdates) {
            const first = this.safeValue (trades, 0);
            const tradeSymbol = this.safeString (first, 'symbol');
            limit = trades.getLimit (tradeSymbol, limit);
        }
        return this.filterBySinceLimit (trades, since, limit, 'timestamp', true);
    }

    handleTrade (client: Client, message) {
        //
        //     {
        //         "data": {
        //             "sequence": "1568787654360",
        //             "symbol": "BTC-USDT",
        //             "side": "buy",
        //             "size": "0.00536577",
        //             "price": "9345",
        //             "takerOrderId": "5e356c4a9f1a790008f8d921",
        //             "time": "1580559434436443257",
        //             "type": "match",
        //             "makerOrderId": "5e356bffedf0010008fa5d7f",
        //             "tradeId": "5e356c4aeefabd62c62a1ece"
        //         },
        //         "subject": "trade.l3match",
        //         "topic": "/market/match:BTC-USDT",
        //         "type": "message"
        //     }
        //
        const data = this.safeValue (message, 'data', {});
        const trade = this.parseTrade (data);
        const symbol = trade['symbol'];
        const messageHash = 'trades:' + symbol;
        let trades = this.safeValue (this.trades, symbol);
        if (trades === undefined) {
            const limit = this.safeInteger (this.options, 'tradesLimit', 1000);
            trades = new ArrayCache (limit);
            this.trades[symbol] = trades;
        }
        trades.append (trade);
        client.resolve (trades, messageHash);
    }

    async watchOrderBook (symbol: string, limit: Int = undefined, params = {}): Promise<OrderBook> {
        /**
         * @method
         * @name kucoin#watchOrderBook
         * @see https://www.kucoin.com/docs/websocket/spot-trading/public-channels/level1-bbo-market-data
         * @see https://www.kucoin.com/docs/websocket/spot-trading/public-channels/level2-market-data
         * @see https://www.kucoin.com/docs/websocket/spot-trading/public-channels/level2-5-best-ask-bid-orders
         * @see https://www.kucoin.com/docs/websocket/spot-trading/public-channels/level2-50-best-ask-bid-orders
         * @description watches information on open orders with bid (buy) and ask (sell) prices, volumes and other data
         * @param {string} symbol unified symbol of the market to fetch the order book for
         * @param {int} [limit] the maximum amount of order book entries to return
         * @param {object} [params] extra parameters specific to the exchange API endpoint
         * @param {string} [params.method] either '/market/level2' or '/spotMarket/level2Depth5' or '/spotMarket/level2Depth50' default is '/market/level2'
         * @returns {object} A dictionary of [order book structures]{@link https://docs.ccxt.com/#/?id=order-book-structure} indexed by market symbols
         */
        //
        // https://docs.kucoin.com/#level-2-market-data
        //
        // 1. After receiving the websocket Level 2 data flow, cache the data.
        // 2. Initiate a REST request to get the snapshot data of Level 2 order book.
        // 3. Playback the cached Level 2 data flow.
        // 4. Apply the new Level 2 data flow to the local snapshot to ensure that
        // the sequence of the new Level 2 update lines up with the sequence of
        // the previous Level 2 data. Discard all the message prior to that
        // sequence, and then playback the change to snapshot.
        // 5. Update the level2 full data based on sequence according to the
        // size. If the price is 0, ignore the messages and update the sequence.
        // If the size=0, update the sequence and remove the price of which the
        // size is 0 out of level 2. Fr other cases, please update the price.
        //
        return await this.watchOrderBookForSymbols ([ symbol ], limit, params);
    }

    async watchOrderBookForSymbols (symbols: string[], limit: Int = undefined, params = {}): Promise<OrderBook> {
        /**
         * @method
         * @name kucoin#watchOrderBookForSymbols
         * @see https://www.kucoin.com/docs/websocket/spot-trading/public-channels/level1-bbo-market-data
         * @see https://www.kucoin.com/docs/websocket/spot-trading/public-channels/level2-market-data
         * @see https://www.kucoin.com/docs/websocket/spot-trading/public-channels/level2-5-best-ask-bid-orders
         * @see https://www.kucoin.com/docs/websocket/spot-trading/public-channels/level2-50-best-ask-bid-orders
         * @description watches information on open orders with bid (buy) and ask (sell) prices, volumes and other data
         * @param {string[]} symbols unified array of symbols
         * @param {int} [limit] the maximum amount of order book entries to return
         * @param {object} [params] extra parameters specific to the exchange API endpoint
         * @param {string} [params.method] either '/market/level2' or '/spotMarket/level2Depth5' or '/spotMarket/level2Depth50' default is '/market/level2'
         * @returns {object} A dictionary of [order book structures]{@link https://docs.ccxt.com/#/?id=order-book-structure} indexed by market symbols
         */
        const symbolsLength = symbols.length;
        if (symbolsLength === 0) {
            throw new ArgumentsRequired (this.id + ' watchOrderBookForSymbols() requires a non-empty array of symbols');
        }
        if (limit !== undefined) {
            if ((limit !== 20) && (limit !== 100) && (limit !== 50) && (limit !== 5)) {
                throw new ExchangeError (this.id + " watchOrderBook 'limit' argument must be undefined, 5, 20, 50 or 100");
            }
        }
        await this.loadMarkets ();
        symbols = this.marketSymbols (symbols);
        const marketIds = this.marketIds (symbols);
        const url = await this.negotiate (false);
        let method: Str = undefined;
        [ method, params ] = this.handleOptionAndParams (params, 'watchOrderBook', 'method', '/market/level2');
        if ((limit === 5) || (limit === 50)) {
            method = '/spotMarket/level2Depth' + limit.toString ();
        }
        const topic = method + ':' + marketIds.join (',');
        const messageHashes = [];
        const subscriptionHashes = [];
        for (let i = 0; i < symbols.length; i++) {
            const symbol = symbols[i];
            messageHashes.push ('orderbook:' + symbol);
            const marketId = marketIds[i];
            subscriptionHashes.push (method + ':' + marketId);
        }
        let subscription = {};
        if (method === '/market/level2') { // other streams return the entire orderbook, so we don't need to fetch the snapshot through REST
            subscription = {
                'method': this.handleOrderBookSubscription,
                'symbols': symbols,
                'limit': limit,
            };
        }
        const orderbook = await this.subscribeMultiple (url, messageHashes, topic, subscriptionHashes, params, subscription);
        return orderbook.limit ();
    }

    handleOrderBook (client: Client, message) {
        //
        // initial snapshot is fetched with ccxt's fetchOrderBook
        // the feed does not include a snapshot, just the deltas
        //
        //     {
        //         "type":"message",
        //         "topic":"/market/level2:BTC-USDT",
        //         "subject":"trade.l2update",
        //         "data":{
        //             "sequenceStart":1545896669105,
        //             "sequenceEnd":1545896669106,
        //             "symbol":"BTC-USDT",
        //             "changes": {
        //                 "asks": [["6","1","1545896669105"]], // price, size, sequence
        //                 "bids": [["4","1","1545896669106"]]
        //             }
        //         }
        //     }
        //
        //     {
        //         "topic": "/spotMarket/level2Depth5:BTC-USDT",
        //         "type": "message",
        //         "data": {
        //             "asks": [
        //                 [
        //                     "42815.6",
        //                     "1.24016245"
        //                 ]
        //             ],
        //             "bids": [
        //                 [
        //                     "42815.5",
        //                     "0.08652716"
        //                 ]
        //             ],
        //             "timestamp": 1707204474018
        //         },
        //         "subject": "level2"
        //     }
        //
        const data = this.safeValue (message, 'data');
        const subject = this.safeString (message, 'subject');
        const topic = this.safeString (message, 'topic');
        const topicParts = topic.split (':');
        const topicSymbol = this.safeString (topicParts, 1);
        const topicChannel = this.safeString (topicParts, 0);
        const marketId = this.safeString (data, 'symbol', topicSymbol);
        const symbol = this.safeSymbol (marketId, undefined, '-');
        const messageHash = 'orderbook:' + symbol;
        // let orderbook = this.safeDict (this.orderbooks, symbol);
        if (subject === 'level2') {
            if (!(symbol in this.orderbooks)) {
                this.orderbooks[symbol] = this.orderBook ();
            } else {
                const orderbook = this.orderbooks[symbol];
                orderbook.reset ();
            }
            this.orderbooks[symbol]['symbol'] = symbol;
        } else {
            if (!(symbol in this.orderbooks)) {
                this.orderbooks[symbol] = this.orderBook ();
            }
            const orderbook = this.orderbooks[symbol];
            const nonce = this.safeInteger (orderbook, 'nonce');
            const deltaEnd = this.safeInteger2 (data, 'sequenceEnd', 'timestamp');
            if (nonce === undefined) {
                const cacheLength = orderbook.cache.length;
                const subscriptions = Object.keys (client.subscriptions);
                let subscription = undefined;
                for (let i = 0; i < subscriptions.length; i++) {
                    const key = subscriptions[i];
                    if ((key.indexOf (topicSymbol) >= 0) && (key.indexOf (topicChannel) >= 0)) {
                        subscription = client.subscriptions[key];
                        break;
                    }
                }
                const limit = this.safeInteger (subscription, 'limit');
                const snapshotDelay = this.handleOption ('watchOrderBook', 'snapshotDelay', 5);
                if (cacheLength === snapshotDelay) {
                    this.spawn (this.loadOrderBook, client, messageHash, symbol, limit, {});
                }
                orderbook.cache.push (data);
                return;
            } else if (nonce >= deltaEnd) {
                return;
            }
        }
        this.handleDelta (this.orderbooks[symbol], data);
        client.resolve (this.orderbooks[symbol], messageHash);
    }

    getCacheIndex (orderbook, cache) {
        const firstDelta = this.safeValue (cache, 0);
        const nonce = this.safeInteger (orderbook, 'nonce');
        const firstDeltaStart = this.safeInteger (firstDelta, 'sequenceStart');
        if (nonce < firstDeltaStart - 1) {
            return -1;
        }
        for (let i = 0; i < cache.length; i++) {
            const delta = cache[i];
            const deltaStart = this.safeInteger (delta, 'sequenceStart');
            const deltaEnd = this.safeInteger (delta, 'sequenceEnd');
            if ((nonce >= deltaStart - 1) && (nonce < deltaEnd)) {
                return i;
            }
        }
        return cache.length;
    }

    handleDelta (orderbook, delta) {
        const timestamp = this.safeInteger2 (delta, 'time', 'timestamp');
        orderbook['nonce'] = this.safeInteger (delta, 'sequenceEnd', timestamp);
        orderbook['timestamp'] = timestamp;
        orderbook['datetime'] = this.iso8601 (timestamp);
        const changes = this.safeValue (delta, 'changes', delta);
        const bids = this.safeValue (changes, 'bids', []);
        const asks = this.safeValue (changes, 'asks', []);
        const storedBids = orderbook['bids'];
        const storedAsks = orderbook['asks'];
        this.handleBidAsks (storedBids, bids);
        this.handleBidAsks (storedAsks, asks);
    }

    handleBidAsks (bookSide, bidAsks) {
        for (let i = 0; i < bidAsks.length; i++) {
            const bidAsk = this.parseBidAsk (bidAsks[i]);
            bookSide.storeArray (bidAsk);
        }
    }

    handleOrderBookSubscription (client: Client, message, subscription) {
        const limit = this.safeInteger (subscription, 'limit');
        const symbols = this.safeValue (subscription, 'symbols');
        if (symbols === undefined) {
            const symbol = this.safeString (subscription, 'symbol');
            this.orderbooks[symbol] = this.orderBook ({}, limit);
        } else {
            for (let i = 0; i < symbols.length; i++) {
                const symbol = symbols[i];
                this.orderbooks[symbol] = this.orderBook ({}, limit);
            }
        }
        // moved snapshot initialization to handleOrderBook to fix
        // https://github.com/ccxt/ccxt/issues/6820
        // the general idea is to fetch the snapshot after the first delta
        // but not before, because otherwise we cannot synchronize the feed
    }

    handleSubscriptionStatus (client: Client, message) {
        //
        //     {
        //         "id": "1578090438322",
        //         "type": "ack"
        //     }
        //
        const id = this.safeString (message, 'id');
        if (!(id in client.subscriptions)) {
            return;
        }
        const subscriptionHash = this.safeString (client.subscriptions, id);
        const subscription = this.safeValue (client.subscriptions, subscriptionHash);
        delete client.subscriptions[id];
        const method = this.safeValue (subscription, 'method');
        if (method !== undefined) {
            method.call (this, client, message, subscription);
        }
    }

    handleSystemStatus (client: Client, message) {
        //
        // todo: answer the question whether handleSystemStatus should be renamed
        // and unified as handleStatus for any usage pattern that
        // involves system status and maintenance updates
        //
        //     {
        //         "id": "1578090234088", // connectId
        //         "type": "welcome",
        //     }
        //
        return message;
    }

    async watchOrders (symbol: Str = undefined, since: Int = undefined, limit: Int = undefined, params = {}): Promise<Order[]> {
        /**
         * @method
         * @name kucoin#watchOrders
         * @description watches information on multiple orders made by the user
         * @param {string} symbol unified market symbol of the market orders were made in
         * @param {int} [since] the earliest time in ms to fetch orders for
         * @param {int} [limit] the maximum number of order structures to retrieve
         * @param {object} [params] extra parameters specific to the exchange API endpoint
         * @param {boolean} [params.stop] trigger orders are watched if true
         * @returns {object[]} a list of [order structures]{@link https://docs.ccxt.com/#/?id=order-structure}
         */
        await this.loadMarkets ();
        const stop = this.safeValue2 (params, 'stop', 'trigger');
        params = this.omit (params, [ 'stop', 'trigger' ]);
        const url = await this.negotiate (true);
        const topic = stop ? '/spotMarket/advancedOrders' : '/spotMarket/tradeOrders';
        const request = {
            'privateChannel': true,
        };
        let messageHash = 'orders';
        if (symbol !== undefined) {
            const market = this.market (symbol);
            symbol = market['symbol'];
            messageHash = messageHash + ':' + symbol;
        }
        const orders = await this.subscribe (url, messageHash, topic, this.extend (request, params));
        if (this.newUpdates) {
            limit = orders.getLimit (symbol, limit);
        }
        return this.filterBySymbolSinceLimit (orders, symbol, since, limit, true);
    }

    parseWsOrderStatus (status) {
        const statuses = {
            'open': 'open',
            'filled': 'closed',
            'match': 'open',
            'update': 'open',
            'canceled': 'canceled',
            'cancel': 'canceled',
            'TRIGGERED': 'triggered',
        };
        return this.safeString (statuses, status, status);
    }

    parseWsOrder (order, market = undefined) {
        //
        // /spotMarket/tradeOrders
        //
        //    {
        //        "symbol": "XCAD-USDT",
        //        "orderType": "limit",
        //        "side": "buy",
        //        "orderId": "6249167327218b000135e749",
        //        "type": "canceled",
        //        "orderTime": 1648957043065280224,
        //        "size": "100.452",
        //        "filledSize": "0",
        //        "price": "2.9635",
        //        "clientOid": "buy-XCAD-USDT-1648957043010159",
        //        "remainSize": "0",
        //        "status": "done",
        //        "ts": 1648957054031001037
        //    }
        //
        // /spotMarket/advancedOrders
        //
        //    {
        //        "createdAt": 1589789942337,
        //        "orderId": "5ec244f6a8a75e0009958237",
        //        "orderPrice": "0.00062",
        //        "orderType": "stop",
        //        "side": "sell",
        //        "size": "1",
        //        "stop": "entry",
        //        "stopPrice": "0.00062",
        //        "symbol": "KCS-BTC",
        //        "tradeType": "TRADE",
        //        "triggerSuccess": true,
        //        "ts": 1589790121382281286,
        //        "type": "triggered"
        //    }
        //
        const rawType = this.safeString (order, 'type');
        let status = this.parseWsOrderStatus (rawType);
        const timestamp = this.safeInteger2 (order, 'orderTime', 'createdAt');
        const marketId = this.safeString (order, 'symbol');
        market = this.safeMarket (marketId, market);
        const triggerPrice = this.safeString (order, 'stopPrice');
        const triggerSuccess = this.safeValue (order, 'triggerSuccess');
        const triggerFail = (triggerSuccess !== true) && (triggerSuccess !== undefined);  // TODO: updated to triggerSuccess === False once transpiler transpiles it correctly
        if ((status === 'triggered') && triggerFail) {
            status = 'canceled';
        }
        return this.safeOrder ({
            'info': order,
            'symbol': market['symbol'],
            'id': this.safeString (order, 'orderId'),
            'clientOrderId': this.safeString (order, 'clientOid'),
            'timestamp': timestamp,
            'datetime': this.iso8601 (timestamp),
            'lastTradeTimestamp': undefined,
            'type': this.safeStringLower (order, 'orderType'),
            'timeInForce': undefined,
            'postOnly': undefined,
            'side': this.safeStringLower (order, 'side'),
            'price': this.safeString2 (order, 'price', 'orderPrice'),
            'stopPrice': triggerPrice,
            'triggerPrice': triggerPrice,
            'amount': this.safeString (order, 'size'),
            'cost': undefined,
            'average': undefined,
            'filled': this.safeString (order, 'filledSize'),
            'remaining': undefined,
            'status': status,
            'fee': undefined,
            'trades': undefined,
        }, market);
    }

    handleOrder (client: Client, message) {
        //
        // Trigger Orders
        //
        //    {
        //        "createdAt": 1692745706437,
        //        "error": "Balance insufficient!",       // not always there
        //        "orderId": "vs86kp757vlda6ni003qs70v",
        //        "orderPrice": "0.26",
        //        "orderType": "stop",
        //        "side": "sell",
        //        "size": "5",
        //        "stop": "loss",
        //        "stopPrice": "0.26",
        //        "symbol": "ADA-USDT",
        //        "tradeType": "TRADE",
        //        "triggerSuccess": false,                // not always there
        //        "ts": "1692745706442929298",
        //        "type": "open"
        //    }
        //
        const messageHash = 'orders';
        const data = this.safeValue (message, 'data');
        const parsed = this.parseWsOrder (data);
        const symbol = this.safeString (parsed, 'symbol');
        const orderId = this.safeString (parsed, 'id');
        const triggerPrice = this.safeValue (parsed, 'triggerPrice');
        const isTriggerOrder = (triggerPrice !== undefined);
        if (this.orders === undefined) {
            const limit = this.safeInteger (this.options, 'ordersLimit', 1000);
            this.orders = new ArrayCacheBySymbolById (limit);
            this.triggerOrders = new ArrayCacheBySymbolById (limit);
        }
        const cachedOrders = isTriggerOrder ? this.triggerOrders : this.orders;
        const orders = this.safeValue (cachedOrders.hashmap, symbol, {});
        const order = this.safeValue (orders, orderId);
        if (order !== undefined) {
            // todo add others to calculate average etc
            if (order['status'] === 'closed') {
                parsed['status'] = 'closed';
            }
        }
        cachedOrders.append (parsed);
        client.resolve (cachedOrders, messageHash);
        const symbolSpecificMessageHash = messageHash + ':' + symbol;
        client.resolve (cachedOrders, symbolSpecificMessageHash);
    }

    async watchMyTrades (symbol: Str = undefined, since: Int = undefined, limit: Int = undefined, params = {}): Promise<Trade[]> {
        /**
         * @method
         * @name kucoin#watchMyTrades
         * @description watches information on multiple trades made by the user
         * @param {string} symbol unified market symbol of the market trades were made in
         * @param {int} [since] the earliest time in ms to fetch trades for
         * @param {int} [limit] the maximum number of trade structures to retrieve
         * @param {object} [params] extra parameters specific to the exchange API endpoint
         * @returns {object[]} a list of [trade structures]{@link https://docs.ccxt.com/#/?id=trade-structure
         */
        await this.loadMarkets ();
        const url = await this.negotiate (true);
        const topic = '/spot/tradeFills';
        const request = {
            'privateChannel': true,
        };
        let messageHash = 'myTrades';
        if (symbol !== undefined) {
            const market = this.market (symbol);
            symbol = market['symbol'];
            messageHash = messageHash + ':' + market['symbol'];
        }
        const trades = await this.subscribe (url, messageHash, topic, this.extend (request, params));
        if (this.newUpdates) {
            limit = trades.getLimit (symbol, limit);
        }
        return this.filterBySymbolSinceLimit (trades, symbol, since, limit, true);
    }

    handleMyTrade (client: Client, message) {
        if (this.myTrades === undefined) {
            const limit = this.safeInteger (this.options, 'tradesLimit', 1000);
            this.myTrades = new ArrayCacheBySymbolById (limit);
        }
        const data = this.safeDict (message, 'data');
        const parsed = this.parseWsTrade (data);
        this.myTrades.append (parsed);
        const messageHash = 'myTrades';
        client.resolve (this.myTrades, messageHash);
        const symbolSpecificMessageHash = messageHash + ':' + parsed['symbol'];
        client.resolve (this.myTrades, symbolSpecificMessageHash);
    }

    parseWsTrade (trade, market = undefined) {
        //
        // {
        //     "fee": 0.00262148,
        //     "feeCurrency": "USDT",
        //     "feeRate": 0.001,
        //     "orderId": "62417436b29df8000183df2f",
        //     "orderType": "market",
        //     "price": 131.074,
        //     "side": "sell",
        //     "size": 0.02,
        //     "symbol": "LTC-USDT",
        //     "time": "1648456758734571745",
        //     "tradeId": "624174362e113d2f467b3043"
        //   }
        //
        const marketId = this.safeString (trade, 'symbol');
        market = this.safeMarket (marketId, market, '-');
        const symbol = market['symbol'];
        const type = this.safeString (trade, 'orderType');
        const side = this.safeString (trade, 'side');
        const tradeId = this.safeString (trade, 'tradeId');
        const price = this.safeString (trade, 'price');
        const amount = this.safeString (trade, 'size');
        const order = this.safeString (trade, 'orderId');
        const timestamp = this.safeIntegerProduct (trade, 'time', 0.000001);
        const feeCurrency = market['quote'];
        const feeRate = this.safeString (trade, 'feeRate');
        const feeCost = this.safeString (trade, 'fee');
        const fee = {
            'cost': feeCost,
            'rate': feeRate,
            'currency': feeCurrency,
        };
        return this.safeTrade ({
            'info': trade,
            'timestamp': timestamp,
            'datetime': this.iso8601 (timestamp),
            'symbol': symbol,
            'id': tradeId,
            'order': order,
            'type': type,
            'takerOrMaker': undefined,
            'side': side,
            'price': price,
            'amount': amount,
            'cost': undefined,
            'fee': fee,
        }, market);
    }

    async watchBalance (params = {}): Promise<Balances> {
        /**
         * @method
         * @name kucoin#watchBalance
         * @description watch balance and get the amount of funds available for trading or funds locked in orders
         * @param {object} [params] extra parameters specific to the exchange API endpoint
         * @returns {object} a [balance structure]{@link https://docs.ccxt.com/#/?id=balance-structure}
         */
        await this.loadMarkets ();
        const url = await this.negotiate (true);
        const topic = '/account/balance';
        const request = {
            'privateChannel': true,
        };
        const messageHash = 'balance';
        return await this.subscribe (url, messageHash, topic, this.extend (request, params));
    }

    handleBalance (client: Client, message) {
        //
        // {
        //     "id":"6217a451294b030001e3a26a",
        //     "type":"message",
        //     "topic":"/account/balance",
        //     "userId":"6217707c52f97f00012a67db",
        //     "channelType":"private",
        //     "subject":"account.balance",
        //     "data":{
        //        "accountId":"62177fe67810720001db2f18",
        //        "available":"89",
        //        "availableChange":"-30",
        //        "currency":"USDT",
        //        "hold":"0",
        //        "holdChange":"0",
        //        "relationContext":{
        //        },
        //        "relationEvent":"main.transfer",
        //        "relationEventId":"6217a451294b030001e3a26a",
        //        "time":"1645716561816",
        //        "total":"89"
        //     }
        //
        const data = this.safeValue (message, 'data', {});
        const messageHash = 'balance';
        const currencyId = this.safeString (data, 'currency');
        const relationEvent = this.safeString (data, 'relationEvent');
        let requestAccountType = undefined;
        if (relationEvent !== undefined) {
            const relationEventParts = relationEvent.split ('.');
            requestAccountType = this.safeString (relationEventParts, 0);
        }
        const selectedType = this.safeString2 (this.options, 'watchBalance', 'defaultType', 'trade'); // trade, main, margin or other
        const accountsByType = this.safeValue (this.options, 'accountsByType');
        const uniformType = this.safeString (accountsByType, requestAccountType, 'trade');
        if (!(uniformType in this.balance)) {
            this.balance[uniformType] = {};
        }
        this.balance[uniformType]['info'] = data;
        const timestamp = this.safeInteger (data, 'time');
        this.balance[uniformType]['timestamp'] = timestamp;
        this.balance[uniformType]['datetime'] = this.iso8601 (timestamp);
        const code = this.safeCurrencyCode (currencyId);
        const account = this.account ();
        account['free'] = this.safeString (data, 'available');
        account['used'] = this.safeString (data, 'hold');
        account['total'] = this.safeString (data, 'total');
        this.balance[uniformType][code] = account;
        this.balance[uniformType] = this.safeBalance (this.balance[uniformType]);
        if (uniformType === selectedType) {
            client.resolve (this.balance[uniformType], messageHash);
        }
    }

    handleSubject (client: Client, message) {
        //
        //     {
        //         "type":"message",
        //         "topic":"/market/level2:BTC-USDT",
        //         "subject":"trade.l2update",
        //         "data":{
        //             "sequenceStart":1545896669105,
        //             "sequenceEnd":1545896669106,
        //             "symbol":"BTC-USDT",
        //             "changes": {
        //                 "asks": [["6","1","1545896669105"]], // price, size, sequence
        //                 "bids": [["4","1","1545896669106"]]
        //             }
        //         }
        //     }
        //
        const topic = this.safeString (message, 'topic');
        if (topic === '/market/ticker:all') {
            this.handleTicker (client, message);
            return;
        }
        const subject = this.safeString (message, 'subject');
        const methods = {
            'level1': this.handleBidAsk,
            'level2': this.handleOrderBook,
            'trade.l2update': this.handleOrderBook,
            'trade.ticker': this.handleTicker,
            'trade.snapshot': this.handleTicker,
            'trade.l3match': this.handleTrade,
            'trade.candles.update': this.handleOHLCV,
            'account.balance': this.handleBalance,
            '/spot/tradeFills': this.handleMyTrade,
            'orderChange': this.handleOrder,
            'stopOrder': this.handleOrder,
        };
        const method = this.safeValue (methods, subject);
        if (method !== undefined) {
            method.call (this, client, message);
        }
    }

    ping (client) {
        // kucoin does not support built-in ws protocol-level ping-pong
        // instead it requires a custom json-based text ping-pong
        // https://docs.kucoin.com/#ping
        const id = this.requestId ().toString ();
        return {
            'id': id,
            'type': 'ping',
        };
    }

    handlePong (client: Client, message) {
        client.lastPong = this.milliseconds ();
        // https://docs.kucoin.com/#ping
    }

    handleErrorMessage (client: Client, message) {
        //
        //    {
        //        "id": "1",
        //        "type": "error",
        //        "code": 415,
        //        "data": "type is not supported"
        //    }
        //
        const data = this.safeString (message, 'data', '');
        if (data === 'token is expired') {
            let type = 'public';
            if (client.url.indexOf ('connectId=private') >= 0) {
                type = 'private';
            }
            this.options['urls'][type] = undefined;
        }
        this.handleErrors (undefined, undefined, client.url, undefined, undefined, data, message, undefined, undefined);
    }

    handleMessage (client: Client, message) {
        const type = this.safeString (message, 'type');
        const methods = {
            // 'heartbeat': this.handleHeartbeat,
            'welcome': this.handleSystemStatus,
            'ack': this.handleSubscriptionStatus,
            'message': this.handleSubject,
            'pong': this.handlePong,
            'error': this.handleErrorMessage,
        };
        const method = this.safeValue (methods, type);
        if (method !== undefined) {
            method.call (this, client, message);
        }
    }
}
