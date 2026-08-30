'use strict';

const DelayEngine = require('./DelayEngine');

const OPERATION_STATES = new Set(['pending', 'processing', 'retry', 'paused', 'success', 'failed', 'skipped', 'review']);
const TERMINAL_STATES = new Set(['success', 'failed', 'skipped', 'review']);
const ALLOWED_TRANSITIONS = {
  pending: new Set(['processing', 'paused', 'skipped', 'retry', 'failed', 'review']),
  processing: new Set(['processing', 'retry', 'paused', 'success', 'failed', 'review', 'skipped']),
  retry: new Set(['processing', 'paused', 'skipped', 'failed', 'review']),
  paused: new Set(['pending', 'processing', 'skipped']),
  success: new Set(),
  failed: new Set(),
  skipped: new Set(),
  review: new Set(),
};

function canTransition(from, to) {
  if (!OPERATION_STATES.has(to)) return false;
  if (from === to) return true;
  return Boolean(ALLOWED_TRANSITIONS[from]?.has(to));
}

function assertTransition(from, to) {
  if (!canTransition(from, to)) throw new Error(`انتقال حالة العملية غير مسموح: ${from || 'unknown'} → ${to}`);
  return to;
}

function schedule({ minDelaySeconds, maxDelaySeconds, now = Date.now(), random = Math.random, remainingOperations = 0, cycleEndAt = null }) {
  const minimum = DelayEngine.clamp(minDelaySeconds, 0);
  let maximum = Math.max(minimum, DelayEngine.clamp(maxDelaySeconds, minimum));
  const remaining = Math.max(0, Math.floor(Number(remainingOperations) || 0));
  if (remaining > 0 && cycleEndAt) {
    const cycleSecondsLeft = Math.max(0, Math.floor((new Date(cycleEndAt).getTime() - Number(now)) / 1000));
    const fairMaximum = Math.floor(cycleSecondsLeft / remaining);
    if (fairMaximum >= minimum) maximum = Math.min(maximum, fairMaximum);
  }
  const delaySeconds = DelayEngine.nextDelay(minimum, maximum, random);
  return { delaySeconds, scheduledAt: DelayEngine.scheduledAt(delaySeconds, now) };
}

function isTerminal(status) { return TERMINAL_STATES.has(status); }

/**
 * Return the remaining cooldown after the most recent join attempt for an
 * account. The cooldown is measured from the actual join timestamp, not from
 * task creation or queue insertion time.
 */
function remainingAccountDelay(lastJoinAt, minDelaySeconds, now = Date.now()) {
  if (!lastJoinAt) return 0;
  const last = new Date(lastJoinAt).getTime();
  if (!Number.isFinite(last)) return 0;
  const minimum = DelayEngine.clamp(minDelaySeconds, 0);
  const elapsed = Math.max(0, (Number(now) - last) / 1000);
  return Math.max(0, Math.ceil(minimum - elapsed));
}

module.exports = { OPERATION_STATES, TERMINAL_STATES, ALLOWED_TRANSITIONS, canTransition, assertTransition, schedule, isTerminal, remainingAccountDelay };
