// ============================================================
// data.js — Binance API Layer
// REST endpoints + WebSocket stream classes
// ============================================================

import { formatPrice } from "./utils.js";

const BASE_URL = "https://api.binance.com/api/v3";

// --------------- Cache for exchange info ---------------
let _exchangeInfoCache = null;

// ======================= REST API =======================

/**
 * Fetch kline (candlestick) data from Binance.
 * @param {string} symbol   e.g. "BTCUSDT"
 * @param {string} interval e.g. "1h", "15m", "1d"
 * @param {number} limit    max 1000
 * @returns {Promise<Array<{time:number, open:number, high:number, low:number, close:number, volume:number}>>}
 */
export async function fetchKlines(
  symbol,
  interval,
  limit = 1000,
  endTime = null,
) {
  let allKlines = [];
  let currentEndTime = endTime;
  let remaining = limit;

  while (remaining > 0) {
    const fetchCount = Math.min(remaining, 1000);
    let url = `${BASE_URL}/klines?symbol=${encodeURIComponent(symbol)}&interval=${encodeURIComponent(interval)}&limit=${fetchCount}`;
    if (currentEndTime) {
      url += `&endTime=${currentEndTime}`;
    }
    
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`fetchKlines failed: ${response.status} ${response.statusText}`);
    }
    
    const raw = await response.json();
    if (raw.length === 0) break;

    // Binance returns chronological [oldest, ..., newest]. We prepend to our list.
    allKlines = raw.concat(allKlines);
    remaining -= raw.length;
    
    // Set next batch's endTime to just before the earliest candle in this batch
    currentEndTime = raw[0][0] - 1;

    // If we received fewer than we asked for, we hit the beginning of the market history
    if (raw.length < fetchCount) break;
  }

  return allKlines.map((k) => {
    const vol = parseFloat(k[5]);
    const takerBuy = parseFloat(k[9]);
    return {
      time: Math.floor(k[0] / 1000), // ms -> s for lightweight-charts
      open: parseFloat(k[1]),
      high: parseFloat(k[2]),
      low: parseFloat(k[3]),
      close: parseFloat(k[4]),
      volume: vol,
      delta: (2 * takerBuy) - vol, // Cumulative Volume Delta
    };
  });
}

/**
 * Fetch 24-hour ticker stats.
 * @param {string} symbol
 * @returns {Promise<{lastPrice:number, priceChange:number, priceChangePercent:number, highPrice:number, lowPrice:number, volume:number, quoteVolume:number}>}
 */
export async function fetchTicker24h(symbol) {
  const url = `${BASE_URL}/ticker/24hr?symbol=${encodeURIComponent(symbol)}`;
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(
      `fetchTicker24h failed: ${response.status} ${response.statusText}`,
    );
  }

  const d = await response.json();

  return {
    lastPrice: parseFloat(d.lastPrice),
    priceChange: parseFloat(d.priceChange),
    priceChangePercent: parseFloat(d.priceChangePercent),
    highPrice: parseFloat(d.highPrice),
    lowPrice: parseFloat(d.lowPrice),
    volume: parseFloat(d.volume),
    quoteVolume: parseFloat(d.quoteVolume),
  };
}

/**
 * Fetch best bid/ask from the order book.
 * @param {string} symbol
 * @returns {Promise<{bidPrice:number, bidQty:number, askPrice:number, askQty:number}>}
 */
export async function fetchBookTicker(symbol) {
  const url = `${BASE_URL}/ticker/bookTicker?symbol=${encodeURIComponent(symbol)}`;
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(
      `fetchBookTicker failed: ${response.status} ${response.statusText}`,
    );
  }

  const d = await response.json();

  return {
    bidPrice: parseFloat(d.bidPrice),
    bidQty: parseFloat(d.bidQty),
    askPrice: parseFloat(d.askPrice),
    askQty: parseFloat(d.askQty),
  };
}

/**
 * Fetch and cache exchange info — returns USDT trading pairs.
 * @returns {Promise<Array<{symbol:string, baseAsset:string, quoteAsset:string}>>}
 */
export async function fetchExchangeInfo() {
  if (_exchangeInfoCache) return _exchangeInfoCache;

  const url = `${BASE_URL}/exchangeInfo`;
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(
      `fetchExchangeInfo failed: ${response.status} ${response.statusText}`,
    );
  }

  const data = await response.json();

  _exchangeInfoCache = data.symbols
    .filter((s) => s.quoteAsset === "USDT" && s.status === "TRADING")
    .map((s) => ({
      symbol: s.symbol,
      baseAsset: s.baseAsset,
      quoteAsset: s.quoteAsset,
    }));

  return _exchangeInfoCache;
}

// ====================== WebSocket Streams ======================

/**
 * Real-time kline (candlestick) stream with auto-reconnect.
 */
export class BinanceKlineStream {
  /**
   * @param {Function} onUpdate — receives { time, open, high, low, close, volume, isClosed }
   */
  constructor(onUpdate) {
    this.ws = null;
    this.onUpdate = onUpdate;
    this.symbol = null;
    this.interval = null;
    this.reconnectAttempts = 0;
    this.maxReconnects = 5;
    this.reconnectDelay = 1000;
    this._reconnectTimer = null;
  }

  /**
   * Connect to a kline stream for the given symbol/interval.
   * Automatically disconnects any existing connection first.
   */
  connect(symbol, interval) {
    this.disconnect();
    this.symbol = symbol.toLowerCase();
    this.interval = interval;
    this.reconnectAttempts = 0;

    this._open();
  }

  /** @private */
  _open() {
    const url = `wss://stream.binance.com:9443/ws/${this.symbol}@kline_${this.interval}`;
    this.ws = new WebSocket(url);

    this.ws.onopen = () => {
      this.reconnectAttempts = 0;
      this.reconnectDelay = 1000;
    };

    this.ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
          if (msg.e === "kline") {
            const k = msg.k;
            const vol = parseFloat(k.v);
            const takerBuy = parseFloat(k.V);
            this.onUpdate({
              time: Math.floor(k.t / 1000),
              open: parseFloat(k.o),
              high: parseFloat(k.h),
              low: parseFloat(k.l),
              close: parseFloat(k.c),
              volume: vol,
              delta: (2 * takerBuy) - vol,
              isClosed: k.x,
            });
          }
      } catch (err) {
        console.warn("Kline WS message parse error:", err);
      }
    };

    this.ws.onclose = () => {
      this._scheduleReconnect();
    };

    this.ws.onerror = (err) => {
      console.error("Kline WS error:", err);
    };
  }

  /** @private — exponential back-off reconnect */
  _scheduleReconnect() {
    if (this.reconnectAttempts >= this.maxReconnects) {
      console.warn("Kline WS: max reconnect attempts reached");
      return;
    }
    this.reconnectAttempts++;
    const delay = this.reconnectDelay * Math.pow(2, this.reconnectAttempts - 1);
    console.log(
      `Kline WS: reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`,
    );
    this._reconnectTimer = setTimeout(() => this._open(), delay);
  }

  /** Cleanly disconnect — prevents auto-reconnect. */
  disconnect() {
    clearTimeout(this._reconnectTimer);
    if (this.ws) {
      this.ws.onclose = null; // prevent auto-reconnect
      this.ws.close();
      this.ws = null;
    }
    this.reconnectAttempts = 0;
  }
}

/**
 * All-market mini ticker stream (used for watchlist updates).
 */
export class BinanceMiniTickerStream {
  /**
   * @param {Function} onUpdate — receives array of { symbol, lastPrice, priceChangePercent, volume, quoteVolume }
   */
  constructor(onUpdate) {
    this.ws = null;
    this.onUpdate = onUpdate;
    this._reconnectTimer = null;
    this.reconnectAttempts = 0;
    this.maxReconnects = 5;
  }

  connect() {
    this.disconnect();
    this.reconnectAttempts = 0;

    const url = "wss://stream.binance.com:9443/ws/!miniTicker@arr";
    this.ws = new WebSocket(url);

    this.ws.onopen = () => {
      this.reconnectAttempts = 0;
    };

    this.ws.onmessage = (event) => {
      try {
        const tickers = JSON.parse(event.data);
        const mapped = tickers.map((t) => ({
          symbol: t.s,
          lastPrice: parseFloat(t.c),
          priceChangePercent: 0, // miniTicker doesn't include %, tracked externally
          volume: parseFloat(t.v),
          quoteVolume: parseFloat(t.q),
        }));
        this.onUpdate(mapped);
      } catch (err) {
        console.warn("MiniTicker WS message parse error:", err);
      }
    };

    this.ws.onclose = () => {
      if (this.reconnectAttempts < this.maxReconnects) {
        this.reconnectAttempts++;
        const delay = 1000 * Math.pow(2, this.reconnectAttempts - 1);
        this._reconnectTimer = setTimeout(() => this.connect(), delay);
      }
    };

    this.ws.onerror = (err) => {
      console.error("MiniTicker WS error:", err);
    };
  }

  disconnect() {
    clearTimeout(this._reconnectTimer);
    if (this.ws) {
      this.ws.onclose = null;
      this.ws.close();
      this.ws = null;
    }
    this.reconnectAttempts = 0;
  }
}

/**
 * Real-time best bid/ask stream for a single symbol.
 */
export class BinanceBookTickerStream {
  /**
   * @param {Function} onUpdate — receives { bidPrice, askPrice, bidQty, askQty }
   */
  constructor(onUpdate) {
    this.ws = null;
    this.onUpdate = onUpdate;
    this._reconnectTimer = null;
    this.reconnectAttempts = 0;
    this.maxReconnects = 5;
    this.symbol = null;
  }

  /**
   * Connect to the book ticker stream for one symbol.
   * @param {string} symbol — lowercase, e.g. "btcusdt"
   */
  connect(symbol) {
    this.disconnect();
    this.symbol = symbol.toLowerCase();
    this.reconnectAttempts = 0;

    const url = `wss://stream.binance.com:9443/ws/${this.symbol}@bookTicker`;
    this.ws = new WebSocket(url);

    this.ws.onopen = () => {
      this.reconnectAttempts = 0;
    };

    this.ws.onmessage = (event) => {
      try {
        const d = JSON.parse(event.data);
        this.onUpdate({
          bidPrice: parseFloat(d.b),
          askPrice: parseFloat(d.a),
          bidQty: parseFloat(d.B),
          askQty: parseFloat(d.A),
        });
      } catch (err) {
        console.warn("BookTicker WS parse error:", err);
      }
    };

    this.ws.onclose = () => {
      if (this.reconnectAttempts < this.maxReconnects) {
        this.reconnectAttempts++;
        const delay = 1000 * Math.pow(2, this.reconnectAttempts - 1);
        this._reconnectTimer = setTimeout(
          () => this.connect(this.symbol),
          delay,
        );
      }
    };

    this.ws.onerror = (err) => {
      console.error("BookTicker WS error:", err);
    };
  }

  disconnect() {
    clearTimeout(this._reconnectTimer);
    if (this.ws) {
      this.ws.onclose = null;
      this.ws.close();
      this.ws = null;
    }
    this.reconnectAttempts = 0;
  }
}

/**
 * Real-time 24hr ticker stream for a single symbol.
 */
export class BinanceSingleTickerStream {
  constructor(onUpdate) {
    this.ws = null;
    this.onUpdate = onUpdate;
    this.symbol = null;
    this.reconnectAttempts = 0;
    this.maxReconnects = 5;
    this._reconnectTimer = null;
  }

  connect(symbol) {
    this.disconnect();
    this.symbol = symbol.toLowerCase();
    this.reconnectAttempts = 0;

    const url = `wss://stream.binance.com:9443/ws/${this.symbol}@ticker`;
    this.ws = new WebSocket(url);

    this.ws.onopen = () => {
      this.reconnectAttempts = 0;
    };

    this.ws.onmessage = (event) => {
      try {
        const d = JSON.parse(event.data);
        this.onUpdate({
          lastPrice: parseFloat(d.c),
          priceChange: parseFloat(d.p),
          priceChangePercent: parseFloat(d.P),
          volume: parseFloat(d.v),
          quoteVolume: parseFloat(d.q),
        });
      } catch (err) {
        console.warn("Ticker WS parse error:", err);
      }
    };

    this.ws.onclose = () => {
      if (this.reconnectAttempts < this.maxReconnects) {
        this.reconnectAttempts++;
        const delay = 1000 * Math.pow(2, this.reconnectAttempts - 1);
        this._reconnectTimer = setTimeout(
          () => this.connect(this.symbol),
          delay,
        );
      }
    };

    this.ws.onerror = (err) => {
      console.error("Ticker WS error:", err);
    };
  }

  disconnect() {
    clearTimeout(this._reconnectTimer);
    if (this.ws) {
      this.ws.onclose = null;
      this.ws.close();
      this.ws = null;
    }
    this.reconnectAttempts = 0;
  }
}

/**
 * WebSocket stream for real-time Futures Liquidations (Rekt Map).
 * Connects to fstream.binance.com
 */
export class BinanceLiquidationStream {
  constructor(onLiquidation) {
    this.ws = null;
    this.symbol = null;
    this.onLiquidation = onLiquidation;
    this.reconnectAttempts = 0;
    this.maxReconnects = 5;
    this._reconnectTimer = null;
  }

  connect(symbol) {
    this.disconnect();
    this.symbol = symbol.toLowerCase();
    
    // Connect to futures stream for force orders
    const wsUrl = "wss://fstream.binance.com/ws/${this.symbol}@forceOrder";
    this.ws = new WebSocket(wsUrl);

    this.ws.onopen = () => {
      this.reconnectAttempts = 0;
    };

    this.ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.e === "forceOrder") {
          const order = data.o;
          const price = parseFloat(order.p);
          const quantity = parseFloat(order.q);
          const usdValue = price * quantity;
          
          this.onLiquidation({
            time: Math.floor(data.E / 1000), // convert ms to s for lightweight-charts
            side: order.S, // 'BUY' (Short liquidated) or 'SELL' (Long liquidated)
            price: price,
            quantity: quantity,
            usdValue: usdValue
          });
        }
      } catch (err) {
        console.warn("Liquidation WS parse error:", err);
      }
    };

    this.ws.onclose = () => {
      if (this.reconnectAttempts < this.maxReconnects) {
        this.reconnectAttempts++;
        const delay = 1000 * Math.pow(2, this.reconnectAttempts - 1);
        this._reconnectTimer = setTimeout(() => this.connect(this.symbol), delay);
      }
    };

    this.ws.onerror = (err) => {
      console.error("Liquidation WS error:", err);
    };
  }

  disconnect() {
    clearTimeout(this._reconnectTimer);
    if (this.ws) {
      this.ws.onclose = null;
      this.ws.close();
      this.ws = null;
    }
    this.reconnectAttempts = 0;
  }
}




