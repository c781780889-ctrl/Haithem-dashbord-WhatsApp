jest.mock('../../lib/postgres', () => ({
  query: jest.fn(),
  queryOne: jest.fn(),
  queryAll: jest.fn(),
}));
jest.mock('./TelegramService', () => ({ saveLink: jest.fn() }));

const { query, queryOne, queryAll } = require('../../lib/postgres');
const TelegramService = require('./TelegramService');
const LinkDiscoveryService = require('./LinkDiscoveryService');

describe('LinkDiscoveryService.processJob', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    query.mockImplementation((sql) => {
      if (String(sql).includes('link_import_events')) {
        return Promise.reject(new Error('relation "link_import_events" does not exist'));
      }
      return Promise.resolve({});
    });
    queryOne.mockResolvedValue({ status: 'running' });
    queryAll.mockImplementation((sql) => {
      if (String(sql).includes('FROM accounts')) return Promise.resolve([{ id: 'account-1', name: 'الحساب الأول' }]);
      if (String(sql).includes('FROM kw_messages')) return Promise.resolve([
        { message_text: 'خاص https://chat.whatsapp.com/private123', is_group: false, chat_name: 'محادثة خاصة' },
        { message_text: 'مجموعة https://chat.whatsapp.com/group123', is_group: true, chat_name: 'المجموعة العامة' },
      ]);
      return Promise.resolve([]);
    });
    TelegramService.saveLink.mockResolvedValue({ isDuplicate: false, ignored: false });
  });

  test('completes the real scan when event logging is unavailable', async () => {
    const result = await LinkDiscoveryService.processJob({
      discoveryJobId: 'job-1',
      userId: 'user-1',
      sourceAccountIds: ['account-1'],
    });

    expect(result.status).toBe('completed');
    expect(result.foundCount).toBe(2);
    expect(result.results[0]).toMatchObject({ messagesScanned: 2, linksFound: 2, linksSaved: 2 });
    expect(TelegramService.saveLink).toHaveBeenCalledTimes(2);
    expect(query).toHaveBeenCalledWith(expect.stringContaining('UPDATE join_automation_discovery_jobs'), expect.any(Array));
    expect(query).toHaveBeenCalledWith(expect.stringContaining('link_import_events'), expect.any(Array));
  });
});
