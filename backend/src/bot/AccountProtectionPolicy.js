'use strict';

const HARD_STOP_STATUS = 403;
const TEMPORARY_DISCONNECT_STATUS = 503;
const DEFAULT_503_THRESHOLD = 3;

function classifyDisconnect(statusCode, { loggedOut = false, badSession = false } = {}) {
  if (statusCode === HARD_STOP_STATUS) return 'BANNED';
  if (loggedOut) return 'LOGGED_OUT';
  if (badSession) return 'BAD_SESSION';
  if (statusCode === TEMPORARY_DISCONNECT_STATUS) return 'TEMPORARY_DISCONNECT';
  return 'UNKNOWN_DISCONNECT';
}

function shouldReconnect({ statusCode, loggedOut = false, badSession = false, circuitOpen = false } = {}) {
  if (circuitOpen || statusCode === HARD_STOP_STATUS || loggedOut || badSession) return false;
  return true;
}

function shouldOpen503Breaker(consecutive503, threshold = DEFAULT_503_THRESHOLD) {
  return Number(consecutive503 || 0) >= Math.max(1, Number(threshold) || DEFAULT_503_THRESHOLD);
}

function isAutomationBlocked({ accountStatus, healthStatus, taskStatus, circuitState } = {}) {
  return accountStatus === 'banned' || circuitState === 'OPEN' || taskStatus === 'stopped' || ['blocked', 'protected'].includes(healthStatus);
}

module.exports = {
  HARD_STOP_STATUS,
  TEMPORARY_DISCONNECT_STATUS,
  DEFAULT_503_THRESHOLD,
  classifyDisconnect,
  shouldReconnect,
  shouldOpen503Breaker,
  isAutomationBlocked,
};
