const Service = require('./TelegramJoinAutomationService');

describe('TelegramJoinAutomationService', () => {
  test('normalizes public Telegram usernames and removes query parameters', () => {
    expect(Service.normalizeTelegramLink('t.me/Example_Channel?start=tracking')).toMatchObject({
      normalizedUrl: 'https://t.me/Example_Channel',
      identifier: 'Example_Channel',
      linkType: 'PUBLIC',
    });
  });

  test('normalizes private invite links', () => {
    expect(Service.normalizeTelegramLink('https://telegram.me/joinchat/AbCdEf1234')).toMatchObject({
      normalizedUrl: 'https://t.me/+AbCdEf1234',
      identifier: 'AbCdEf1234',
      linkType: 'PRIVATE_INVITE',
    });
  });

  test('rejects unrelated or malformed URLs', () => {
    expect(Service.normalizeTelegramLink('https://example.com/channel')).toBeNull();
    expect(Service.normalizeTelegramLink('not a link')).toBeNull();
    expect(Service.normalizeTelegramLink('https://t.me/a')).toBeNull();
  });

  test('accepts a public channel or supergroup entity only', async () => {
    const client = { getEntity: jest.fn().mockResolvedValue({ className: 'Channel', username: 'public_group', megagroup: true }) };
    const parsed = Service.normalizeTelegramLink('https://t.me/public_group');
    await expect(Service.isAllowedDiscoveryLink(client, parsed)).resolves.toBe(true);
  });

  test('rejects users, bots, and unresolved public targets but accepts private invites', async () => {
    const userClient = { getEntity: jest.fn().mockResolvedValue({ className: 'User', username: 'person' }) };
    const botClient = { getEntity: jest.fn().mockResolvedValue({ className: 'User', username: 'sample_bot', bot: true }) };
    const parsedUser = Service.normalizeTelegramLink('https://t.me/person');
    const parsedBot = Service.normalizeTelegramLink('https://t.me/sample_bot');
    const parsedPrivate = Service.normalizeTelegramLink('https://t.me/+AbCdEf1234');
    await expect(Service.isAllowedDiscoveryLink(userClient, parsedUser)).resolves.toBe(false);
    await expect(Service.isAllowedDiscoveryLink(botClient, parsedBot)).resolves.toBe(false);
    await expect(Service.isAllowedDiscoveryLink(userClient, parsedPrivate)).resolves.toBe(true);
    await expect(Service.isAllowedDiscoveryLink({ getEntity: jest.fn().mockRejectedValue(new Error('not found')) }, parsedUser)).resolves.toBe(false);
  });
});
