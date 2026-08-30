jest.mock('../../lib/postgres', () => ({ queryAll: jest.fn() }));
jest.mock('./TelegramService', () => ({ saveLink: jest.fn() }));

const { queryAll } = require('../../lib/postgres');
const TelegramService = require('./TelegramService');
const LinkDiscoveryService = require('./LinkDiscoveryService');

describe('LinkDiscoveryService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('loads selectable search sources from owned WhatsApp accounts', async () => {
    queryAll.mockResolvedValue([{ id: 'account-1', name: 'الحساب الأول' }]);

    const sources = await LinkDiscoveryService.ownedSources({
      userId: 'user-1',
      sourceAccountIds: ['account-1'],
    });

    expect(sources).toEqual([{ id: 'account-1', name: 'الحساب الأول' }]);
    expect(queryAll.mock.calls[0][0]).toContain('FROM accounts');
  });

  test('scans persisted private and group messages for WhatsApp links', async () => {
    queryAll.mockResolvedValue([
      { message_text: 'رابط خاص: https://chat.whatsapp.com/private123', is_group: false, chat_name: 'أحمد' },
      { message_text: 'رابط المجموعة: https://chat.whatsapp.com/group123', is_group: true, chat_name: 'فريق العمل' },
    ]);
    TelegramService.saveLink.mockResolvedValue({ isDuplicate: false, ignored: false });

    const result = await LinkDiscoveryService.scanStoredMessages({
      userId: 'user-1',
      source: { id: 'account-1', name: 'الحساب الأول' },
    });

    expect(result).toMatchObject({
      accountId: 'account-1',
      messagesScanned: 2,
      linksFound: 2,
      linksSaved: 2,
    });
    expect(TelegramService.saveLink).toHaveBeenCalledTimes(2);
    expect(TelegramService.saveLink.mock.calls.map(([payload]) => payload.source_group)).toEqual(['أحمد', 'فريق العمل']);
    expect(queryAll.mock.calls[0][0]).toContain('FROM kw_messages');
  });
});
