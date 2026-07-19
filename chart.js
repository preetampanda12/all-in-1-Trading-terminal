// ============================================================
// chart.js — Chart Manager
// Wraps TradingView lightweight-charts and manages series,
// indicators, legend, and resize behaviour.
// ============================================================

import {
  calculateSMA,
  calculateEMA,
  calculateRSI,
  calculateMACD,
} from "./indicators.js?v=6";
import { formatPrice, formatVolume } from "./utils.js";
import { VolumeProfileRenderer } from "./volumeprofile.js";
import { LiquidationHeatmapRenderer } from "./liquidationheatmap.js";
import { CustomBubbleSeries, computeBubbleData } from "./volumebubbles.js";
import { DrawingManager } from "./drawing.js";

const LightweightCharts = window.LightweightCharts;

export class ChartManager {
  /**
   * @param {string} containerId — DOM id of the chart container div
   * @param {string} legendId   — DOM id of the OHLCV legend element
   */
  constructor(containerId, legendId) {
    this.container = document.getElementById(containerId);
    this.legendEl = document.getElementById(legendId);

    this.chart = null;
    this.candleSeries = null;
    this.lineSeries = null; // for line-chart mode

    this.indicators = new Map(); // id → { type, series[], params, color }
    this.currentData = []; // raw candle array for indicator recalc
    this.chartType = "candlestick";
    this.vpRenderer = null; // VolumeProfileRenderer instance
    this.lhRenderer = null; // LiquidationHeatmapRenderer instance
    this.drawingManager = null; // Custom drawing overlay
    this.bubbleSeries = null;
    this.bubbleSeriesCustom = null;
    this.heatmapSeries = null;
    this.heatmapCustom = null;
    this.orderBookManager = null;

    // Replay Mode State
    this.isReplayMode = false;
    this.replayFutureData = []; // hidden future candles
    this.fullData = []; // backup of the full dataset

    this.indicatorColors = [
      "#4a9eff",
      "#ff9f43",
      "#a855f7",
      "#06d6a0",
      "#f472b6",
      "#38bdf8",
    ];
    this.nextColorIndex = 0;
    this.activeSubPanes = [];
    this.paneBoundaries = [];

    this._createChart();
    this._setupResizeObserver();
    this._setupSessionBreakCanvas();
    this._setupCVD();
    this._setupVolumeProfile();
    this._setupLiquidationHeatmap();
    this._setupDrawingManager();

    // Initial pane layout (CVD is always present)
    this._recalculatePaneMargins();
  }

  // ======================== Chart creation ========================

  /** @private */
  _createChart() {
    // Use parent element (chart-area) for dimensions — it's absolutely positioned with real size
    const parent = this.container.parentElement || this.container;
    const w = parent.offsetWidth || window.innerWidth;
    const h = parent.offsetHeight || window.innerHeight - 80;

    // IST = UTC + 5:30 = +19800 seconds
    const IST_OFFSET = 5.5 * 3600;

    this.chart = LightweightCharts.createChart(this.container, {
      width: w,
      height: h,
      localization: {
        timeFormatter: (time) => {
          // Use browser's native local timezone (which will be IST for the user)
          const d = new Date(time * 1000);
          return d.toLocaleString([], {
            month: "short",
            day: "numeric",
            hour: "2-digit",
            minute: "2-digit",
            hour12: false,
          });
        },
      },
      layout: {
        background: { type: "solid", color: "transparent" },
        textColor: "#8b8b9a",
        fontSize: 11,
        fontFamily: "Inter, sans-serif",
      },
      grid: {
        vertLines: { visible: false },
        horzLines: { visible: false },
      },
      crosshair: {
        mode: 0, // Normal (free-floating)
        vertLine: {
          color: "#353548",
          width: 1,
          style: 3, // Dotted
          labelBackgroundColor: "#2a2a3a",
        },
        horzLine: {
          color: "#353548",
          width: 1,
          style: 3,
          labelBackgroundColor: "#2a2a3a",
        },
      },
      rightPriceScale: {
        borderColor: "#2a2a3a",
        scaleMargins: {
          top: 0.1,
          bottom: 0.03, // Will be overridden by _recalculatePaneMargins
        },
      },
      timeScale: {
        borderColor: "#2a2a3a",
        timeVisible: true,
        secondsVisible: false,
        rightOffset: 5,
        barSpacing: 8,
        tickMarkFormatter: (time, tickMarkType) => {
          const d = new Date(time * 1000);
          const hh = String(d.getHours()).padStart(2, "0");
          const mm = String(d.getMinutes()).padStart(2, "0");
          const day = d.getDate();
          const months = [
            "Jan", "Feb", "Mar", "Apr", "May", "Jun", 
            "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
          ];
          const mon = months[d.getMonth()];
          // tickMarkType: 0=Year, 1=Month, 2=Day, 3=Time, 4=TimeWithSeconds
          if (tickMarkType <= 1) return String(d.getFullYear());
          if (tickMarkType === 2) return `${day} ${mon}`;
          return `${hh}:${mm}`;
        },
      },
      handleScroll: {
        mouseWheel: true,
        pressedMouseMove: true,
        horzTouchDrag: true,
        vertTouchDrag: true,
      },
      handleScale: {
        mouseWheel: false, // Disabled default to use custom tuned zoom
        pinch: true,
        axisPressedMouseMove: { time: true, price: true },
        axisDoubleClickReset: true,
      },
      kineticScroll: {
        touch: false,
        mouse: false, // Disables momentum when dragging/zooming
      },
    });

    // Custom faster zoom handler (tuned)
    this.container.addEventListener('wheel', (e) => {
      // Only handle vertical wheel (usually scroll/zoom)
      if (e.deltaY === 0) return; 
      
      e.preventDefault();
      e.stopPropagation();

      const timeScale = this.chart.timeScale();
      const currentRange = timeScale.getVisibleLogicalRange();
      if (!currentRange) return;

      // Reduced from 0.20 to 0.05 for slower, smoother zooming
      const zoomFactor = 0.05; 
      const delta = e.deltaY > 0 ? 1 : -1;
      
      const rangeSize = currentRange.to - currentRange.from;
      const amountToZoom = rangeSize * zoomFactor * delta;

      const rect = this.container.getBoundingClientRect();
      const mouseX = e.clientX - rect.left;
      const proportion = Math.max(0, Math.min(1, mouseX / rect.width));

      const newFrom = currentRange.from - (amountToZoom * proportion);
      const newTo = currentRange.to + (amountToZoom * (1 - proportion));

      timeScale.setVisibleLogicalRange({ from: newFrom, to: newTo });
    }, { passive: false });

    // ---- Candlestick series ----
    this.candleSeries = this.chart.addCandlestickSeries({
      upColor: "#00d4aa",
      downColor: "#ff4976",
      borderUpColor: "#00d4aa",
      borderDownColor: "#ff4976",
      wickUpColor: "#00d4aa",
      wickDownColor: "#ff4976",
      priceLineVisible: false,
    });

    // ---- Hide loading spinner ----
    const loadingEl = document.getElementById("chart-loading");
    if (loadingEl) loadingEl.style.display = "none";

    // ---- Force correct size after CSS layout settles ----
    requestAnimationFrame(() => {
      const p = this.container.parentElement || this.container;
      const tw = p.offsetWidth;
      const th = p.offsetHeight;
      if (tw > 0 && th > 0) this.chart.resize(tw, th);
    });

    // ---- Initialize Volume Bubbles Custom Series ----
    this.bubbleSeriesCustom = new CustomBubbleSeries();
    this.bubbleSeries = this.chart.addCustomSeries(this.bubbleSeriesCustom, {
      priceLineVisible: false,
      lastValueVisible: false,
    });
    
    // Crosshair Sync for Legends
    this.chart.subscribeCrosshairMove(this._onCrosshairMove.bind(this));
  }

  /**
   * Apply user-defined theme settings to the chart
   * @param {Object} settings {bg, grid, up, down}
   */
  applyThemeSettings(settings) {
    if (!this.chart || !this.candleSeries) return;

    if (settings.bg || settings.grid) {
      const layoutOpts = {};
      const gridOpts = {};
      
      if (settings.bg) {
        layoutOpts.background = { type: "solid", color: settings.bg };
        // Update document body bg as well to match
        document.body.style.setProperty("--bg-primary", settings.bg);
      }
      
      if (settings.grid) {
        gridOpts.vertLines = { color: settings.grid };
        gridOpts.horzLines = { color: settings.grid };
        document.body.style.setProperty("--grid", settings.grid);
      }
      
      this.chart.applyOptions({
        layout: Object.keys(layoutOpts).length > 0 ? layoutOpts : undefined,
        grid: Object.keys(gridOpts).length > 0 ? gridOpts : undefined,
      });
    }

    if (settings.up || settings.down) {
      const candleOpts = {};
      if (settings.up) {
        candleOpts.upColor = settings.up;
        candleOpts.borderUpColor = settings.up;
        candleOpts.wickUpColor = settings.up;
        document.body.style.setProperty("--green", settings.up);
      }
      if (settings.down) {
        candleOpts.downColor = settings.down;
        candleOpts.borderDownColor = settings.down;
        candleOpts.wickDownColor = settings.down;
        document.body.style.setProperty("--red", settings.down);
      }
      this.candleSeries.applyOptions(candleOpts);
    }
  }

  // ======================== Data loading ========================

  /**
   * Load a full array of candle data into the chart.
   * @param {Array<{time:number, open:number, high:number, low:number, close:number, volume:number}>} candles
   */
  loadData(candles) {
    this.currentData = candles;

    const ohlcData = candles.map((c) => ({
      time: c.time,
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
    }));

    // Accumulate CVD
    let cvdSum = 0;
    const cvdData = candles.map(c => {
      const open = cvdSum;
      cvdSum += (c.delta || 0);
      const close = cvdSum;
      c._cvd = cvdSum; // cache on currentData for real-time updates
      return { 
        time: c.time, 
        open: open, 
        high: Math.max(open, close), 
        low: Math.min(open, close), 
        close: close 
      };
    });
    if (this.cvdSeries) {
      this.cvdSeries.setData(cvdData);
    }

    if (this.chartType === "candlestick") {
      this.candleSeries.setData(ohlcData);
    } else if (this.lineSeries) {
      this.lineSeries.setData(
        candles.map((c) => ({ time: c.time, value: c.close })),
      );
    }

    // Recalculate overlays
    this._recalculateIndicators();

    const bubbleData = computeBubbleData(candles);
    this.bubbleSeries.setData(bubbleData);

    // Force autoscale back on when loading completely new data
    this.chart.priceScale("right").applyOptions({ autoScale: true });
    this.chart.timeScale().fitContent();

    // Draw IST session-break lines
    this._drawSessionBreaks();

    // Compute + draw Volume Profile (after fitContent so coordinates are valid)
    requestAnimationFrame(() => {
      if (this.vpRenderer) this.vpRenderer.update(candles);
      if (this.lhRenderer) this.lhRenderer.setCandleData(candles);
    });
  }

  /**
   * Prepend older historical data (pagination).
   * @param {Array<{time:number, open:number, high:number, low:number, close:number, volume:number}>} olderCandles
   */
  prependData(olderCandles) {
    if (!olderCandles || olderCandles.length === 0) return;

    // Filter out overlap (e.g. if we fetched up to the exact time of our oldest candle)
    const oldestCurrentTime = this.currentData.length
      ? this.currentData[0].time
      : Infinity;
    const cleanOlder = olderCandles.filter((c) => c.time < oldestCurrentTime);
    if (cleanOlder.length === 0) return;

    const merged = [...cleanOlder, ...this.currentData];
    this.currentData = merged;

    const ohlcData = merged.map((c) => ({
      time: c.time,
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
    }));

    // lightweight-charts setData replaces the series, but natively maintains the visible logical range
    if (this.chartType === "candlestick") {
      this.candleSeries.setData(ohlcData);
    } else if (this.lineSeries) {
      this.lineSeries.setData(
        merged.map((c) => ({ time: c.time, value: c.close })),
      );
    }

    const bubbleData = computeBubbleData(merged);
    this.bubbleSeries.setData(bubbleData);

    this._recalculateIndicators();
    this._drawSessionBreaks();

    requestAnimationFrame(() => {
      if (this.vpRenderer) this.vpRenderer.update(merged);
      if (this.lhRenderer) this.lhRenderer.setCandleData(merged);
    });
  }

  /**
   * Update / append a single real-time candle.
   * @param {{time:number, open:number, high:number, low:number, close:number, volume:number, isClosed:boolean}} candle
   */
  updateCandle(candle) {
    const lastIndex = this.currentData.length - 1;
    let baseCvd = 0;
    
    if (lastIndex >= 0 && this.currentData[lastIndex].time === candle.time) {
      this.currentData[lastIndex] = candle;
      if (lastIndex > 0) baseCvd = this.currentData[lastIndex - 1]._cvd || 0;
    } else {
      if (lastIndex >= 0) baseCvd = this.currentData[lastIndex]._cvd || 0;
      this.currentData.push(candle);
    }

    candle._cvd = baseCvd + (candle.delta || 0);
    const cvdOpen = baseCvd;
    const cvdClose = candle._cvd;

    if (this.chartType === "candlestick") {
      this.candleSeries.update(candle);
    } else if (this.lineSeries) {
      this.lineSeries.update({ time: candle.time, value: candle.close });
    }

    if (this.cvdSeries) {
      this.cvdSeries.update({ 
        time: candle.time, 
        open: cvdOpen, 
        high: Math.max(cvdOpen, cvdClose), 
        low: Math.min(cvdOpen, cvdClose), 
        close: cvdClose 
      });
    }

    // Simple update for bubble (doesn't have perfect MA history for the single tick, but close enough)
    const lastBubble = this.bubbleSeries.dataByIndex(
      this.bubbleSeries.data().length - 1,
    );
    const avgVol =
      lastBubble && lastBubble.custom
        ? lastBubble.custom.avgVolume
        : candle.volume;
    this.bubbleSeries.update({
      time: candle.time,
      custom: {
        open: candle.open,
        close: candle.close,
        volume: candle.volume,
        avgVolume: avgVol,
      },
    });

    this._updateLegend(candle);

    // Only recalculate heavy indicators when the candle closes (perf)
    if (candle.isClosed) {
      this._recalculateIndicators();
    }
    
    if (this.vpRenderer) {
      this.vpRenderer.updateData(this.currentData);
    }
  }

  // ======================== Cumulative Volume Delta (CVD) ========================

  /** @private */
  _setupCVD() {
    this.cvdSeries = this.chart.addCandlestickSeries({
      priceScaleId: "cvd",
      upColor: "#00d4aa",
      downColor: "#ff4976",
      borderUpColor: "#00d4aa",
      borderDownColor: "#ff4976",
      wickUpColor: "#00d4aa",
      wickDownColor: "#ff4976",
      priceLineVisible: false,
      lastValueVisible: false,
    });
    // Margins are handled by the unified _recalculatePaneMargins system.
  }

  // ======================== Session Break Canvas ========================

  /** @private — create canvas SIBLING to #chart-container inside .chart-area */
  _setupSessionBreakCanvas() {
    const chartArea = this.container.parentElement;
    if (!chartArea) return;

    const canvas = document.createElement("canvas");
    canvas.id = "session-break-canvas";
    canvas.style.cssText =
      "position:absolute;inset:0;pointer-events:none;z-index:5;";
    chartArea.appendChild(canvas);
    this._sessionCanvas = canvas;

    this.chart.timeScale().subscribeVisibleLogicalRangeChange(() => {
      this._drawSessionBreaks();
    });
  }

  _updateLegend(candle) {
    if (!candle) return;
    const formatPrice = (p) => {
        if (p < 0.00001) return p.toFixed(8);
        if (p < 1) return p.toFixed(6);
        return p.toFixed(2);
    };
    
    const o = document.getElementById("legend-open");
    const h = document.getElementById("legend-high");
    const l = document.getElementById("legend-low");
    const c = document.getElementById("legend-close");
    const v = document.getElementById("legend-volume");

    if (o) {
        o.textContent = formatPrice(candle.open);
        o.className = candle.close >= candle.open ? "mono text-green" : "mono text-red";
    }
    if (h) h.textContent = formatPrice(candle.high);
    if (l) l.textContent = formatPrice(candle.low);
    if (c) {
        c.textContent = formatPrice(candle.close);
        c.className = candle.close >= candle.open ? "mono text-green" : "mono text-red";
    }
    if (v && candle.volume !== undefined) v.textContent = formatPrice(candle.volume);
  }

  _drawSessionBreaks() {
    const canvas = this._sessionCanvas;
    if (!canvas || !this.currentData.length) return;

    const area = canvas.parentElement;
    const W = area ? area.offsetWidth : this.container.offsetWidth;
    const H = area ? area.offsetHeight : this.container.offsetHeight;
    if (W === 0 || H === 0) return;

    canvas.width = W;
    canvas.height = H;

    const ctx = canvas.getContext("2d");
    ctx.clearRect(0, 0, W, H);

    const IST_OFFSET = 5.5 * 3600; // +19800 s
    const dayMap = new Map(); // istDayKey → first candle time in that IST day

    this.currentData.forEach((c) => {
      const istSec = c.time + IST_OFFSET;
      const istDayKey = Math.floor(istSec / 86400);
      const sessionOpenUTC = Math.floor(c.time / 86400) * 86400;
      if (!dayMap.has(istDayKey)) {
        dayMap.set(istDayKey, sessionOpenUTC);
      }
    });

    ctx.save();
    ctx.setLineDash([2, 5]); // 2px dot, 5px gap
    ctx.lineWidth = 1;
    ctx.strokeStyle = "rgba(100, 149, 237, 0.35)"; // subtle blue

    dayMap.forEach((sessionOpenTime) => {
      const x = this.chart.timeScale().timeToCoordinate(sessionOpenTime);
      if (x === null || x < 0 || x > W) return;

      const px = Math.round(x) + 0.5;
      ctx.beginPath();
      ctx.moveTo(px, 0);
      ctx.lineTo(px, H);
      ctx.stroke();
    });

    ctx.restore();
  }

  // ======================== Chart type switching ========================

  /**
   * Switch between 'candlestick' and 'line' chart types.
   * @param {'candlestick'|'line'} type
   */
  setChartType(type) {
    if (type === this.chartType) return;
    this.chartType = type;

    if (type === "line") {
      this.candleSeries.applyOptions({ visible: false });
      if (!this.lineSeries) {
        this.lineSeries = this.chart.addLineSeries({
          color: "#4a9eff",
          lineWidth: 2,
          crosshairMarkerVisible: true,
          crosshairMarkerRadius: 4,
          priceLineVisible: false,
        });
      }
      this.lineSeries.applyOptions({ visible: true });
      this.lineSeries.setData(
        this.currentData.map((c) => ({ time: c.time, value: c.close })),
      );
    } else {
      this.candleSeries.applyOptions({ visible: true });
      if (this.lineSeries) {
        this.lineSeries.applyOptions({ visible: false });
      }
    }
  }

  // ======================== Panes Layout Helper ========================

  /** @private */
  _recalculatePaneMargins() {
    let panes = [];
    if (this.cvdSeries) panes.push("cvd");
    for (const [id, ind] of this.indicators) {
      if (ind.type === "rsi" || ind.type === "macd") panes.push(id);
    }
    this.activeSubPanes = panes;

    // Reset boundaries if pane count changed
    if (this.paneBoundaries.length !== panes.length) {
      this.paneBoundaries = [];
      const paneHeight = 0.18; // Default 18% per pane
      let cumulative = 0;
      for (let i = 0; i < panes.length; i++) {
        cumulative += paneHeight;
        this.paneBoundaries.push(cumulative);
      }
    }
    
    this._applyPaneBoundaries();
    this._updateLegendPositions();
  }

  /** @private */
  _applyPaneBoundaries() {
    const panes = this.activeSubPanes;
    
    // Clear old static dividers
    document.querySelectorAll(".static-pane-divider").forEach(el => el.remove());

    if (panes.length === 0) {
      // No sub-panes: main chart gets full height
      this.chart.priceScale("right").applyOptions({
        scaleMargins: { top: 0.1, bottom: 0.03 },
      });
      return;
    }

    // Total bottom space reserved for all sub-panes
    const totalBottom = this.paneBoundaries[this.paneBoundaries.length - 1];
    
    // Main price chart: top 0.1, bottom = totalBottom + small gap
    this.chart.priceScale("right").applyOptions({
      scaleMargins: { top: 0.1, bottom: totalBottom + 0.02 },
    });

    // Get the actual chart area and time scale height for pixel-accurate positioning.
    // scaleMargins are fractions of the PLOTTING area (chart height - time scale).
    // CSS positions are relative to the full chart-area container.
    const chartArea = document.querySelector(".chart-area");
    if (!chartArea) return;
    
    const containerH = chartArea.offsetHeight;
    const timeScaleH = this.chart.timeScale().height() || 30;
    const plotH = containerH - timeScaleH;

    for (let i = 0; i < panes.length; i++) {
      const paneId = panes[i];
      const paneBottom = i === 0 ? 0 : this.paneBoundaries[i - 1];
      const paneTop = this.paneBoundaries[i];
      
      const scaleTop = 1 - paneTop + 0.01;
      const scaleBottom = paneBottom + 0.01;
      
      this.chart.priceScale(paneId).applyOptions({
        scaleMargins: { top: scaleTop, bottom: scaleBottom },
      });
      
      // Calculate divider pixel position from the bottom of the container.
      // The boundary "paneTop" is a fraction of the plotting area,
      // so in pixels from bottom of plotting area: paneTop * plotH.
      // Add time scale height to get position from container bottom.
      const borderBottomPx = timeScaleH + (paneTop * plotH);
      
      const divider = document.createElement("div");
      divider.className = "static-pane-divider";
      divider.style.cssText = `
        position: absolute; left: 0; right: 0;
        bottom: ${borderBottomPx - 5}px;
        height: 10px; cursor: ns-resize;
        z-index: 200; pointer-events: auto;
      `;
      
      // Inner visible line
      const line = document.createElement("div");
      line.style.cssText = `
        position: absolute; top: 4px; left: 0; right: 0;
        height: 0; border-top: 1px dotted rgba(255,255,255,0.4);
        pointer-events: none;
      `;
      divider.appendChild(line);
      chartArea.appendChild(divider);

      // Drag logic (closure over index i)
      const idx = i;
      let isDragging = false;
      
      const onPointerMove = (e) => {
        if (!isDragging) return;
        const rect = chartArea.getBoundingClientRect();
        const tsH = this.chart.timeScale().height() || 30;
        const pH = rect.height - tsH;
        
        let y = e.clientY - rect.top;
        y = Math.max(0, Math.min(rect.height, y));
        
        // Convert y (from top of container) to boundary fraction (of plot area, from bottom)
        // Plot area starts at y=0 and ends at y=pH. Time scale is below that.
        let newBoundary = (pH - y) / pH;
        
        // Constrain: min 5% gap between adjacent boundaries
        const minGap = 0.05;
        const lower = idx === 0 ? minGap : this.paneBoundaries[idx - 1] + minGap;
        const upper = idx === panes.length - 1 ? 0.8 : this.paneBoundaries[idx + 1] - minGap;
        newBoundary = Math.max(lower, Math.min(upper, newBoundary));
        
        this.paneBoundaries[idx] = newBoundary;
        this._applyPaneBoundaries();
        this._updateLegendPositions();
      };
      
      const onPointerUp = () => {
        if (!isDragging) return;
        isDragging = false;
        document.body.style.cursor = "";
        window.removeEventListener("pointermove", onPointerMove);
        window.removeEventListener("pointerup", onPointerUp);
      };
      
      divider.addEventListener("pointerdown", (e) => {
        e.preventDefault();
        isDragging = true;
        document.body.style.cursor = "ns-resize";
        window.addEventListener("pointermove", onPointerMove);
        window.addEventListener("pointerup", onPointerUp);
      });
    }
  }

  // ======================== TV Legends Helper ========================

  /** @private */
  _createLegend(id, type, params, color, priceScaleId) {
    const container = document.getElementById("tv-legends-container");
    if (!container) return;

    const el = document.createElement("div");
    el.className = "tv-legend-item";
    el.id = `tv-legend-${id}`;
    el.dataset.scaleId = priceScaleId;
    el.style.color = color;

    const title = document.createElement("div");
    title.className = "tv-legend-title";
    title.innerText = type.toUpperCase() + (params.period ? ` ${params.period}` : "");
    
    const values = document.createElement("div");
    values.className = "tv-legend-values";
    values.id = `tv-legend-values-${id}`;
    
    const actions = document.createElement("div");
    actions.className = "tv-legend-actions";
    actions.style.display = "flex";
    actions.style.gap = "4px";

    if (params && params.period) {
      const settingsBtn = document.createElement("button");
      settingsBtn.className = "tv-legend-btn";
      settingsBtn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path></svg>`;
      settingsBtn.title = "Settings";
      settingsBtn.onclick = () => {
        const newPeriodStr = prompt(`Enter new period for ${type.toUpperCase()}`, params.period);
        if (newPeriodStr !== null) {
          const newPeriod = parseInt(newPeriodStr);
          if (!isNaN(newPeriod) && newPeriod > 0) {
            this.updateIndicatorParams(id, { period: newPeriod });
          }
        }
      };
      actions.appendChild(settingsBtn);
    }

    const closeBtn = document.createElement("button");
    closeBtn.className = "tv-legend-btn";
    closeBtn.innerHTML = "&times;";
    closeBtn.title = "Remove";
    closeBtn.onclick = () => this.removeIndicator(id);
    actions.appendChild(closeBtn);

    el.appendChild(title);
    el.appendChild(values);
    el.appendChild(actions);
    container.appendChild(el);
    
    this._updateLegendPositions();
  }

  /**
   * Update indicator parameters dynamically.
   * @param {string} id 
   * @param {object} newParams 
   */
  updateIndicatorParams(id, newParams) {
    const indicator = this.indicators.get(id);
    if (!indicator) return;
    
    indicator.params = { ...indicator.params, ...newParams };
    
    const title = document.querySelector(`#tv-legend-${id} .tv-legend-title`);
    if (title) {
      title.innerText = indicator.type.toUpperCase() + (indicator.params.period ? ` ${indicator.params.period}` : "");
    }
    
    this._recalculateIndicators();
    
    if (this.onIndicatorUpdated) {
      this.onIndicatorUpdated(id, indicator);
    }
  }

  /** @private */
  _removeLegend(id) {
    const el = document.getElementById(`tv-legend-${id}`);
    if (el) el.remove();
    this._updateLegendPositions();
  }

  /** @private */
  _updateLegendPositions() {
    // Stack overlays at the top
    let overlayTop = 10;
    
    const chartArea = document.querySelector(".chart-area");
    const containerH = chartArea ? chartArea.offsetHeight : 600;
    const timeScaleH = this.chart.timeScale().height() || 30;
    const plotH = containerH - timeScaleH;
    
    for (const [id, ind] of this.indicators) {
      const el = document.getElementById(`tv-legend-${id}`);
      if (!el) continue;
      
      const scaleId = el.dataset.scaleId;
      if (scaleId === "right") {
        el.style.position = "absolute";
        el.style.left = "60px";
        el.style.top = `${overlayTop}px`;
        overlayTop += 20;
      } else {
        // Pane indicator (RSI/MACD) — position using pixel math
        const opts = this.chart.priceScale(scaleId).options();
        const topPx = opts.scaleMargins.top * plotH;
        el.style.position = "absolute";
        el.style.left = "60px";
        el.style.top = `${topPx + 5}px`;
      }
    }
  }

  /** @private */
  _onCrosshairMove(param) {
    if (!param.time) return; // Cursor out of bounds
    
    for (const [id, ind] of this.indicators) {
      const valuesDiv = document.getElementById(`tv-legend-values-${id}`);
      if (!valuesDiv) continue;
      
      valuesDiv.innerHTML = "";
      
      ind.series.forEach((s, idx) => {
        const data = param.seriesData.get(s);
        let val = data ? (data.value !== undefined ? data.value : data.close) : null;
        
        if (val !== null) {
          const span = document.createElement("span");
          span.className = "tv-legend-value";
          span.innerText = val.toFixed(2);
          
          // Use MACD histogram colors if applicable
          if (ind.type === "macd" && idx === 0 && data.color) {
             span.style.color = data.color;
          } else if (ind.type === "macd" && idx === 1) {
             span.style.color = "#4a9eff"; // MACD line
          } else if (ind.type === "macd" && idx === 2) {
             span.style.color = "#ff9f43"; // Signal line
          }
          
          valuesDiv.appendChild(span);
        }
      });
    }
  }

  // ======================== Indicators ========================

  /**
   * Add an overlay indicator to the chart.
   * @param {'sma'|'ema'|'rsi'|'macd'} type
   * @param {object} params — { period: 20 }
   * @returns {{ id: string, color: string, type: string, params: object }}
   */
  addIndicator(type, params = {}) {
    const id = `${type}_${params.period || 20}_${Date.now()}`;
    const color =
      this.indicatorColors[this.nextColorIndex % this.indicatorColors.length];
    this.nextColorIndex++;

    if (type === "rsi") {
      const data = calculateRSI(this.currentData, params.period || 14);
      const series = this.chart.addLineSeries({
        priceScaleId: id,
        color: "#a855f7",
        lineWidth: 2,
        priceLineVisible: false,
      });
      series.setData(data);
      
      // Add RSI 30/70 levels
      series.createPriceLine({
        price: 30,
        color: 'rgba(255, 255, 255, 0.2)',
        lineWidth: 1,
        lineStyle: LightweightCharts.LineStyle.Dashed,
        axisLabelVisible: true,
        title: '30',
      });
      series.createPriceLine({
        price: 70,
        color: 'rgba(255, 255, 255, 0.2)',
        lineWidth: 1,
        lineStyle: LightweightCharts.LineStyle.Dashed,
        axisLabelVisible: true,
        title: '70',
      });

      this.indicators.set(id, { type, params, series: [series], color });
      this._createLegend(id, type, params, color, id); // id is also the priceScaleId
      this._recalculatePaneMargins();
    } else if (type === "macd") {
      const data = calculateMACD(this.currentData, 12, 26, 9);
      
      const histSeries = this.chart.addHistogramSeries({
        priceScaleId: id,
        priceLineVisible: false,
      });
      // Color histogram green/red
      histSeries.setData(data.hist.map(d => ({
        time: d.time,
        value: d.value,
        color: d.value >= 0 ? 'rgba(0, 212, 170, 0.5)' : 'rgba(255, 73, 118, 0.5)'
      })));

      const macdSeries = this.chart.addLineSeries({
        priceScaleId: id,
        color: "#4a9eff",
        lineWidth: 2,
        priceLineVisible: false,
      });
      macdSeries.setData(data.macd);

      const signalSeries = this.chart.addLineSeries({
        priceScaleId: id,
        color: "#ff9f43",
        lineWidth: 2,
        priceLineVisible: false,
      });
      signalSeries.setData(data.signal);

      this.indicators.set(id, { type, params, series: [histSeries, macdSeries, signalSeries], color });
      this._createLegend(id, type, params, color, id);
      this._recalculatePaneMargins();
    } else {
      const calcFn = type === "ema" ? calculateEMA : calculateSMA;
      const data = calcFn(this.currentData, params.period || 20);

      const series = this.chart.addLineSeries({ color, lineWidth: 2 });
      series.setData(data);

      this.indicators.set(id, { type, params, series: [series], color });
      this._createLegend(id, type, params, color, "right"); // overlays on right scale
    }

    return { id, color, type, params };
  }

  /**
   * Remove an indicator by its id.
   * @param {string} id
   */
  removeIndicator(id) {
    const indicator = this.indicators.get(id);
    if (indicator) {
      indicator.series.forEach((s) => this.chart.removeSeries(s));
      this.indicators.delete(id);
      this._removeLegend(id);
      if (indicator.type === "rsi" || indicator.type === "macd") {
        this._recalculatePaneMargins();
      }
      if (this.onIndicatorRemoved) {
        this.onIndicatorRemoved(id, indicator.type);
      }
    }
  }

  /** @private — recalculate all active indicators from currentData */
  _recalculateIndicators() {
    for (const [id, indicator] of this.indicators) {
      if (indicator.type === "rsi") {
        const data = calculateRSI(this.currentData, indicator.params.period || 14);
        indicator.series[0].setData(data);
      } else if (indicator.type === "macd") {
        const data = calculateMACD(this.currentData, 12, 26, 9);
        indicator.series[0].setData(data.hist.map(d => ({
          time: d.time,
          value: d.value,
          color: d.value >= 0 ? 'rgba(0, 212, 170, 0.5)' : 'rgba(255, 73, 118, 0.5)'
        })));
        indicator.series[1].setData(data.macd);
        indicator.series[2].setData(data.signal);
      } else {
        const calcFn = indicator.type === "ema" ? calculateEMA : calculateSMA;
        const data = calcFn(this.currentData, indicator.params.period || 20);
        indicator.series[0].setData(data);
      }
    }
  }

  // ======================== Volume Profile ========================

  /** @private — create VolumeProfileRenderer attached to .chart-area */
  _setupVolumeProfile() {
    const chartArea = this.container.parentElement;
    if (!chartArea) return;
    this.vpRenderer = new VolumeProfileRenderer(
      this.chart,
      this.candleSeries,
      chartArea,
    );
  }

  // ======================== Liquidation Heatmap ========================

  /** @private */
  _setupLiquidationHeatmap() {
    const chartArea = this.container.parentElement;
    if (!chartArea) return;
    this.lhRenderer = new LiquidationHeatmapRenderer(
      this.chart,
      this.candleSeries,
      chartArea,
      "BTCUSDT"
    );
  }

  // ======================== Drawing Manager =======================

  /** @private — create DrawingManager attached to .chart-area */
  _setupDrawingManager() {
    const chartArea = this.container.parentElement;
    if (!chartArea) return;
    this.drawingManager = new DrawingManager(
      this.chart,
      this.candleSeries,
      chartArea,
    );
  }

  // ======================== Resize handling ========================

  /** @private — observe the PARENT (chart-area) which has real CSS dimensions */
  _setupResizeObserver() {
    const target = this.container.parentElement || this.container;
    this.resizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect;
        if (width > 0 && height > 0) {
          this.chart.resize(width, height);
          requestAnimationFrame(() => {
            this._drawSessionBreaks();
            if (this.vpRenderer) this.vpRenderer.onResize();
            if (this.lhRenderer) this.lhRenderer.redraw();
            if (this.drawingManager) this.drawingManager.onResize();
            // Reposition pixel-based pane dividers after resize
            if (this.activeSubPanes.length > 0) {
              this._applyPaneBoundaries();
              this._updateLegendPositions();
            }
          });
        }
      }
    });
    this.resizeObserver.observe(target);
  }

  /** Force a resize to match the container dimensions. */
  resize() {
    if (this.container && this.chart) {
      this.chart.resize(
        this.container.clientWidth,
        this.container.clientHeight,
      );
    }
  }

  /** Subscribe to scroll events to trigger pagination when reaching the left edge. */
  onScrollEdge(callback) {
    this.chart
      .timeScale()
      .subscribeVisibleLogicalRangeChange((logicalRange) => {
        if (logicalRange && logicalRange.from < 50) {
          callback();
        }
      });
  }

  /** Subscribe to visible logical range changes to track distance from real-time. */
  onVisibleRangeChange(callback) {
    this.chart
      .timeScale()
      .subscribeVisibleLogicalRangeChange((logicalRange) => {
        // Pass the difference between the latest data index and the rightmost visible index
        if (logicalRange && this.currentData.length) {
          const distFromEnd = this.currentData.length - 1 - logicalRange.to;
          callback(distFromEnd);
        }
      });
  }

  /** Scroll the chart instantly to the most recent candle. */
  scrollToRealTime() {
    this.chart.timeScale().scrollToRealTime();
  }

  /** Toggle Logarithmic scale mode. */
  setLogScale(isLog) {
    this.chart.priceScale("right").applyOptions({
      mode: isLog
        ? LightweightCharts.PriceScaleMode.Logarithmic
        : LightweightCharts.PriceScaleMode.Normal,
    });
  }

  /** Get current Log scale mode. */
  isLogScale() {
    const opts = this.chart.priceScale("right").options();
    return opts.mode === LightweightCharts.PriceScaleMode.Logarithmic;
  }

  /** Fit all data into the visible viewport. */
  fitContent() {
    this.chart.timeScale().fitContent();
  }

  // ======================== Replay Mode ========================

  /**
   * Start replay mode by slicing data at `startIndex`.
   * @param {number} startIndex - The index in this.currentData to slice at.
   */
  startReplay(startIndex) {
    if (this.currentData.length === 0 || startIndex < 0 || startIndex >= this.currentData.length) return;
    
    this.isReplayMode = true;
    this.fullData = [...this.currentData]; // backup full history
    
    this.replayFutureData = this.currentData.slice(startIndex);
    const pastData = this.currentData.slice(0, startIndex);
    
    // Completely replace chart data with the pastData
    this.loadData(pastData);
  }

  /**
   * Feed the next candle from future data into the chart.
   * @returns {boolean} true if successful, false if end of data
   */
  stepReplay() {
    if (!this.isReplayMode || this.replayFutureData.length === 0) return false;
    
    const nextCandle = this.replayFutureData.shift();
    // Simulate a closed candle tick to trigger indicator/profile updates
    nextCandle.isClosed = true;
    this.updateCandle(nextCandle);
    return true;
  }

  /**
   * Exit replay mode and restore full data.
   */
  exitReplay() {
    if (!this.isReplayMode) return;
    this.isReplayMode = false;
    this.loadData(this.fullData);
    this.replayFutureData = [];
    this.fullData = [];
  }

  /** Tear down the chart and all observers. */
  destroy() {
    if (this.resizeObserver) this.resizeObserver.disconnect();
    if (this._sessionCanvas) this._sessionCanvas.remove();
    if (this.vpRenderer) this.vpRenderer.destroy();
    if (this.drawingManager) {
      this.drawingManager.destroy();
    }
    if (this.chart) {
      this.chart.remove();
      this.chart = null;
    }
  }
}
