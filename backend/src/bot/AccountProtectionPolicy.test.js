const {
  classifyDisconnect,
  shouldReconnect,
  shouldOpen503Breaker,
  isAutomationBlocked,
} = require('./AccountProtectionPolicy');

describe('AccountProtectionPolicy', () => {
  test('classifies 403 as a hard ban signal', () => {
    expect(classifyDisconnect(403)).toBe('BANNED');
    expect(shouldReconnect({ statusCode: 403 })).toBe(false);
  });

  test('classifies 503 as temporary and reconnectable until breaker opens', () => {
    expect(classifyDisconnect(503)).toBe('TEMPORARY_DISCONNECT');
    expect(shouldReconnect({ statusCode: 503, circuitOpen: false })).toBe(true);
    expect(shouldReconnect({ statusCode: 503, circuitOpen: true })).toBe(false);
  });

  test('does not reconnect after logout or bad session', () => {
    expect(classifyDisconnect(401, { loggedOut: true })).toBe('LOGGED_OUT');
    expect(classifyDisconnect(500, { badSession: true })).toBe('BAD_SESSION');
    expect(shouldReconnect({ statusCode: 401, loggedOut: true })).toBe(false);
    expect(shouldReconnect({ statusCode: 500, badSession: true })).toBe(false);
  });

  test('opens the breaker only at the configured consecutive threshold', () => {
    expect(shouldOpen503Breaker(2, 3)).toBe(false);
    expect(shouldOpen503Breaker(3, 3)).toBe(true);
  });

  test('blocks automation for banned, protected, stopped, or open-circuit accounts', () => {
    expect(isAutomationBlocked({ accountStatus: 'banned' })).toBe(true);
    expect(isAutomationBlocked({ healthStatus: 'protected' })).toBe(true);
    expect(isAutomationBlocked({ taskStatus: 'stopped' })).toBe(true);
    expect(isAutomationBlocked({ circuitState: 'OPEN' })).toBe(true);
    expect(isAutomationBlocked({ accountStatus: 'connected', healthStatus: 'unknown', taskStatus: 'idle', circuitState: 'CLOSED' })).toBe(false);
  });
});
