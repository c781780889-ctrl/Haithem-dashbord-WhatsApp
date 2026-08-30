'use strict';

const MAX_DELAY_SECONDS = 86400;

function clamp(value, fallback = 0) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(0, Math.min(MAX_DELAY_SECONDS, Math.round(number)));
}

function normalizeRange(min, max) {
  const lower = clamp(min, 0);
  const upper = Math.max(lower, clamp(max, lower));
  return { min: lower, max: upper };
}

function nextDelay(min, max, random = Math.random) {
  const range = normalizeRange(min, max);
  if (range.max <= range.min) return range.min;
  const sample = Number(random());
  const safeSample = Number.isFinite(sample) ? Math.min(0.999999999, Math.max(0, sample)) : 0;
  return Math.floor(range.min + safeSample * (range.max - range.min + 1));
}

function scheduledAt(delaySeconds, now = Date.now()) {
  return new Date(Number(now) + clamp(delaySeconds, 0) * 1000);
}

module.exports = { MAX_DELAY_SECONDS, clamp, normalizeRange, nextDelay, scheduledAt };
