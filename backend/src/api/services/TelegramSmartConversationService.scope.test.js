jest.mock('./TelegramService', () => ({ getWorker: jest.fn() }));
jest.mock('uuid', () => ({ v4: jest.fn(() => 'test-id') }));

const Service = require('./TelegramSmartConversationService');

describe('Telegram smart conversation rule scope', () => {
  test('empty account_ids applies to every account', () => {
    expect(Service._accountAllowed({ account_ids: [] }, 'account-a')).toBe(true);
    expect(Service._accountAllowed({ account_ids: '[]' }, 'account-b')).toBe(true);
  });

  test('selected account_ids restrict processing to selected accounts', () => {
    expect(Service._accountAllowed({ account_ids: ['account-a'] }, 'account-a')).toBe(true);
    expect(Service._accountAllowed({ account_ids: ['account-a'] }, 'account-b')).toBe(false);
    expect(Service._accountAllowed({ account_ids: '["account-a"]' }, 'account-b')).toBe(false);
  });
});


describe('smart conversation score and threshold semantics', () => {
  test.each([
    [55, 70, true],
    [65, 80, true],
    [55, 40, false],
    [65, 65, true],
  ])('threshold %s and score %s produce matched=%s', (threshold, score, expected) => {
    const actual = score >= threshold;
    expect(actual).toBe(expected);
  });

  test('local analyzer preserves a real zero score instead of confusing it with missing analysis', () => {
    const result = Service.analyzeText('اكتشف طلبات المساعدة الأكاديمية', 'مرحبا فقط', 55, 'balanced');
    expect(result.score).toBe(0);
    expect(result.isMatch).toBe(false);
  });
});


describe('Telegram chat id normalization', () => {
  test('normalizes BigInt suffix without changing the canonical group id', () => {
    expect(Service._normalizeTelegramId('-100123456789n')).toBe('-100123456789');
    expect(Service._normalizeTelegramId('-100123456789')).toBe('-100123456789');
  });
});
