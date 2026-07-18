// ============================================================
// indicators.js — Technical Indicator Calculations
// Pure math functions — no external dependencies
// ============================================================

/**
 * Simple Moving Average.
 * @param {Array<{time:number, close:number}>} candles
 * @param {number} period
 * @returns {Array<{time:number, value:number}>}
 */
export function calculateSMA(candles, period) {
  if (!candles || candles.length < period) return [];

  const result = [];
  for (let i = period - 1; i < candles.length; i++) {
    let sum = 0;
    for (let j = 0; j < period; j++) {
      sum += candles[i - j].close;
    }
    result.push({ time: candles[i].time, value: sum / period });
  }
  return result;
}

/**
 * Exponential Moving Average.
 * First value is bootstrapped from the SMA, then the EMA formula is applied.
 * @param {Array<{time:number, close:number}>} candles
 * @param {number} period
 * @returns {Array<{time:number, value:number}>}
 */
export function calculateEMA(candles, period) {
  if (!candles || candles.length < period) return [];

  const result = [];
  const multiplier = 2 / (period + 1);

  // Seed with SMA of the first `period` candles
  let sum = 0;
  for (let i = 0; i < period; i++) {
    sum += candles[i].close;
  }
  let ema = sum / period;
  result.push({ time: candles[period - 1].time, value: ema });

  // Apply EMA formula for remaining candles
  for (let i = period; i < candles.length; i++) {
    ema = (candles[i].close - ema) * multiplier + ema;
    result.push({ time: candles[i].time, value: ema });
  }

  return result;
}

/**
 * Relative Strength Index (RSI).
 * @param {Array<{time:number, close:number}>} candles
 * @param {number} period — (default 14)
 * @returns {Array<{time:number, value:number}>}
 */
export function calculateRSI(candles, period = 14) {
  // We need at least period + 1 candles to get 'period' differences
  if (!candles || candles.length <= period) return [];
  const result = [];
  
  let gains = 0;
  let losses = 0;

  // Initial average gain/loss over the first 'period' differences
  for (let i = 1; i <= period; i++) {
    const diff = candles[i].close - candles[i - 1].close;
    if (diff >= 0) gains += diff;
    else losses -= diff;
  }
  
  let avgGain = gains / period;
  let avgLoss = losses / period;
  
  for (let i = period; i < candles.length; i++) {
    if (i > period) {
      const diff = candles[i].close - candles[i - 1].close;
      if (diff >= 0) {
        avgGain = (avgGain * (period - 1) + diff) / period;
        avgLoss = (avgLoss * (period - 1)) / period;
      } else {
        avgGain = (avgGain * (period - 1)) / period;
        avgLoss = (avgLoss * (period - 1) - diff) / period;
      }
    }
    
    let rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
    let rsi = avgLoss === 0 ? 100 : 100 - (100 / (1 + rs));
    result.push({ time: candles[i].time, value: rsi });
  }
  return result;
}

/**
 * Moving Average Convergence Divergence (MACD).
 * @param {Array<{time:number, close:number}>} candles
 * @param {number} fastPeriod
 * @param {number} slowPeriod
 * @param {number} signalPeriod
 * @returns {{ macd: Array<{time:number, value:number}>, signal: Array<{time:number, value:number}>, hist: Array<{time:number, value:number}> }}
 */
export function calculateMACD(candles, fastPeriod = 12, slowPeriod = 26, signalPeriod = 9) {
  if (!candles || candles.length < slowPeriod) {
    return { macd: [], signal: [], hist: [] };
  }

  const fastEMA = calculateEMA(candles, fastPeriod);
  const slowEMA = calculateEMA(candles, slowPeriod);
  
  // Align fastEMA and slowEMA by time
  const macdSeriesRaw = [];
  let fastIdx = 0;
  let slowIdx = 0;
  
  while (fastIdx < fastEMA.length && slowIdx < slowEMA.length) {
    if (fastEMA[fastIdx].time < slowEMA[slowIdx].time) {
      fastIdx++;
    } else if (fastEMA[fastIdx].time > slowEMA[slowIdx].time) {
      slowIdx++;
    } else {
      macdSeriesRaw.push({
        time: fastEMA[fastIdx].time,
        close: fastEMA[fastIdx].value - slowEMA[slowIdx].value
      });
      fastIdx++;
      slowIdx++;
    }
  }

  // MACD Line
  const macdResult = macdSeriesRaw.map(d => ({ time: d.time, value: d.close }));
  
  // Signal Line (EMA of MACD)
  const signalEMA = calculateEMA(macdSeriesRaw, signalPeriod);
  const signalResult = [];
  const histResult = [];
  
  let mIdx = 0;
  let sIdx = 0;
  
  while (mIdx < macdResult.length && sIdx < signalEMA.length) {
    if (macdResult[mIdx].time < signalEMA[sIdx].time) {
      mIdx++;
    } else if (macdResult[mIdx].time > signalEMA[sIdx].time) {
      sIdx++;
    } else {
      const macdVal = macdResult[mIdx].value;
      const signalVal = signalEMA[sIdx].value;
      signalResult.push({ time: signalEMA[sIdx].time, value: signalVal });
      histResult.push({ time: signalEMA[sIdx].time, value: macdVal - signalVal });
      mIdx++;
      sIdx++;
    }
  }

  // Filter MACD line to match signal line length so they start exactly together
  const startTime = signalResult.length > 0 ? signalResult[0].time : 0;
  const filteredMacd = macdResult.filter(m => m.time >= startTime);

  return { macd: filteredMacd, signal: signalResult, hist: histResult };
}
