const policy = require('./JoinCyclePolicy');

test('keeps the configured cycle at 30 processed links by default', () => {
  expect(policy.DEFAULT_CYCLE_LIMIT).toBe(30);
  expect(policy.remainingSlots(0)).toBe(30);
  expect(policy.remainingSlots(17)).toBe(13);
  expect(policy.remainingSlots(30)).toBe(0);
  expect(policy.shouldRest({ processedCount: 30 })).toBe(true);
  expect(policy.shouldRest({ processedCount: 29 })).toBe(false);
});

test('rests when the one-hour cycle window expires even below the link limit', () => {
  const now = Date.parse('2026-08-25T05:00:00.000Z');
  expect(policy.isWindowExpired('2026-08-25T04:59:59.000Z', now)).toBe(true);
  expect(policy.shouldRest({ processedCount: 17, cycleLimit: 30, cycleEnd: '2026-08-25T04:59:59.000Z', now })).toBe(true);
  expect(policy.shouldRest({ processedCount: 17, cycleLimit: 30, cycleEnd: '2026-08-25T05:00:01.000Z', now })).toBe(false);
});

test('classifies each WhatsApp outcome into the dashboard cycle buckets', () => {
  expect(policy.resultBucket({ success: true, status: 'joined' })).toBe('JOINED');
  expect(policy.resultBucket({ success: true, status: 'already_joined' })).toBe('JOINED');
  expect(policy.resultBucket({ success: false, status: 'pending_approval' })).toBe('JOIN_REQUEST_SENT');
  expect(policy.resultBucket({ success: false, status: 'invalid_link' })).toBe('FAILED');
});
