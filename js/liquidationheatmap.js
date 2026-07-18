const STORAGE_KEY = "ct_lh_settings";

const DEFAULTS = {
  enabled: false,
  widthPct: 15,
  opacity: 25,
};

export function getLHSettings() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return { ...DEFAULTS, ...JSON.parse(raw) };
  } catch {}
  return { ...DEFAULTS };
}

export function saveLHSettings(patch) {
  const current = getLHSettings();
  const merged = { ...current, ...patch };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(merged));
  return merged;
}

export class LiquidationHeatmapRenderer {
  constructor(chart, priceSeries, chartArea, symbol) {
    this.chart = chart;
    this.series = priceSeries;
    this.chartArea = chartArea;
    this.symbol = symbol;
    this.settings = getLHSettings();
    this._candleData = []; 
    
    this._canvas = null;
    this._ob_history = [];
    this._real_liquidations = [];
    this._rafId = 0;
    this._fetchInterval = null;

    this._initCanvas();

    const triggerRedraw = () => {
      if (this._rafId) return;
      this._rafId = requestAnimationFrame(() => {
        this._rafId = 0;
        this.redraw();
      });
    };

    chart.timeScale().subscribeVisibleLogicalRangeChange(triggerRedraw);
    chartArea.addEventListener("wheel", triggerRedraw, { passive: true });
    chartArea.addEventListener("pointermove", triggerRedraw, { passive: true });
    chartArea.addEventListener("pointerdown", triggerRedraw, { passive: true });

    if (this.settings.enabled) {
      this.start();
    }
  }

  _initCanvas() {
    const c = document.createElement("canvas");
    c.id = "lh-canvas";
    c.style.cssText = "position:absolute;inset:0;pointer-events:none;z-index:2;";
    this.chartArea.appendChild(c);
    this._canvas = c;
  }

  setCandleData(candles) {
    this._candleData = candles;
  }

  setSymbol(symbol) {
    this.symbol = symbol;
    this._ob_history = [];
    this._real_liquidations = [];
    if (this.settings.enabled) {
      this.fetchData();
    }
  }

  setVisibility(enabled) {
    this.settings.enabled = enabled;
    saveLHSettings({ enabled });
    if (enabled) {
      this.start();
    } else {
      this.stop();
      this._ob_history = [];
      this._real_liquidations = [];
      this.redraw();
    }
  }

  start() {
    this.fetchData();
    if (this._fetchInterval) clearInterval(this._fetchInterval);
    this._fetchInterval = setInterval(() => this.fetchData(), 10000);
  }

  stop() {
    if (this._fetchInterval) clearInterval(this._fetchInterval);
  }

  async fetchData() {
    try {
      // 👇 DEPLOYMENT: Jab backend deploy ho jaye, toh uska link yahan daalein (jaise: "https://crypto-xyz.up.railway.app")
      const PROD_BACKEND_URL = ""; 
      
      const API_URL = (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') && window.location.port !== '8000'
        ? "http://localhost:8000" 
        : PROD_BACKEND_URL;
        
      const res = await fetch(`${API_URL}/api/chart-data?symbol=${this.symbol}&interval=1h`);
      if (!res.ok) return;
      const json = await res.json();
      
      let needsRedraw = false;
      if (json && json.ob_heatmap_history) {
        this._ob_history = json.ob_heatmap_history;
        needsRedraw = true;
      }
      if (json && json.real_liquidations) {
        this._real_liquidations = json.real_liquidations;
        needsRedraw = true;
      }
      if (needsRedraw) this.redraw();
    } catch (e) {
      console.warn("[LH] Failed to fetch data:", e);
    }
  }

  redraw() {
    const canvas = this._canvas;
    if (!canvas) return;

    const W = this.chartArea.offsetWidth;
    const H = this.chartArea.offsetHeight;
    if (!W || !H) return;

    if (canvas.width !== W || canvas.height !== H) {
      canvas.width = W;
      canvas.height = H;
    }

    const ctx = canvas.getContext("2d");
    ctx.clearRect(0, 0, W, H);

    if (!this.settings.enabled) return;

    const candles = this._candleData;
    const timeScale = this.chart.timeScale();

    const getXForTime = (targetTime) => {
      if (!candles || candles.length === 0) return null;
      let lo = 0, hi = candles.length - 1;
      while (lo <= hi) {
        const mid = (lo + hi) >>> 1;
        if (candles[mid].time === targetTime) return timeScale.timeToCoordinate(candles[mid].time);
        if (candles[mid].time < targetTime) lo = mid + 1;
        else hi = mid - 1;
      }
      
      if (hi < 0) {
        const x0 = timeScale.timeToCoordinate(candles[0].time);
        if (candles.length > 1) {
          const x1 = timeScale.timeToCoordinate(candles[1].time);
          const dt = candles[1].time - candles[0].time;
          return x0 + (targetTime - candles[0].time) * ((x1 - x0) / dt);
        }
        return x0;
      }
      if (lo >= candles.length) {
        const xLast = timeScale.timeToCoordinate(candles[candles.length - 1].time);
        if (candles.length > 1) {
          const prevX = timeScale.timeToCoordinate(candles[candles.length - 2].time);
          const dt = candles[candles.length - 1].time - candles[candles.length - 2].time;
          return xLast + (targetTime - candles[candles.length - 1].time) * ((xLast - prevX) / dt);
        }
        return xLast;
      }
      
      const t1 = candles[hi].time;
      const t2 = candles[lo].time;
      const x1 = timeScale.timeToCoordinate(t1);
      const x2 = timeScale.timeToCoordinate(t2);
      if (x1 === null || x2 === null) return null;
      
      const fraction = (targetTime - t1) / (t2 - t1);
      return x1 + fraction * (x2 - x1);
    };

    // ─── 1. DRAW BACKGROUND HEATMAP (Order Book Liquidity) ───
    if (this._ob_history.length > 0) {
      let maxVol = 0;
      for (const snap of this._ob_history) {
        for (const item of snap.data) {
          if (item.volume > maxVol) maxVol = item.volume;
        }
      }

      ctx.save();
      const op = this.settings.opacity / 100;
      
      const latestData = this._ob_history[this._ob_history.length - 1].data;
      let binSize = 10;
      if (latestData && latestData.length > 1) {
        let diffs = [];
        for (let i = 0; i < latestData.length - 1; i++) {
          diffs.push(Math.abs(latestData[i].price - latestData[i + 1].price));
        }
        diffs = diffs.filter(d => d > 0);
        if (diffs.length > 0) binSize = Math.min(...diffs);
      }

      const getBookmapColor = (val, opacity) => {
        const stops = [
          { v: 0.0, c: [0, 0, 50] },
          { v: 0.15, c: [0, 0, 255] },
          { v: 0.35, c: [0, 255, 255] },
          { v: 0.55, c: [255, 0, 0] },
          { v: 0.75, c: [255, 165, 0] },
          { v: 0.9, c: [255, 255, 0] },
          { v: 1.0, c: [255, 255, 255] }
        ];
        let c1 = stops[0].c, c2 = stops[stops.length-1].c, t = 1;
        for (let k = 0; k < stops.length - 1; k++) {
          if (val >= stops[k].v && val <= stops[k+1].v) {
            c1 = stops[k].c;
            c2 = stops[k+1].c;
            t = (val - stops[k].v) / (stops[k+1].v - stops[k].v);
            break;
          }
        }
        const r = Math.round(c1[0] + (c2[0] - c1[0]) * t);
        const g = Math.round(c1[1] + (c2[1] - c1[1]) * t);
        const b = Math.round(c1[2] + (c2[2] - c1[2]) * t);
        const dynamicOp = opacity + (val * 0.2); 
        return `rgba(${r}, ${g}, ${b}, ${Math.min(1, dynamicOp)})`;
      };

      for (let i = 0; i < this._ob_history.length; i++) {
        const snap = this._ob_history[i];
        const x = getXForTime(snap.timestamp);
        
        if (x === null || x < -50 || x > W + 50) continue;
        
        let blockW = 3;
        if (i < this._ob_history.length - 1) {
          const nx = getXForTime(this._ob_history[i + 1].timestamp);
          if (nx !== null && nx > x) blockW = nx - x;
        }
        blockW = Math.max(1, Math.min(blockW, 100)); 

        for (const item of snap.data) {
          const topPrice = item.price + (binSize / 2);
          const botPrice = item.price - (binSize / 2);
          
          const yT = this.series.priceToCoordinate(topPrice);
          const yB = this.series.priceToCoordinate(botPrice);
          if (yT === null || yB === null) continue;
          
          const drawYT = Math.min(yT, yB);
          const drawYB = Math.max(yT, yB);
          const bH = Math.max(1, drawYB - drawYT);
          if (drawYT > H || drawYB < 0) continue;
          
          const intensity = Math.min(1, item.volume / maxVol);
          ctx.fillStyle = getBookmapColor(intensity, op);
          ctx.fillRect(x, drawYT, blockW + 0.5, bH);
        }
      }
      ctx.restore();
    }

    // ─── 2. DRAW FOREGROUND BUBBLES (Real Liquidations) ───
    if (this._real_liquidations.length > 0) {
      ctx.save();
      
      // Calculate max liquidations for bubble sizing
      let maxLiqUsd = 0;
      for (const liq of this._real_liquidations) {
        if (liq.usd_value > maxLiqUsd) maxLiqUsd = liq.usd_value;
      }

      for (const liq of this._real_liquidations) {
        const x = getXForTime(liq.timestamp);
        if (x === null || x < -50 || x > W + 50) continue;

        const y = this.series.priceToCoordinate(liq.price);
        if (y === null || y < 0 || y > H) continue;

        // Size bubbles based on USD value relative to max (min 3px, max 20px)
        const intensity = Math.min(1, liq.usd_value / (maxLiqUsd || 1));
        const radius = 3 + (intensity * 17);

        // Draw distinct Diamond shape for Liquidations to differentiate from Volume bubbles
        ctx.beginPath();
        ctx.moveTo(x, y - radius);
        ctx.lineTo(x + radius, y);
        ctx.lineTo(x, y + radius);
        ctx.lineTo(x - radius, y);
        ctx.closePath();

        if (liq.side === "long") {
          // Longs liquidated = Price goes down = Neon Orange / Gold
          ctx.fillStyle = "rgba(255, 153, 0, 0.8)"; 
          ctx.strokeStyle = "rgba(255, 200, 0, 1)";
        } else {
          // Shorts liquidated = Price goes up = Neon Magenta / Purple
          ctx.fillStyle = "rgba(213, 0, 249, 0.8)";
          ctx.strokeStyle = "rgba(255, 0, 255, 1)";
        }
        
        ctx.fill();
        ctx.lineWidth = 2;
        ctx.stroke();
      }
      ctx.restore();
    }
  }

  destroy() {
    this.stop();
    if (this._canvas) {
      this._canvas.remove();
      this._canvas = null;
    }
  }
}
