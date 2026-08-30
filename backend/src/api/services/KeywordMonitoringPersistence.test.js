jest.mock('../../database/SystemDB', () => ({
  get: jest.fn(),
  run: jest.fn(),
}));

const SystemDB = require('../../database/SystemDB');
const KeywordMonitoringService = require('./KeywordMonitoringService');

describe('KeywordMonitoringService.persistMessageForDiscovery', () => {
  beforeEach(() => jest.clearAllMocks());

  test('persists a private message sent by the WhatsApp account', async () => {
    SystemDB.get.mockResolvedValue({ user_id: 'user-1' });

    const messageId = await KeywordMonitoringService.persistMessageForDiscovery('account-1', {
      key: { id: 'private-link-1', remoteJid: '967771234567@s.whatsapp.net', fromMe: true },
      message: { conversation: 'https://chat.whatsapp.com/private-history' },
      messageTimestamp: 1787530000,
    });

    expect(messageId).toBe('private-link-1');
    expect(SystemDB.run).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO kw_messages'),
      expect.arrayContaining(['user-1', 'account-1', 'private-link-1', 'https://chat.whatsapp.com/private-history', false]),
    );
  });
});
