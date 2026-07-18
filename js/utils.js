// ============================================================
// utils.js — Utility Functions
// Pure helper functions for formatting and common operations
// ============================================================

/**
 * Returns the appropriate number of decimal places for a given price level.
 * @param {number} price
 * @returns {number}
 */
export function getDecimalPlaces(price) {
  const abs = Math.abs(price);
  if (abs >= 1000) return 2;
  if (abs >= 1) return 2;
  if (abs >= 0.01) return 4;
  return 6;
}

/**
 * Smart price formatting based on magnitude.
 * Uses Intl.NumberFormat for locale-aware formatting with commas.
 * @param {number} value
 * @param {number|null} decimals — explicit decimal override
 * @returns {string}
 */
export function formatPrice(value, decimals = null) {
  if (value == null || isNaN(value)) return "—";

  const places = decimals != null ? decimals : getDecimalPlaces(value);

  return new Intl.NumberFormat("en-US", {
    minimumFractionDigits: places,
    maximumFractionDigits: places,
  }).format(value);
}

/**
 * Compact volume formatting: 1.2B, 543.7M, 12.3K, or raw number.
 * @param {number} value
 * @returns {string}
 */
export function formatVolume(value) {
  if (value == null || isNaN(value)) return "—";

  const abs = Math.abs(value);
  if (abs >= 1e9) return (value / 1e9).toFixed(1) + "B";
  if (abs >= 1e6) return (value / 1e6).toFixed(1) + "M";
  if (abs >= 1e3) return (value / 1e3).toFixed(1) + "K";
  return value.toFixed(2);
}

/**
 * Format a percentage value with sign prefix.
 * @param {number} value
 * @returns {string} e.g. "+2.45%" or "-0.87%"
 */
export function formatPercent(value) {
  if (value == null || isNaN(value)) return "0.00%";
  const prefix = value >= 0 ? "+" : "";
  return `${prefix}${value.toFixed(2)}%`;
}

/**
 * Compact number formatting for general numbers.
 * @param {number} value
 * @returns {string}
 */
export function formatCompactNumber(value) {
  if (value == null || isNaN(value)) return "—";

  const abs = Math.abs(value);
  if (abs >= 1e9) return (value / 1e9).toFixed(1) + "B";
  if (abs >= 1e6) return (value / 1e6).toFixed(1) + "M";
  if (abs >= 1e3) return (value / 1e3).toFixed(1) + "K";
  return value.toString();
}

/**
 * Standard debounce implementation.
 * @param {Function} fn
 * @param {number} delay — milliseconds
 * @returns {Function}
 */
export function debounce(fn, delay) {
  let timer = null;
  return function (...args) {
    clearTimeout(timer);
    timer = setTimeout(() => fn.apply(this, args), delay);
  };
}
