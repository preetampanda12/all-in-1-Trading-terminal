/**
 * Volume Bubbles Custom Series for Lightweight Charts v4
 */

export function getBubbleSettings() {
  const defaults = {
    enabled: true,
    minMultiplier: 1.5, // Volume must be >= 1.5x the average to show a bubble
    maPeriod: 20, // Moving average period for volume baseline
    minRadius: 4,
    maxRadius: 30,
    buyColor: "rgba(0, 212, 170, 0.7)",
    sellColor: "rgba(255, 73, 118, 0.7)",
  };
  try {
    const stored = localStorage.getItem("ct_bubble_settings");
    if (stored) return { ...defaults, ...JSON.parse(stored) };
  } catch (e) {}
  return defaults;
}

export function saveBubbleSettings(s) {
  localStorage.setItem("ct_bubble_settings", JSON.stringify(s));
}

export class BubbleSeriesRenderer {
  constructor(series) {
    this._series = series;
  }

  draw(target, priceConverter, isHovered) {
    const data = this._series._data;
    const settings = this._series.settings;
    
    if (!data || !data.bars || data.bars.length === 0) return;
    if (!settings.enabled) return;
    
    target.useMediaCoordinateSpace((scope) => {
      const ctx = scope.context;
      const bars = data.bars;
      const visibleRange = data.visibleRange;
      if (visibleRange === null) {
        return;
      }

      // Draw only visible bars
      for (
        let i = visibleRange.from;
        i < visibleRange.to && i < bars.length;
        i++
      ) {
        const bar = bars[i];
        const rawData = bar.originalData || bar; // Fallback just in case
        if (!rawData.custom || !rawData.custom.volume) continue;

        const vol = rawData.custom.volume;
        const avgVol = rawData.custom.avgVolume || 1;
        const multiplier = vol / avgVol;

        if (multiplier >= settings.minMultiplier) {
          const isBuy = rawData.custom.close >= rawData.custom.open;
          
          // Logarithmic scale for radius
          const scale = Math.log(multiplier) / Math.log(10);
          const rawRadius = settings.minRadius + (scale * 15);
          const radius = Math.min(Math.max(rawRadius, settings.minRadius), settings.maxRadius);

          // bar.x is provided by the library
          const x = bar.x;
          const price = rawData.custom.close;
          const y = priceConverter(price);

          if (x !== null && y !== null) {
            ctx.beginPath();
            ctx.arc(x, y, radius, 0, Math.PI * 2);
            ctx.fillStyle = isBuy ? settings.buyColor : settings.sellColor;
            ctx.fill();
            
            // Optional border
            ctx.lineWidth = 1;
            ctx.strokeStyle = "rgba(255,255,255,0.2)";
            ctx.stroke();
          }
        }
      }
    });
  }
}

export class CustomBubbleSeries {
  constructor() {
    this.settings = getBubbleSettings();
    this._data = null;
  }

  isWhitespace(data) {
    return data.custom === undefined;
  }

  defaultOptions() {
    return {
      priceLineVisible: false,
      lastValueVisible: false,
    };
  }

  priceValueBuilder(plotRow) {
    // Depending on LW version, the data might be in plotRow, plotRow.originalData, or plotRow.customData
    const data = plotRow.originalData || plotRow.customData || plotRow;
    if (data && data.custom && data.custom.close !== undefined) {
      return [data.custom.close, data.custom.close, data.custom.close];
    }
    return [0, 0, 0];
  }

  update(data, seriesOptions) {
    this._data = data;
  }

  renderer() {
    return new BubbleSeriesRenderer(this);
  }

  applySettings(newSettings) {
    this.settings = { ...this.settings, ...newSettings };
    saveBubbleSettings(this.settings);
  }
}

/**
 * Pre-computes the moving average of volume so the renderer is extremely fast.
 */
export function computeBubbleData(klines, period = 20) {
  let volSum = 0;
  return klines.map((k, i) => {
    volSum += k.volume;
    if (i >= period) volSum -= klines[i - period].volume;

    const count = Math.min(i + 1, period);
    const avgVolume = volSum / count;

    return {
      time: k.time,
      custom: {
        open: k.open,
        close: k.close,
        volume: k.volume,
        avgVolume: avgVolume,
      },
    };
  });
}
