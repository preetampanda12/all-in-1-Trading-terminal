// ============================================================
// app.js — Main Application Bootstrap
// Orchestrates chart, watchlist, streams, toolbar, and state
// ============================================================

import { ChartManager } from "./chart.js?v=13";
import {
  fetchKlines,
  fetchTicker24h,
  BinanceKlineStream,
  BinanceSingleTickerStream,
} from "./data.js?v=6";
import { formatPrice, formatVolume, formatPercent, debounce } from "./utils.js";
import { getVPSettings } from "./volumeprofile.js";
import { getBubbleSettings } from "./volumebubbles.js";
import {
  supabase,
  syncSettingsToCloud,
  fetchSettingsFromCloud,
  exportLocalStorageForCloud,
  importCloudToLocalStorage,
} from "./supabase.js";

class App {
  constructor() {
    // ---- Persisted state ----
    this.currentSymbol = localStorage.getItem("ct_symbol") || "ETHUSDT";
    this.currentInterval = localStorage.getItem("ct_interval") || "1h";
    this.chartType = "candlestick";

    // ---- Managers & streams ----
    this.chart = null;
    this.klineStream = null;
    this.tickerStream = null;

    // ---- Candle timer ----
    this._timerInterval = null;
    this._candleCloseTime = null; // ms timestamp when current candle closes

    // ---- Active indicator chips for the UI ----
    this.activeIndicators = [];

    // ---- Cloud Sync ----
    this.syncToCloud = debounce(async () => {
      const data = exportLocalStorageForCloud();
      await syncSettingsToCloud(data);
    }, 2000);

    this._init();
    this._initAuth();
  }

  // ======================== Auth & Cloud ========================
  async _initAuth() {
    const authBtn = document.getElementById("auth-btn");
    const authBtnText = document.getElementById("auth-btn-text");
    const authModal = document.getElementById("auth-modal");
    const authOverlay = document.getElementById("auth-overlay");
    const closeBtn = document.getElementById("auth-close");
    const emailInput = document.getElementById("auth-email");
    const passInput = document.getElementById("auth-password");
    const errorMsg = document.getElementById("auth-error");
    const loginBtn = document.getElementById("auth-login-btn");
    const signupBtn = document.getElementById("auth-signup-btn");
    const logoutBtn = document.getElementById("auth-logout-btn");

    const formView = document.querySelector(".auth-form");
    const loggedInView = document.getElementById("auth-logged-in-view");
    const userEmailSpan = document.getElementById("auth-user-email");

    let isLoading = false;
    let isLoggedIn = false;

    // --- Helpers ---
    const showError = (msg) => {
      errorMsg.textContent = msg;
      errorMsg.className = "auth-message error";
    };

    const showSuccess = (msg) => {
      errorMsg.textContent = msg;
      errorMsg.className = "auth-message success";
    };

    const hideMessage = () => {
      errorMsg.className = "auth-message hidden";
    };

    const setLoading = (loading) => {
      isLoading = loading;
      loginBtn.disabled = loading;
      signupBtn.disabled = loading;
      loginBtn.style.opacity = loading ? "0.6" : "1";
      signupBtn.style.opacity = loading ? "0.6" : "1";
    };

    const validate = () => {
      const email = emailInput.value.trim();
      const pass = passInput.value;

      if (!email || !pass) {
        showError("Please fill in both email and password.");
        return false;
      }
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        showError("Please enter a valid email address.");
        return false;
      }
      if (pass.length < 6) {
        showError("Password must be at least 6 characters.");
        return false;
      }
      return true;
    };

    const clearForm = () => {
      emailInput.value = "";
      passInput.value = "";
      hideMessage();
    };

    const toggleModal = (show) => {
      // Force modal to stay open if not logged in
      if (!isLoggedIn) show = true;

      if (show) {
        authModal.classList.remove("hidden");
        authOverlay.classList.remove("hidden");
        if (!isLoggedIn) {
          hideMessage();
          emailInput.focus();
        }
      } else {
        authModal.classList.add("hidden");
        authOverlay.classList.add("hidden");
        clearForm();
      }
    };

    // --- Event Listeners ---
    authBtn.addEventListener("click", () => toggleModal(true));
    closeBtn.addEventListener("click", () => toggleModal(false));
    authOverlay.addEventListener("click", () => toggleModal(false));

    // Close on Escape key
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !authModal.classList.contains("hidden")) {
        toggleModal(false);
      }
    });

    // Submit on Enter key
    const handleEnter = (e) => {
      if (e.key === "Enter" && !isLoading) loginBtn.click();
    };
    emailInput.addEventListener("keydown", handleEnter);
    passInput.addEventListener("keydown", handleEnter);

    // --- Initial Session Check ---
    supabase.auth.getSession().then(({ data: { session } }) => {
      isLoggedIn = !!session;
      if (!isLoggedIn) toggleModal(true);
    });

    // --- Auth State Change ---
    supabase.auth.onAuthStateChange((event, session) => {
      isLoggedIn = !!session;

      if (session) {
        authBtnText.textContent = "Synced ✓";
        authBtn.classList.add("text-green");
        formView.classList.add("hidden");
        loggedInView.classList.remove("hidden");
        userEmailSpan.textContent = session.user.email;

        if (event === "SIGNED_IN") {
          // Try to fetch cloud data first
          fetchSettingsFromCloud().then((data) => {
            if (data && Object.keys(data).length > 0) {
              // Cloud has data → hydrate locally
              importCloudToLocalStorage(data);
              window.location.reload();
            } else {
              // Cloud is empty → push current local settings up
              this.syncToCloud();
            }
          });
        }
      } else {
        authBtnText.textContent = "Sign In";
        authBtn.classList.remove("text-green");
        formView.classList.remove("hidden");
        loggedInView.classList.add("hidden");
        toggleModal(true);
      }
    });

    // --- Login ---
    loginBtn.addEventListener("click", async () => {
      if (isLoading) return;
      hideMessage();
      if (!validate()) return;

      setLoading(true);
      loginBtn.querySelector("span").textContent = "Logging in...";

      const { error } = await supabase.auth.signInWithPassword({
        email: emailInput.value.trim(),
        password: passInput.value,
      });

      loginBtn.querySelector("span").textContent = "Login";
      setLoading(false);

      if (error) {
        if (error.message.includes("Invalid login")) {
          showError("Wrong email or password. Try again.");
        } else {
          showError(error.message);
        }
      } else {
        toggleModal(false);
      }
    });

    // --- Sign Up ---
    signupBtn.addEventListener("click", async () => {
      if (isLoading) return;
      hideMessage();
      if (!validate()) return;

      setLoading(true);
      signupBtn.textContent = "Creating...";

      const { data, error } = await supabase.auth.signUp({
        email: emailInput.value.trim(),
        password: passInput.value,
      });

      signupBtn.textContent = "Create Account";
      setLoading(false);

      if (error) {
        if (error.message.includes("rate limit")) {
          showError("Too many attempts. Please wait a few minutes.");
        } else {
          showError(error.message);
        }
      } else if (data.session) {
        // Auto-logged in (email confirmation disabled)
        showSuccess("Account created! Logging you in...");
        setTimeout(() => toggleModal(false), 800);
      } else {
        // Needs email confirmation
        showSuccess(
          "Account created! Check your email to confirm, then Login.",
        );
      }
    });

    // --- Logout ---
    logoutBtn.addEventListener("click", async () => {
      await supabase.auth.signOut();
      toggleModal(false);
    });
  }

  // ======================== Interval → ms mapping ========================
  _intervalToMs(interval) {
    const map = {
      "1s": 1000,
      "1m": 60_000,
      "3m": 3 * 60_000,
      "5m": 5 * 60_000,
      "15m": 15 * 60_000,
      "30m": 30 * 60_000,
      "1h": 60 * 60_000,
      "2h": 2 * 60 * 60_000,
      "4h": 4 * 60 * 60_000,
      "6h": 6 * 60 * 60_000,
      "8h": 8 * 60 * 60_000,
      "12h": 12 * 60 * 60_000,
      "1d": 24 * 60 * 60_000,
      "3d": 3 * 24 * 60 * 60_000,
      "1w": 7 * 24 * 60 * 60_000,
      "1M": 30 * 24 * 60 * 60_000,
    };
    return map[interval] || 60_000;
  }

  // ======================== Bootstrap ========================

  async _init() {
    this.isFetchingHistory = false;

    // 1. Create chart manager
    this.chart = new ChartManager("chart-container", "ohlcv-legend");

    // Wire up pagination
    this.chart.onScrollEdge(() => this._loadMoreHistory());

    // 2. Setup real-time streams
    this.klineStream = new BinanceKlineStream((data) => {
      this.chart.updateCandle(data);
      this._updateCurrentPrice(data.close, data);
      // Sync close time from live feed when candle closes
      if (data.isClosed) {
        const ms = this._intervalToMs(this.currentInterval);
        this._candleCloseTime = data.time * 1000 + ms;
      }
    });
    this.tickerStream = new BinanceSingleTickerStream((ticker) => {
      this._updateTickerDisplay(ticker);
    });

    // 3. Load initial symbol
    await this._loadSymbol(this.currentSymbol, this.currentInterval);

    // 4. Wire up toolbar controls
    this._setupChartSettings();
    this._setupToolbar();

    // 5. Show current symbol in the header
    this._updateSymbolDisplay();

    // 6. Start candle countdown timer
    this._startCandleTimer();

    // 7. Wire up VP settings panel
    this._setupSettingsPanel();

    // 7.5 Wire up Bubbles settings panel
    this._setupBubblesSettingsPanel();

    // 8. Wire up Go To Present button
    this._setupGoToPresent();

    // Sync UI checkmarks for overlays
    import("./liquidationheatmap.js").then(({ getLHSettings }) => {
      if (getLHSettings().enabled) {
        const lhItem = document.querySelector('.dropdown-item[data-indicator="lh"]');
        if (lhItem) lhItem.setAttribute("aria-checked", "true");
      }
    });

    // 9. Wire up Log Scale toggle
    this._setupLogScale();

    // 10. Persist zoom/scroll position
    this._setupZoomPersistence();

    // 11. Wire up Bar Replay System
    this._setupReplay();
  }

  // ======================== Symbol / Interval loading ========================

  /**
   * Fetch historical data and connect streams for a symbol + interval.
   * @param {string} symbol
   * @param {string} interval
   */
  async _loadSymbol(symbol, interval) {
    try {
      // Historical candles (Fetch up to 5000 for Replay Mode buffer)
      const rawKlines = await fetchKlines(symbol, interval, 5000);
      this.chart.loadData(rawKlines);
      this.klineStream.connect(symbol, interval);
      this.tickerStream.connect(symbol);
      
      if (this.chart && this.chart.lhRenderer) {
        this.chart.lhRenderer.setSymbol(symbol);
      }

      // Restore saved zoom/scroll state for this symbol/interval
      const savedZoom = localStorage.getItem(`ct_zoom_${symbol}_${interval}`);
      if (savedZoom) {
        try {
          const range = JSON.parse(savedZoom);
          // Only restore if valid object
          if (
            range &&
            typeof range.from === "number" &&
            typeof range.to === "number"
          ) {
            this.chart.chart.timeScale().setVisibleLogicalRange(range);
          }
        } catch (e) {}
      }

      // Load drawings from localStorage
      if (this.chart.drawingManager) {
        const storedDrawings = localStorage.getItem(`ct_drawings_${symbol}`);
        if (storedDrawings) {
          try {
            this.chart.drawingManager.loadDrawings(JSON.parse(storedDrawings));
          } catch (e) {
            console.warn("Failed to parse stored drawings", e);
            this.chart.drawingManager.loadDrawings([]);
          }
        } else {
          this.chart.drawingManager.loadDrawings([]);
        }

        // Register onChange callback for drawings
        this.chart.drawingManager.onChange((drawings) => {
          localStorage.setItem(
            `ct_drawings_${this.currentSymbol}`,
            JSON.stringify(drawings),
          );
          this.syncToCloud();
        });
      }

      // Compute candle close time from the last candle + interval duration
      if (rawKlines.length > 0) {
        const ms = this._intervalToMs(interval);
        const lastCandleOpenMs = rawKlines[rawKlines.length - 1].time * 1000;
        this._candleCloseTime = lastCandleOpenMs + ms;
        // If that's already in the past, compute from wall clock
        if (this._candleCloseTime < Date.now()) {
          const now = Date.now();
          this._candleCloseTime = now + (ms - (now % ms));
        }
      }

      // 24h ticker stats
      const ticker = await fetchTicker24h(symbol);
      this._updateTickerDisplay(ticker);
    } catch (error) {
      console.error("Failed to load symbol:", error);
    }
  }

  /** Fetch more history (pagination) when scrolling left. */
  async _loadMoreHistory() {
    if (this.isFetchingHistory) return;

    const data = this.chart.currentData;
    if (!data || data.length === 0) return;

    // The oldest candle time in ms
    const oldestTimeMs = data[0].time * 1000;

    this.isFetchingHistory = true;
    try {
      // Fetch 1000 candles ending at the oldest known candle
      const klines = await fetchKlines(
        this.currentSymbol,
        this.currentInterval,
        1000,
        oldestTimeMs,
      );

      // If we got new candles, prepend them
      if (klines && klines.length > 0) {
        this.chart.prependData(klines);
      }
    } catch (err) {
      console.warn("Failed to load history pagination:", err);
    } finally {
      this.isFetchingHistory = false;
    }
  }

  /** Switch to a new symbol while keeping the current interval. */
  async _switchSymbol(symbol) {
    this.currentSymbol = symbol;
    localStorage.setItem("ct_symbol", symbol);
    this._updateSymbolDisplay();
    if (this.chart && this.chart.lhRenderer) {
      this.chart.lhRenderer.setSymbol(symbol);
    }
    await this._loadSymbol(symbol, this.currentInterval);
    this.syncToCloud();
  }

  /** Switch to a new interval while keeping the current symbol. */
  async _switchInterval(interval) {
    this.currentInterval = interval;
    localStorage.setItem("ct_interval", interval);
    // Recalculate candle boundary for the new interval
    const ms = this._intervalToMs(interval);
    const now = Date.now();
    this._candleCloseTime = now + (ms - (now % ms));
    await this._loadSymbol(this.currentSymbol, interval);
    this.syncToCloud();
  }

  // ======================== Candle Timer ========================

  /** Start the 1-second countdown tick. */
  _startCandleTimer() {
    // Compute initial candle close time from current wall clock
    const ms = this._intervalToMs(this.currentInterval);
    const now = Date.now();
    this._candleCloseTime = now + (ms - (now % ms));

    // Tick every second
    this._timerInterval = setInterval(() => this._updateCandleTimer(), 1000);
    this._updateCandleTimer(); // draw immediately
  }

  /** Compute remaining time and update the DOM element. */
  _updateCandleTimer() {
    const timerEl = document.getElementById("candle-timer");
    const valueEl = document.getElementById("candle-timer-value");
    if (!timerEl || !valueEl || !this._candleCloseTime) return;

    const remaining = this._candleCloseTime - Date.now();

    // If the candle has closed, roll forward to the next boundary
    if (remaining <= 0) {
      const ms = this._intervalToMs(this.currentInterval);
      const now = Date.now();
      this._candleCloseTime = now + (ms - (now % ms));
    }

    const totalSec = Math.max(0, Math.ceil(remaining / 1000));
    const hours = Math.floor(totalSec / 3600);
    const minutes = Math.floor((totalSec % 3600) / 60);
    const seconds = totalSec % 60;

    // Format: HH:MM:SS for long intervals, MM:SS for short ones
    const formatted =
      hours > 0
        ? `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`
        : `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;

    valueEl.textContent = formatted;

    // Apply urgency states
    timerEl.classList.remove("urgent", "closing");
    if (totalSec <= 5) timerEl.classList.add("closing");
    else if (totalSec <= 30) timerEl.classList.add("urgent");
  }

  // ======================== DOM updates ========================

  /** @private */
  _updateSymbolDisplay() {
    const el = document.getElementById("current-symbol-name");
    if (el) {
      const base = this.currentSymbol.replace("USDT", "");
      el.textContent = `${base}/USDT`;
    }
  }

  /** @private */
  _updateCurrentPrice(price, _candle) {
    const el = document.getElementById("current-price");
    if (!el) return;

    const oldText = el.textContent;
    const newText = formatPrice(price);
    el.textContent = newText;

    if (oldText !== newText && oldText !== "—") {
      const oldNum = parseFloat(oldText.replace(/,/g, ""));
      const newNum = parseFloat(newText.replace(/,/g, ""));
      const flashClass = newNum > oldNum ? "flash-green" : "flash-red";
      el.classList.add(flashClass);
      setTimeout(() => el.classList.remove(flashClass), 500);
    }
  }

  /** @private */
  _updateTickerDisplay(ticker) {
    const priceEl = document.getElementById("current-price");
    const changeEl = document.getElementById("price-change");
    const changePctEl = document.getElementById("price-change-percent");

    const flash = (el, newText, oldText) => {
      if (!el || oldText === newText || oldText === "—" || oldText === "")
        return;
      const oldNum = parseFloat(oldText.replace(/,/g, ""));
      const newNum = parseFloat(newText.replace(/,/g, ""));
      if (!isNaN(oldNum) && !isNaN(newNum)) {
        const flashClass = newNum > oldNum ? "flash-green" : "flash-red";
        el.classList.add(flashClass);
        setTimeout(() => el.classList.remove(flashClass), 500);
      }
    };

    if (priceEl) priceEl.textContent = formatPrice(ticker.lastPrice);

    if (changeEl) {
      const newChange =
        (ticker.priceChange >= 0 ? "+" : "") + formatPrice(ticker.priceChange);
      flash(changeEl, newChange, changeEl.textContent);
      changeEl.textContent = newChange;
      changeEl.className = `price-change mono ${ticker.priceChange >= 0 ? "text-green" : "text-red"}`;
    }
    if (changePctEl) {
      const newPct = formatPercent(ticker.priceChangePercent);
      flash(changePctEl, newPct, changePctEl.textContent);
      changePctEl.textContent = newPct;
      changePctEl.className = `price-change-percent mono ${ticker.priceChangePercent >= 0 ? "text-green" : "text-red"}`;
    }
  }

  // ======================== Toolbar wiring ========================

  /** @private */
  _setupChartSettings() {
    const btn = document.getElementById("chart-settings-btn");
    const modal = document.getElementById("chart-settings-modal");
    const overlay = document.getElementById("chart-settings-overlay");
    const closeBtn = document.getElementById("chart-settings-close");
    const saveBtn = document.getElementById("btn-save-chart-settings");

    const bgInput = document.getElementById("color-bg");
    const gridInput = document.getElementById("color-grid");
    const upInput = document.getElementById("color-candle-up");
    const downInput = document.getElementById("color-candle-down");

    if (!btn || !modal) return;

    // Load saved settings if any
    const saved = localStorage.getItem("ct_theme_settings");
    if (saved) {
      try {
        const s = JSON.parse(saved);
        if (s.bg) bgInput.value = s.bg;
        if (s.grid) gridInput.value = s.grid;
        if (s.up) upInput.value = s.up;
        if (s.down) downInput.value = s.down;
        
        // Apply immediately on load
        if (this.chart) {
          this.chart.applyThemeSettings(s);
        }
      } catch (e) {}
    }

    const openModal = () => {
      modal.classList.remove("hidden");
      overlay.classList.remove("hidden");
    };

    const closeModal = () => {
      modal.classList.add("hidden");
      overlay.classList.add("hidden");
    };

    btn.addEventListener("click", openModal);
    closeBtn.addEventListener("click", closeModal);
    overlay.addEventListener("click", closeModal);

    saveBtn.addEventListener("click", () => {
      const s = {
        bg: bgInput.value,
        grid: gridInput.value,
        up: upInput.value,
        down: downInput.value
      };
      
      localStorage.setItem("ct_theme_settings", JSON.stringify(s));
      
      if (this.chart) {
        this.chart.applyThemeSettings(s);
      }
      
      closeModal();
    });
  }

  _setupToolbar() {
    // ---- Drawing Toolbar ----
    const drawingToolbar = document.getElementById("drawing-toolbar");
    if (drawingToolbar) {
      const cursorBtn = drawingToolbar.querySelector('[data-tool="cursor"]');

      const _selectCursorBtn = () => {
        drawingToolbar
          .querySelectorAll(".draw-btn")
          .forEach((b) => b.classList.remove("active"));
        if (cursorBtn) cursorBtn.classList.add("active");
      };

      drawingToolbar.querySelectorAll(".draw-btn").forEach((btn) => {
        btn.addEventListener("click", () => {
          const tool = btn.dataset.tool;
          if (tool === "clear") {
            // Clear all and switch to cursor visually
            if (this.chart && this.chart.drawingManager) {
              this.chart.drawingManager.setTool("clear");
            }
            _selectCursorBtn();
          } else {
            drawingToolbar
              .querySelectorAll(".draw-btn")
              .forEach((b) => b.classList.remove("active"));
            btn.classList.add("active");
            if (this.chart && this.chart.drawingManager) {
              this.chart.drawingManager.setTool(tool);
            }
          }
        });
      });

      // Also register the onClear callback in case clear is triggered programmatically
      if (this.chart && this.chart.drawingManager) {
        this.chart.drawingManager.onClear(_selectCursorBtn);
        this.chart.drawingManager.onDrawEnd(() => {
          this.chart.drawingManager.setTool("cursor");
          _selectCursorBtn();
        });
      }
    }

    // --- Clear Drawings Event ---
    const clearDrawingsBtn = document.getElementById("clear-drawings-btn");
    if (clearDrawingsBtn) {
      clearDrawingsBtn.addEventListener("click", () => {
        if (this.chart && this.chart.drawingManager) {
          this.chart.drawingManager.setTool("clear");
        }
      });
    }

    // ---- Timeframe buttons ----
    const tfButtons = document.querySelectorAll(".timeframe-group button");
    tfButtons.forEach((btn) => {
      btn.classList.toggle(
        "active",
        btn.dataset.interval === this.currentInterval,
      );
      btn.addEventListener("click", () => {
        tfButtons.forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");
        this.currentInterval = btn.dataset.interval;
        localStorage.setItem("ct_interval", this.currentInterval);
        this.syncToCloud();
        this._loadSymbol(this.currentSymbol, this.currentInterval);
      });
    });

    // ---- Chart type buttons ----
    const ctContainer = document.getElementById("chart-type-buttons");
    if (ctContainer) {
      // Restore saved chart type
      const savedType = localStorage.getItem("ct_chart_type") || "candlestick";
      this.chart.setChartType(savedType);
      ctContainer.querySelectorAll("button").forEach((btn) => {
        btn.classList.toggle("active", btn.dataset.type === savedType);

        btn.addEventListener("click", () => {
          ctContainer
            .querySelectorAll("button")
            .forEach((b) => b.classList.remove("active"));
          btn.classList.add("active");
          this.chart.setChartType(btn.dataset.type);
          localStorage.setItem("ct_chart_type", btn.dataset.type);
          this.syncToCloud();
        });
      });
    }

    // ---- Indicators dropdown ----
    const indBtn = document.getElementById("indicators-btn");
    const indDropdown = document.getElementById("indicators-dropdown");
    if (indBtn && indDropdown) {
      indBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        indDropdown.classList.toggle("open");
      });

      indDropdown.querySelectorAll(".dropdown-item").forEach((item) => {
        item.addEventListener("click", async (e) => {
          // Ignore if they clicked the settings button inside it
          if (e.target.closest('.icon-btn')) return;

          const type = item.dataset.indicator;
          if (type === "vp" || type === "bubbles" || type === "lh") {
            const isChecked = item.getAttribute("aria-checked") === "true";
            item.setAttribute("aria-checked", !isChecked);

            if (type === "vp") {
              const { getVPSettings, saveVPSettings } = await import("./volumeprofile.js");
              const s = getVPSettings();
              s.enabled = !isChecked;
              saveVPSettings(s);
              if (this.chart && this.chart.vpRenderer) {
                this.chart.vpRenderer.setVisibility(s.enabled);
              }
              this.syncToCloud();
            } else if (type === "bubbles") {
              const { getBubbleSettings, saveBubbleSettings } = await import("./volumebubbles.js");
              const s = getBubbleSettings();
              s.enabled = !isChecked;
              saveBubbleSettings(s);
              if (this.chart && this.chart.bubbleSeriesCustom) {
                this.chart.bubbleSeriesCustom.applySettings(s);
                this.chart.chart.applyOptions({});
              }
              this.syncToCloud();
            } else if (type === "lh") {
              const { getLHSettings, saveLHSettings } = await import("./liquidationheatmap.js");
              const s = getLHSettings();
              s.enabled = !isChecked;
              saveLHSettings(s);
              if (this.chart && this.chart.lhRenderer) {
                this.chart.lhRenderer.setVisibility(s.enabled);
              }
              this.syncToCloud();
            }
          } else {
            // Additive indicators (SMA, EMA, RSI, MACD)
            let params = {};
            if (type === "sma") {
              const input = document.getElementById("sma-period-input");
              params = { period: parseInt(input?.value) || 20 };
            } else if (type === "ema") {
              const input = document.getElementById("ema-period-input");
              params = { period: parseInt(input?.value) || 20 };
            }
            const ind = this.chart.addIndicator(type, params);
            this._onIndicatorAdded(ind);
            this._saveIndicators();
          }
        });
      });

        // Load saved indicators
        this._loadIndicators();
      }

    // ---- Symbol selector dropdown ----
    const symBtn = document.getElementById("symbol-btn");
    const symDropdown = document.getElementById("symbol-dropdown");
    const symSearch = document.getElementById("symbol-search-input");
    const symResults = document.getElementById("symbol-search-results");

    if (symBtn && symDropdown) {
      symBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        const isOpen = symDropdown.classList.contains("open");
        document
          .querySelectorAll(".dropdown.open")
          .forEach((d) => d.classList.remove("open"));
        if (!isOpen) {
          symDropdown.classList.add("open");
          symSearch.focus();
          this._populateSymbolSearch("");
        }
      });

      const searchInput = document.getElementById("symbol-search-input");
      if (searchInput) {
        searchInput.addEventListener(
          "input",
          debounce((e) => {
            this._populateSymbolSearch(e.target.value);
          }, 20),
        );
      }
    }

    // ---- Global: close open dropdowns on outside click ----
    document.addEventListener("click", () => {
      document
        .querySelectorAll(".dropdown.open")
        .forEach((d) => d.classList.remove("open"));
    });

    // Prevent clicks inside dropdowns from bubbling and closing them
    document.querySelectorAll(".dropdown").forEach((d) => {
      d.addEventListener("click", (e) => e.stopPropagation());
    });

    // ---- Watchlist collapse toggle ----
    const collapseBtn = document.getElementById("watchlist-collapse");
    const watchlistPanel = document.getElementById("watchlist-panel");
    if (collapseBtn && watchlistPanel) {
      collapseBtn.addEventListener("click", () => {
        watchlistPanel.classList.toggle("collapsed");
        // Let the CSS transition finish before resizing the chart
        setTimeout(() => this.chart.resize(), 300);
      });
    }
  }

  // ======================== Symbol search dropdown ========================

  /** @private */
  _populateSymbolSearch(query) {
    const resultsContainer = document.getElementById("symbol-search-results");
    if (!resultsContainer) return;

    const popularPairs = [
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
      "MATICUSDT",
      "UNIUSDT",
      "LTCUSDT",
      "ATOMUSDT",
      "NEARUSDT",
      "AAVEUSDT",
      "APTUSDT",
      "ARBUSDT",
      "OPUSDT",
      "SUIUSDT",
    ];

    const filtered = query
      ? popularPairs.filter((s) => s.includes(query.toUpperCase()))
      : popularPairs;

    resultsContainer.innerHTML = filtered
      .map((symbol) => {
        const base = symbol.replace("USDT", "");
        return `<div class="dropdown-item symbol-search-item" data-symbol="${symbol}">
        <span class="symbol-name">${base}</span>
        <span class="text-muted">/USDT</span>
      </div>`;
      })
      .join("");

    // Attach click handlers to freshly rendered items
    resultsContainer.querySelectorAll(".symbol-search-item").forEach((item) => {
      item.addEventListener("click", () => {
        this._switchSymbol(item.dataset.symbol);
        document.getElementById("symbol-dropdown").classList.remove("open");
      });
    });
  }

  // ======================== Indicator chips ========================

  /** @private */
  _onIndicatorAdded(indicator) {
    this.activeIndicators.push(indicator);

    // Update dropdown UI state for toggleable items
    const dropdownItem = document.querySelector(
      `.dropdown-item[data-indicator="${indicator.type}"]`,
    );
    if (dropdownItem && dropdownItem.getAttribute("role") === "menuitemcheckbox") {
      dropdownItem.setAttribute("aria-checked", "true");
    }
    
    // Wire up remove callback on first use
    if (!this.chart.onIndicatorRemoved) {
      this.chart.onIndicatorRemoved = (id, type) => {
        this.activeIndicators = this.activeIndicators.filter((i) => i.id !== id);
        this._saveIndicators();
        const item = document.querySelector(`.dropdown-item[data-indicator="${type}"]`);
        if (item && item.getAttribute("role") === "menuitemcheckbox") item.setAttribute("aria-checked", "false");
      };
      
      this.chart.onIndicatorUpdated = (id, indicator) => {
        const index = this.activeIndicators.findIndex(i => i.id === id);
        if (index !== -1) {
          this.activeIndicators[index] = indicator;
          this._saveIndicators();
        }
      };
    }
  }

  /** @private */
  _saveIndicators() {
    const data = this.activeIndicators.map((i) => ({
      type: i.type,
      params: i.params,
      color: i.color,
    }));
    localStorage.setItem("ct_indicators", JSON.stringify(data));
    this.syncToCloud();
  }

  /** @private */
  _loadIndicators() {
    try {
      const saved = localStorage.getItem("ct_indicators");
      if (!saved) return;
      const parsed = JSON.parse(saved);
      if (!Array.isArray(parsed)) return;

      parsed.forEach((cfg) => {
        if (cfg.type === "bb") return; // Removed BB from system
        // Only add if not already active
        if (!this.activeIndicators.find((i) => i.type === cfg.type)) {
          const ind = this.chart.addIndicator(cfg.type, cfg.params);
          if (cfg.color) {
            // Keep original color if possible, else chart manager assigns one
            this.chart.indicators.get(ind.id).color = cfg.color;
          }
          this._onIndicatorAdded(ind);
        }
      });
    } catch (e) {
      console.warn("Failed to parse saved indicators");
    }
  }

  // ======================== Settings Panel ========================

  /** @private — wire up the gear button, modal, form inputs, apply/reset */
  _setupSettingsPanel() {
    const settingsBtn = document.getElementById("vp-settings-btn-dropdown");
    const clearDrawingsBtn = document.getElementById("clear-drawings-btn");
    const overlay = document.getElementById("settings-overlay");
    const panel = document.getElementById("settings-panel");
    const closeBtn = document.getElementById("settings-close");
    if (!settingsBtn || !panel || !overlay) return;

    // DOM refs
    const enabledCb = document.getElementById("vp-enabled");
    const startInput = document.getElementById("vp-session-start");
    const endInput = document.getElementById("vp-session-end");
    const rowsInput = document.getElementById("vp-rows");
    const vaPctRange = document.getElementById("vp-va-pct");
    const vaPctVal = document.getElementById("vp-va-pct-val");
    const widthRange = document.getElementById("vp-width-pct");
    const widthVal = document.getElementById("vp-width-pct-val");

    // New Color & Opacity DOM refs
    const colorVAInput = document.getElementById("vp-color-va");
    const colorOutInput = document.getElementById("vp-color-outside");
    const colorPocInput = document.getElementById("vp-color-poc");
    const opacityVaRange = document.getElementById("vp-opacity-va");
    const opacityVaVal = document.getElementById("vp-opacity-va-val");
    const opacityOutRange = document.getElementById("vp-opacity-outside");
    const opacityOutVal = document.getElementById("vp-opacity-outside-val");
    const applyBtn = document.getElementById("vp-apply");
    const resetBtn = document.getElementById("vp-reset-defaults");

    // ── Populate form from stored settings ──
    const _populate = () => {
      const s = getVPSettings();
      if (enabledCb) enabledCb.checked = s.enabled;
      if (startInput) startInput.value = s.sessionStartIST;
      if (endInput) endInput.value = s.sessionEndIST;
      if (rowsInput) rowsInput.value = s.rows;

      const dropdownItem = document.querySelector('.dropdown-item[data-indicator="vp"]');
      if (dropdownItem) dropdownItem.setAttribute("aria-checked", s.enabled);
      
      if (vaPctRange) {
        vaPctRange.value = s.valueAreaPct;
        vaPctVal.textContent = s.valueAreaPct + "%";
      }
      if (widthRange) {
        widthRange.value = s.widthPct;
        widthVal.textContent = s.widthPct + "%";
      }
      if (colorVAInput) colorVAInput.value = s.colorVA;
      if (colorOutInput) colorOutInput.value = s.colorOutside;
      if (colorPocInput) colorPocInput.value = s.colorPOC;
      if (opacityVaRange) {
        opacityVaRange.value = s.opacityVA;
        opacityVaVal.textContent = s.opacityVA + "%";
      }
      if (opacityOutRange) {
        opacityOutRange.value = s.opacityOutside;
        opacityOutVal.textContent = s.opacityOutside + "%";
      }
    };

    // ── Open / close ──
    const openPanel = () => {
      _populate();
      overlay.classList.remove("hidden");
      panel.classList.remove("hidden");
    };
    const closePanel = () => {
      overlay.classList.add("hidden");
      panel.classList.add("hidden");
    };

    settingsBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      openPanel();
    });
    closeBtn.addEventListener("click", closePanel);
    overlay.addEventListener("click", closePanel);
    panel.addEventListener("click", (e) => e.stopPropagation());

    // Escape key
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !panel.classList.contains("hidden"))
        closePanel();
    });

    // ── Live range labels ──
    if (vaPctRange)
      vaPctRange.addEventListener("input", () => {
        vaPctVal.textContent = vaPctRange.value + "%";
      });
    if (widthRange)
      widthRange.addEventListener("input", () => {
        widthVal.textContent = widthRange.value + "%";
      });
    if (opacityVaRange)
      opacityVaRange.addEventListener("input", () => {
        opacityVaVal.textContent = opacityVaRange.value + "%";
      });
    if (opacityOutRange)
      opacityOutRange.addEventListener("input", () => {
        opacityOutVal.textContent = opacityOutRange.value + "%";
      });

    // ── Apply button ──
    applyBtn.addEventListener("click", () => {
      const newSettings = {
        enabled: enabledCb.checked,
        sessionStartIST: startInput.value,
        sessionEndIST: endInput.value,
        rows: parseInt(rowsInput.value, 10) || 24,
        valueAreaPct: parseInt(vaPctRange.value, 10) || 70,
        widthPct: parseInt(widthRange.value, 10) || 30,
        colorVA: colorVAInput ? colorVAInput.value : "#4a9eff",
        colorOutside: colorOutInput ? colorOutInput.value : "#4a9eff",
        colorPOC: colorPocInput ? colorPocInput.value : "#ffb800",
        opacityVA: opacityVaRange ? parseInt(opacityVaRange.value, 10) : 45,
        opacityOutside: opacityOutRange
          ? parseInt(opacityOutRange.value, 10)
          : 15,
      };
      if (this.chart && this.chart.vpRenderer) {
        this.chart.vpRenderer.applySettings(newSettings);
      }
      
      const dropdownItem = document.querySelector('.dropdown-item[data-indicator="vp"]');
      if (dropdownItem) dropdownItem.setAttribute("aria-checked", newSettings.enabled);
      
      this.syncToCloud();
      closePanel();
    });

    // ── Reset defaults ──
    resetBtn.addEventListener("click", () => {
      localStorage.removeItem("ct_vp_settings");
      _populate();
      this.syncToCloud();
    });
  }

  _setupBubblesSettingsPanel() {
    const bubblesSettingsBtn = document.getElementById("bubbles-settings-btn-dropdown");
    const overlay = document.getElementById("bubbles-overlay");
    const panel = document.getElementById("bubbles-panel");
    const closeBtn = document.getElementById("bubbles-close");
    if (!bubblesSettingsBtn || !panel || !overlay) return;

    const enabledCb = document.getElementById("bubbles-enabled");
    const multRange = document.getElementById("bubbles-multiplier");
    const multVal = document.getElementById("bubbles-multiplier-val");
    const applyBtn = document.getElementById("bubbles-apply");
    const resetBtn = document.getElementById("bubbles-reset");

    const _populate = () => {
      const s = getBubbleSettings();
      if (enabledCb) enabledCb.checked = s.enabled;
      if (multRange) {
        multRange.value = s.minMultiplier;
        multVal.textContent = s.minMultiplier + "x";
      }
      
      const dropdownItem = document.querySelector('.dropdown-item[data-indicator="bubbles"]');
      if (dropdownItem) dropdownItem.setAttribute("aria-checked", s.enabled);
    };

    _populate();

    const openPanel = () => {
      _populate();
      overlay.classList.remove("hidden");
      panel.classList.remove("hidden");
    };
    const closePanel = () => {
      overlay.classList.add("hidden");
      panel.classList.add("hidden");
    };

    bubblesSettingsBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      openPanel();
    });

    closeBtn.addEventListener("click", closePanel);
    overlay.addEventListener("click", closePanel);
    panel.addEventListener("click", (e) => e.stopPropagation());

    if (multRange) {
      multRange.addEventListener("input", () => {
        multVal.textContent = multRange.value + "x";
      });
    }

    applyBtn.addEventListener("click", () => {
      const newSettings = {
        enabled: enabledCb.checked,
        minMultiplier: parseFloat(multRange.value) || 1.5,
      };
      if (this.chart && this.chart.bubbleSeriesCustom) {
        this.chart.bubbleSeriesCustom.applySettings(newSettings);
        this.chart.chart.applyOptions({}); // Force immediate redraw
      }
      localStorage.setItem("ct_bubble_settings", JSON.stringify(newSettings));
      
      const dropdownItem = document.querySelector('.dropdown-item[data-indicator="bubbles"]');
      if (dropdownItem) dropdownItem.setAttribute("aria-checked", newSettings.enabled);
      
      this.syncToCloud();
      closePanel();
    });

    resetBtn.addEventListener("click", () => {
      localStorage.removeItem("ct_bubble_settings");
      _populate();
    });
  }

  // ======================== Go To Present ========================

  /**
   * Shows/hides the "Go to present" button based on how far we scrolled.
   */
  _setupGoToPresent() {
    const btn = document.getElementById("go-to-present");
    if (!btn) return;

    btn.addEventListener("click", () => {
      this.chart.scrollToRealTime();
    });

    this.chart.onVisibleRangeChange((distFromEnd) => {
      // If the rightmost visible candle is more than 5 candles away from the most recent,
      // show the "go to present" button.
      if (distFromEnd > 5) {
        btn.classList.remove("hidden");
      } else {
        btn.classList.add("hidden");
      }
    });
  }

  // ======================== Log Scale & Zoom ========================

  /** Wire up the Logarithmic scale toggle button. */
  _setupLogScale() {
    const logBtn = document.getElementById("log-scale-btn");
    if (logBtn) {
      const saved = localStorage.getItem("ct_log_scale");
      const isLog = saved === null ? true : saved === "true"; // Default to true
      
      if (isLog) {
        logBtn.classList.add("active");
        this.chart.setLogScale(true);
      } else {
        logBtn.classList.remove("active");
        this.chart.setLogScale(false);
      }

      logBtn.addEventListener("click", () => {
        const newState = !logBtn.classList.contains("active");
        logBtn.classList.toggle("active", newState);
        this.chart.setLogScale(newState);
        localStorage.setItem("ct_log_scale", newState);
        this.syncToCloud();
      });
    }
  }

  /** Save the user's current zoom/pan window automatically. */
  _setupZoomPersistence() {
    this.chart.chart.timeScale().subscribeVisibleLogicalRangeChange((range) => {
      if (range) {
        localStorage.setItem(
          `ct_zoom_${this.currentSymbol}_${this.currentInterval}`,
          JSON.stringify(range),
        );
        this.syncToCloud();
      }
    });
  }

  // ======================== Utils ========================
  // ======================== Replay System ========================

  _setupReplay() {
    const replayBtn = document.getElementById("replay-btn");
    const replayPanel = document.getElementById("replay-control-panel");
    const playPauseBtn = document.getElementById("replay-play-pause-btn");
    const stepBtn = document.getElementById("replay-step-btn");
    const speedSlider = document.getElementById("replay-speed");
    const closeBtn = document.getElementById("replay-close-btn");
    
    const playIcon = document.getElementById("replay-play-icon");
    const pauseIcon = document.getElementById("replay-pause-icon");

    let isPlaying = false;
    let playInterval = null;
    let speedMs = parseInt(speedSlider.value, 10);
    
    let isSelectingStart = false;
    let selectionToast = null;
    let clickSubscription = null;

    const stopPlayback = () => {
      isPlaying = false;
      clearInterval(playInterval);
      playIcon.classList.remove("hidden");
      pauseIcon.classList.add("hidden");
    };

    const startPlayback = () => {
      if (!this.chart.isReplayMode) return;
      isPlaying = true;
      playIcon.classList.add("hidden");
      pauseIcon.classList.remove("hidden");
      
      playInterval = setInterval(() => {
        const hasMore = this.chart.stepReplay();
        if (!hasMore) stopPlayback();
      }, speedMs);
    };

    // Toggle Replay selection mode
    replayBtn.addEventListener("click", () => {
      if (this.chart.isReplayMode) return;
      
      if (isSelectingStart) {
        // Cancel selection
        isSelectingStart = false;
        if (selectionToast) selectionToast.remove();
        if (clickSubscription) this.chart.chart.unsubscribeClick(clickSubscription);
        replayBtn.classList.remove("active");
        return;
      }
      
      isSelectingStart = true;
      replayBtn.classList.add("active");
      
      // Show toast
      selectionToast = document.createElement("div");
      selectionToast.className = "replay-selection-toast";
      selectionToast.textContent = "Click on the chart to select the start point for replay";
      document.querySelector(".chart-area").appendChild(selectionToast);
      
      // Handle click
      clickSubscription = (param) => {
        if (!param || !param.time) return;
        
        isSelectingStart = false;
        if (selectionToast) selectionToast.remove();
        this.chart.chart.unsubscribeClick(clickSubscription);
        replayBtn.classList.remove("active");
        
        // Find index of clicked time in currentData
        const targetTime = param.time;
        const startIndex = this.chart.currentData.findIndex(c => c.time >= targetTime);
        if (startIndex === -1) return;
        
        // Disconnect live stream!
        this.klineStream.disconnect();
        
        // Start replay
        this.chart.startReplay(startIndex);
        replayPanel.classList.remove("hidden");
        
        // Flash panel to indicate it started
        replayPanel.animate([
          { transform: 'translate(-50%, -20px)', opacity: 0 },
          { transform: 'translate(-50%, 0)', opacity: 1 }
        ], { duration: 300, easing: 'ease-out' });
      };
      
      this.chart.chart.subscribeClick(clickSubscription);
    });

    playPauseBtn.addEventListener("click", () => {
      if (isPlaying) {
        stopPlayback();
      } else {
        startPlayback();
      }
    });

    stepBtn.addEventListener("click", () => {
      stopPlayback();
      this.chart.stepReplay();
    });

    speedSlider.addEventListener("input", (e) => {
      // Invert speed logic: higher value on slider means faster (lower ms)
      // The slider is 100 to 2000. 100 = 2000ms, 2000 = 100ms
      const val = parseInt(e.target.value, 10);
      speedMs = 2100 - val; 
      
      if (isPlaying) {
        stopPlayback();
        startPlayback();
      }
    });

    closeBtn.addEventListener("click", () => {
      stopPlayback();
      this.chart.exitReplay();
      replayPanel.classList.add("hidden");
      
      // Reconnect live stream
      this.klineStream.connect(this.currentSymbol, this.currentInterval);
    });
  }
}

// ======================== Bootstrap ========================
const app = new App();
