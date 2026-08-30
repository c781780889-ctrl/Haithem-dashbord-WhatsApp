const { parseSupportedUrl, parseMany, classifyJoinError } = require('./LinkUrlProcessingService');

describe('LinkUrlProcessingService', () => {
  test('normalizes invite links and removes trailing punctuation/query noise', () => {
    const parsed = parseSupportedUrl(' "https://chat.whatsapp.com/AbC_123-xy/?utm_source=test" ');
    expect(parsed.ok).toBe(true);
    expect(parsed.inviteCode).toBe('AbC_123-xy');
    expect(parsed.canonicalUrl).toBe('https://chat.whatsapp.com/AbC_123-xy');
  });

  test('extracts links from long text and deduplicates canonical variants', () => {
    const items = parseMany(['نص https://chat.whatsapp.com/AbC_123-xy/ ثم https://chat.whatsapp.com/AbC_123-xy?x=1.']);
    expect(items).toHaveLength(1);
    expect(items[0].canonicalUrl).toBe('https://chat.whatsapp.com/AbC_123-xy');
  });

  test('does not treat an unsupported or malformed URL as a WhatsApp join failure', () => {
    expect(parseSupportedUrl('https://example.com/group')).toMatchObject({ ok: false, code: 'UNSUPPORTED_LINK' });
    expect(parseSupportedUrl('https://chat.whatsapp.com/')).toMatchObject({ ok: false, code: 'INVALID_LINK' });
  });

  test.each([
    ['already member', 'already participant', 'already_joined', false],
    ['timeout', 'request timeout', 'temporary_error', true],
    ['rate limit', 'rate limit reached', 'rate_limited', true],
    ['expired', 'invite expired', 'expired_link', false],
    ['session', 'connection closed / session not authenticated', 'account_error', true],
  ])('%s is classified independently', (_name, message, status, retryable) => {
    expect(classifyJoinError(new Error(message))).toMatchObject({ status, retryable });
  });
});
