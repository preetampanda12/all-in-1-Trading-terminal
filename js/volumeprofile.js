// ============================================================
// volumeprofile.js — Fixed Range Volume Profile (FRVP)
// All parameters are configurable via getSettings/applySettings.
// Settings are persisted in localStorage.
// ============================================================

const STORAGE_KEY = "ct_vp_settings";

// ── Default settings ─────────────────────────────────────────
const DEFAULTS = {
  sessionStartIST: "05:30", // IST time string HH:MM
  sessionEndIST: "17:30", // IST time string HH:MM
  rows: 24,
  valueAreaPct: 70, // 0-100
  widthPct: 5, // 0-100  (max bar width as % of chart width)
  enabled: true,
  colorVA: "#4a9eff", // Value Area color (blue)
  colorOutside: "#4a9eff", // Outside VA color (blue)
  colorPOC: "#ffb800", // POC color (amber)
  opacityVA: 45, // 0-100
  opacityOutside: 15, // 0-100
};

// ── Color helper ─────────────────────────────────────────────
function hexToRgba(hex, opacityPct) {
  let c = hex.replace("#", "");
  if (c.length === 3)
    c = c
      .split("")
      .map((x) => x + x)
      .join("");
  const r = parseInt(c.substring(0, 2), 16);
  const g = parseInt(c.substring(2, 4), 16);
  const b = parseInt(c.substring(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${opacityPct / 100})`;
}

// ── Round-rect helper ────────────────────────────────────────
/**
 * Draw a rounded rectangle path (does NOT fill/stroke — caller does that).
 * @param {CanvasRenderingContext2D} ctx
 * @param {number} x
 * @param {number} y
 * @param {number} w
 * @param {number} h
 * @param {number[]|number} radii - [topLeft, topRight, bottomRight, bottomLeft] or single number
 */
function _roundRect(ctx, x, y, w, h, radii) {
  if (typeof ctx.roundRect === "function") {
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, radii);
    return;
  }
  // Fallback for older browsers
  const r = Array.isArray(radii) ? radii : [radii, radii, radii, radii];
  const [tl, tr, br, bl] = r;
  ctx.beginPath();
  ctx.moveTo(x + tl, y);
  ctx.lineTo(x + w - tr, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + tr);
  ctx.lineTo(x + w, y + h - br);
  ctx.quadraticCurveTo(x + w, y + h, x + w - br, y + h);
  ctx.lineTo(x + bl, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - bl);
  ctx.lineTo(x, y + tl);
  ctx.quadraticCurveTo(x, y, x + tl, y);
  ctx.closePath();
}

// ── Settings helpers ─────────────────────────────────────────

/** Return current VP settings (merged with defaults). */
export function getVPSettings() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return { ...DEFAULTS, ...JSON.parse(raw) };
  } catch {
    /* ignore parse errors */
  }
  return { ...DEFAULTS };
}

/** Persist VP settings to localStorage. */
export function saveVPSettings(patch) {
  const current = getVPSettings();
  const merged = { ...current, ...patch };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(merged));
  return merged;
}

/**
 * Convert an IST "HH:MM" string to seconds-from-UTC-midnight.
 * IST = UTC + 5:30, so subtract 5.5 hours.
 */
function istToUTCOffset(istTime) {
  const [h, m] = istTime.split(":").map(Number);
  let sec = h * 3600 + m * 60 - 19800; // -5.5h
  if (sec < 0) sec += 86400;
  return sec;
}

// ── Pure computation ─────────────────────────────────────────

/**
 * Build VP data for every daily IST session found in candles.
 * @param {Array<{time,high,low,close,volume}>} candles
 * @param {object} settings - VP settings
 * @returns {Array<SessionVP>}
 */
export function buildSessionVPs(candles, settings) {
  const sessionStart = istToUTCOffset(settings.sessionStartIST);
  const sessionEnd = istToUTCOffset(settings.sessionEndIST);
  const rows = settings.rows;
  const vaPct = settings.valueAreaPct / 100;

  const map = new Map(); // dayStartUTC → candle[]
  candles.forEach((c) => {
    const dayStart = Math.floor(c.time / 86400) * 86400;
    const timeInDay = c.time - dayStart;

    // Handle sessions that cross midnight UTC
    if (sessionStart < sessionEnd) {
      // Normal: start < end, e.g. 00:00–12:00 UTC
      if (timeInDay >= sessionStart && timeInDay < sessionEnd) {
        if (!map.has(dayStart)) map.set(dayStart, []);
        map.get(dayStart).push(c);
      }
    } else {
      // Wrapping: start > end, e.g. 23:00–11:00 UTC
      if (timeInDay >= sessionStart) {
        if (!map.has(dayStart)) map.set(dayStart, []);
        map.get(dayStart).push(c);
      } else if (timeInDay < sessionEnd) {
        const prevDay = dayStart - 86400;
        if (!map.has(prevDay)) map.set(prevDay, []);
        map.get(prevDay).push(c);
      }
    }
  });

  const sessions = [];
  map.forEach((sc, dayStart) => {
    if (sc.length < 2) return;
    const vp = _computeVP(sc, rows, vaPct);
    if (vp) {
      sessions.push({
        startTime: dayStart + sessionStart,
        endTime:
          sessionStart < sessionEnd
            ? dayStart + sessionEnd
            : dayStart + 86400 + sessionEnd,
        ...vp,
      });
    }
  });
  return sessions.sort((a, b) => a.startTime - b.startTime);
}

function _computeVP(candles, rows, vaPct) {
  const hi = Math.max(...candles.map((c) => c.high));
  const lo = Math.min(...candles.map((c) => c.low));
  if (hi <= lo) return null;

  const binSize = (hi - lo) / rows;

  const bins = Array.from({ length: rows }, (_, i) => ({
    priceLow: lo + i * binSize,
    priceHigh: lo + (i + 1) * binSize,
    priceMid: lo + (i + 0.5) * binSize,
    volume: 0,
  }));

  // Proportional volume distribution across overlapping bins
  candles.forEach((c) => {
    const range = c.high - c.low;
    if (range === 0) {
      const idx = Math.min(
        rows - 1,
        Math.max(0, Math.floor((c.close - lo) / binSize)),
      );
      bins[idx].volume += c.volume;
      return;
    }
    bins.forEach((bin) => {
      const overlap =
        Math.min(c.high, bin.priceHigh) - Math.max(c.low, bin.priceLow);
      if (overlap > 0) bin.volume += c.volume * (overlap / range);
    });
  });

  const totalVolume = bins.reduce((s, b) => s + b.volume, 0);
  if (totalVolume === 0) return null;

  const maxVolume = Math.max(...bins.map((b) => b.volume));
  const pocIdx = bins.findIndex((b) => b.volume === maxVolume);

  // Value Area: expand from POC until ≥vaPct of total volume captured
  let vaLo = pocIdx,
    vaHi = pocIdx,
    vaVol = bins[pocIdx].volume;
  while (vaVol / totalVolume < vaPct) {
    const canUp = vaHi < rows - 1;
    const canDown = vaLo > 0;
    if (!canUp && !canDown) break;
    const up = canUp ? bins[vaHi + 1].volume : -Infinity;
    const down = canDown ? bins[vaLo - 1].volume : -Infinity;
    if (up >= down) {
      vaHi++;
      vaVol += bins[vaHi].volume;
    } else {
      vaLo--;
      vaVol += bins[vaLo].volume;
    }
  }

  return {
    bins,
    pocIdx,
    vaLoIdx: vaLo,
    vaHiIdx: vaHi,
    maxVolume,
    totalVolume,
    hi,
    lo,
  };
}

// ── Canvas renderer ──────────────────────────────────────────

export class VolumeProfileRenderer {
  /**
   * @param {object}  chart       - lightweight-charts instance
   * @param {object}  priceSeries - the candlestick/line series
   * @param {Element} chartArea   - the .chart-area DOM element
   */
  constructor(chart, priceSeries, chartArea) {
    this.chart = chart;
    this.series = priceSeries;
    this.chartArea = chartArea;
    this._canvas = null;
    this._sessions = [];
    this._rawCandles = [];
    this.settings = getVPSettings();
    this._rafId = 0; // rAF throttle id

    this._initCanvas();

    // Trigger redraw throttled by rAF
    const triggerRedraw = () => {
      if (this._rafId) return;
      this._rafId = requestAnimationFrame(() => {
        this._rafId = 0;
        this.redraw();
      });
    };

    chart.timeScale().subscribeVisibleLogicalRangeChange(triggerRedraw);

    // Lightweight-charts doesn't emit events for vertical price scale changes.
    // We bind to DOM events on the chart container to catch Y-axis panning/zooming.
    chartArea.addEventListener("wheel", triggerRedraw, { passive: true });
    chartArea.addEventListener(
      "pointermove",
      (e) => {
        // Only trigger if a button is pressed (dragging) or if we are just moving (crosshair sync)
        // Actually, since crosshair move can also feel like a redraw is needed, we trigger it.
        triggerRedraw();
      },
      { passive: true },
    );
    chartArea.addEventListener("pointerdown", triggerRedraw, { passive: true });
  }

  _initCanvas() {
    const c = document.createElement("canvas");
    c.id = "vp-canvas";
    c.style.cssText =
      "position:absolute;inset:0;pointer-events:none;z-index:6;";
    this.chartArea.appendChild(c);
    this._canvas = c;
  }

  /** Apply new settings, recompute, redraw. */
  applySettings(newSettings) {
    this.settings = { ...this.settings, ...newSettings };
    saveVPSettings(this.settings);
    if (this._rawCandles.length) {
      this.update(this._rawCandles);
    }
  }

  setVisibility(enabled) {
    this.applySettings({ enabled });
  }

  /** Recompute from raw candles then redraw. */
  update(candles) {
    this._rawCandles = candles;
    if (!this.settings.enabled) {
      this._sessions = [];
      this.redraw();
      return;
    }
    this._sessions = buildSessionVPs(candles, this.settings);
    this.redraw();
  }

  /** Redraw all sessions onto the canvas. */
  redraw() {
    const canvas = this._canvas;
    if (!canvas) return;

    const W = this.chartArea.offsetWidth;
    const H = this.chartArea.offsetHeight;
    if (!W || !H) return;

    // Only resize the canvas buffer when dimensions actually change
    if (canvas.width !== W || canvas.height !== H) {
      canvas.width = W;
      canvas.height = H;
    }

    const ctx = canvas.getContext("2d");
    ctx.clearRect(0, 0, W, H);

    if (!this.settings.enabled || !this._sessions.length) return;

    const maxBarPx = W * (this.settings.widthPct / 100);

    try {
      this._sessions.forEach((s) => this._drawSession(ctx, s, W, H, maxBarPx));
    } catch (e) {
      // Silently swallow rendering errors so the chart stays usable
      console.warn("[VP] render error:", e);
    }
  }

  _drawSession(ctx, session, W, H, maxBarPx) {
    if (!session || !session.bins || !session.bins.length) return;

    const ts = this.chart.timeScale();
    const xS = ts.timeToCoordinate(session.startTime);
    const xE = ts.timeToCoordinate(session.endTime);
    if (xS === null || xS > W) return;
    if (xE !== null && xE < 0) return;

    const { bins, pocIdx, vaLoIdx, vaHiIdx, maxVolume, totalVolume } = session;
    if (!maxVolume || maxVolume <= 0) return;

    const lineRight =
      xE !== null ? Math.min(xE, W) : Math.min(xS + maxBarPx, W);
    const gap = 0.5; // sub-pixel gap between bins for clean visual separation

    // ── Performance Optimization: Interpolate Y coordinates ──
    // priceToCoordinate is expensive. Instead of calling it 48 times per session,
    // we call it twice (for hi and lo) and interpolate the rest linearly.
    const yTopPx = this.series.priceToCoordinate(session.hi);
    const yBotPx = this.series.priceToCoordinate(session.lo);
    if (yTopPx === null || yBotPx === null) return;

    // pxPerPrice tells us how many pixels per $1 change. (Prices go down as Y goes up on screen)
    const priceRange = session.hi - session.lo;
    const pxPerPrice = priceRange > 0 ? (yBotPx - yTopPx) / priceRange : 0;

    const getPx = (price) => yTopPx + (session.hi - price) * pxPerPrice;

    // Resolve colors from settings
    const colorPOCFill = hexToRgba(this.settings.colorPOC, 70);
    const colorVAFill = hexToRgba(
      this.settings.colorVA,
      this.settings.opacityVA,
    );
    const colorOutFill = hexToRgba(
      this.settings.colorOutside,
      this.settings.opacityOutside,
    );

    // ── Bins (smooth filled bars, no stroke borders) ─────────
    bins.forEach((bin, i) => {
      if (!bin || bin.volume < 0.001) return;

      const y1 = getPx(bin.priceHigh);
      const y2 = getPx(bin.priceLow);

      const yT = Math.min(y1, y2) + gap;
      const yB = Math.max(y1, y2) - gap;
      const bH = Math.max(1, yB - yT);
      const bW = Math.max(1, (bin.volume / maxVolume) * maxBarPx);

      // Skip if out of vertical bounds
      if (yT > H || yB < 0) return;

      ctx.fillStyle =
        i === pocIdx
          ? colorPOCFill
          : i >= vaLoIdx && i <= vaHiIdx
            ? colorVAFill
            : colorOutFill;

      // Rounded right edge for a polished look
      const r = Math.min(2, bH / 2, bW / 2);
      _roundRect(ctx, xS, yT, bW, bH, [0, r, r, 0]); // flat left, rounded right
      ctx.fill();
    });

    // ── POC line (full session width, dashed amber) ──────────
    if (pocIdx >= 0 && pocIdx < bins.length) {
      const pocBin = bins[pocIdx];
      const pocY = getPx(pocBin.priceMid);
      if (pocY !== null && pocY >= 0 && pocY <= H) {
        ctx.save();
        ctx.strokeStyle = this.settings.colorPOC;
        ctx.lineWidth = 1.5;
        ctx.setLineDash([6, 3]);
        ctx.beginPath();
        ctx.moveTo(xS, Math.round(pocY) + 0.5);
        ctx.lineTo(lineRight, Math.round(pocY) + 0.5);
        ctx.stroke();
        ctx.setLineDash([]);

        // POC label badge
        ctx.fillStyle = hexToRgba(this.settings.colorPOC, 18);
        const lw = 28,
          lh = 13;
        ctx.fillRect(xS + 3, pocY - lh - 1, lw, lh);
        ctx.fillStyle = this.settings.colorPOC;
        ctx.font = "bold 8.5px Inter, sans-serif";
        ctx.textAlign = "left";
        ctx.fillText("POC", xS + 6, pocY - 4);
        ctx.restore();
      }
    }

    // ── Total volume label ───────────────────────────────────
    if (totalVolume > 0) {
      const topY = this.series.priceToCoordinate(session.hi);
      if (topY !== null && topY > 0 && topY < H) {
        const volStr =
          totalVolume >= 1e6
            ? (totalVolume / 1e6).toFixed(1) + "M"
            : totalVolume >= 1e3
              ? (totalVolume / 1e3).toFixed(1) + "K"
              : totalVolume.toFixed(0);

        ctx.save();
        ctx.fillStyle = "rgba(255,255,255,0.30)";
        ctx.font = "8px JetBrains Mono, monospace";
        ctx.textAlign = "left";
        ctx.fillText(`Vol ${volStr}`, xS + 3, topY + 10);
        ctx.restore();
      }
    }
  }

  /** Called when the chart resizes. */
  onResize() {
    this.redraw();
  }

  destroy() {
    if (this._canvas) {
      this._canvas.remove();
      this._canvas = null;
    }
  }
}
