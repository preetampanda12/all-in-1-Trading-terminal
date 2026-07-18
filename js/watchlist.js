// ============================================================
// watchlist.js — Watchlist Manager
// Renders, filters, and live-updates the sidebar watchlist
// ============================================================

import { formatPrice, formatPercent } from "./utils.js";
import { fetchTicker24h } from "./data.js";

const DEFAULT_WATCHLIST = [
  "BTCUSDT",
  "ETHUSDT",
  "SOLUSDT",
  "BNBUSDT",
  "XRPUSDT",
  "DOGEUSDT",
  "ADAUSDT",
  "AVAXUSDT",
  "DOTUSDT",
  "LINKUSDT",
];

export class WatchlistManager {
  /**
   * @param {string}   itemsContainerId — DOM id of the watchlist items wrapper
   * @param {string}   searchInputId    — DOM id of the search input
   * @param {Function} onSymbolSelect   — callback(symbol) when user clicks
   */
  constructor(itemsContainerId, searchInputId, onSymbolSelect) {
    this.container = document.getElementById(itemsContainerId);
    this.searchInput = document.getElementById(searchInputId);
    this.onSymbolSelect = onSymbolSelect;

    this.activeSymbol = "BTCUSDT";
    this.symbols = [...DEFAULT_WATCHLIST];
    this.tickerData = new Map(); // symbol → { lastPrice, priceChangePercent, prevPrice? }
    this.miniTickerWs = null;

    this._setupSearch();
  }

  // ======================== Initialization ========================

  /** Fetch initial data for all watchlist symbols, render, then start live stream. */
  async initialize() {
    await this._fetchAllTickers();
    this._render();
    this._connectMiniTicker();
  }

  /** @private — parallel fetch of 24h ticker data for every watchlist symbol */
  async _fetchAllTickers() {
    const promises = this.symbols.map(async (symbol) => {
      try {
        const data = await fetchTicker24h(symbol);
        this.tickerData.set(symbol, {
          lastPrice: data.lastPrice,
          priceChangePercent: data.priceChangePercent,
        });
      } catch (e) {
        console.warn(`Failed to fetch ticker for ${symbol}:`, e);
      }
    });
    await Promise.all(promises);
  }

  // ======================== WebSocket live prices ========================

  /** @private */
  _connectMiniTicker() {
    this.miniTickerWs = new WebSocket(
      "wss://stream.binance.com:9443/ws/!miniTicker@arr",
    );

    this.miniTickerWs.onmessage = (event) => {
      try {
        const tickers = JSON.parse(event.data);
        let updated = false;

        tickers.forEach((t) => {
          if (this.symbols.includes(t.s)) {
            const prev = this.tickerData.get(t.s);
            const newPrice = parseFloat(t.c);
            this.tickerData.set(t.s, {
              lastPrice: newPrice,
              priceChangePercent: prev ? prev.priceChangePercent : 0,
              prevPrice: prev ? prev.lastPrice : newPrice,
            });
            updated = true;
          }
        });

        if (updated) this._updatePrices();
      } catch (err) {
        console.warn("Watchlist miniTicker parse error:", err);
      }
    };

    this.miniTickerWs.onerror = (e) =>
      console.error("Mini ticker WS error:", e);
  }

  // ======================== Rendering ========================

  /** @private — full DOM render of watchlist items */
  _render() {
    if (!this.container) return;
    this.container.innerHTML = "";

    const filter = this.searchInput ? this.searchInput.value.toUpperCase() : "";

    this.symbols
      .filter((s) => !filter || s.includes(filter))
      .forEach((symbol) => {
        const item = document.createElement("div");
        item.className = `watchlist-item${symbol === this.activeSymbol ? " active" : ""}`;
        item.dataset.symbol = symbol;

        const ticker = this.tickerData.get(symbol) || {};
        const price =
          ticker.lastPrice != null ? formatPrice(ticker.lastPrice) : "—";
        const change =
          ticker.priceChangePercent != null ? ticker.priceChangePercent : 0;
        const changeClass = change >= 0 ? "text-green" : "text-red";
        const changeStr = formatPercent(change);

        const base = symbol.replace("USDT", "");

        item.innerHTML = `
          <div class="watchlist-item-left">
            <span class="watchlist-symbol">${base}<span class="text-muted">/USDT</span></span>
          </div>
          <div class="watchlist-item-right">
            <span class="watchlist-price mono">${price}</span>
            <span class="watchlist-change mono ${changeClass}">${changeStr}</span>
          </div>
        `;

        item.addEventListener("click", () => {
          this.setActiveSymbol(symbol);
          this.onSymbolSelect(symbol);
        });

        this.container.appendChild(item);
      });
  }

  /** @private — surgically update DOM prices without full re-render */
  _updatePrices() {
    const items = this.container.querySelectorAll(".watchlist-item");
    items.forEach((item) => {
      const symbol = item.dataset.symbol;
      const ticker = this.tickerData.get(symbol);
      if (!ticker) return;

      const priceEl = item.querySelector(".watchlist-price");
      const changeEl = item.querySelector(".watchlist-change");

      if (priceEl) {
        const oldPrice = priceEl.textContent;
        const newPrice = formatPrice(ticker.lastPrice);
        if (oldPrice !== newPrice) {
          priceEl.textContent = newPrice;
          // Brief flash animation
          const flashClass =
            ticker.lastPrice > (ticker.prevPrice || ticker.lastPrice)
              ? "flash-green"
              : "flash-red";
          priceEl.classList.add(flashClass);
          setTimeout(() => priceEl.classList.remove(flashClass), 500);
        }
      }

      if (changeEl && ticker.priceChangePercent != null) {
        changeEl.textContent = formatPercent(ticker.priceChangePercent);
        changeEl.className = `watchlist-change mono ${ticker.priceChangePercent >= 0 ? "text-green" : "text-red"}`;
      }
    });
  }

  // ======================== Public helpers ========================

  /**
   * Highlight the given symbol in the list.
   * @param {string} symbol
   */
  setActiveSymbol(symbol) {
    this.activeSymbol = symbol;
    if (!this.container) return;
    this.container.querySelectorAll(".watchlist-item").forEach((item) => {
      item.classList.toggle("active", item.dataset.symbol === symbol);
    });
  }

  /** @private */
  _setupSearch() {
    if (this.searchInput) {
      this.searchInput.addEventListener("input", () => this._render());
    }
  }

  /** Clean up WebSocket resources. */
  destroy() {
    if (this.miniTickerWs) {
      this.miniTickerWs.onclose = null;
      this.miniTickerWs.close();
      this.miniTickerWs = null;
    }
  }
}
