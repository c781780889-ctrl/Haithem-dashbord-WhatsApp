'use strict';

const DEFAULT_CYCLE_LIMIT = 30;
const DEFAULT_CYCLE_DURATION_MINUTES = 60;

function isWindowExpired(cycleEnd, now = Date.now()) {
  return Boolean(cycleEnd && new Date(cycleEnd).getTime() <= Number(now));
}

function shouldRest({ processedCount = 0, cycleLimit = DEFAULT_CYCLE_LIMIT, cycleEnd = null, now = Date.now() } = {}) {
  return Number(processedCount) >= Number(cycleLimit || DEFAULT_CYCLE_LIMIT) || isWindowExpired(cycleEnd, now);
}

function resultBucket({ success = false, status = '' } = {}) {
  if (status === 'pending_approval' || status === 'JOIN_REQUEST_SENT') return 'JOIN_REQUEST_SENT';
  if (success || ['joined', 'already_joined', 'JOINED'].includes(status)) return 'JOINED';
  return 'FAILED';
}

function remainingSlots(processedCount = 0, cycleLimit = DEFAULT_CYCLE_LIMIT) {
  return Math.max(0, Number(cycleLimit || DEFAULT_CYCLE_LIMIT) - Number(processedCount || 0));
}

module.exports = {
  DEFAULT_CYCLE_LIMIT,
  DEFAULT_CYCLE_DURATION_MINUTES,
  isWindowExpired,
  shouldRest,
  resultBucket,
  remainingSlots,
};
