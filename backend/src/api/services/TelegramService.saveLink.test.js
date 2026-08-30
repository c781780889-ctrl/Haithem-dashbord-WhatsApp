'use strict';

jest.mock('../../lib/postgres', () => ({
  query: jest.fn().mockResolvedValue({ rows: [] }),
  queryOne: jest.fn(),
  queryAll: jest.fn(),
}));
jest.mock('../../core/SocketBridge', () => ({ emit: jest.fn() }));
jest.mock('uuid', () => ({ v4: jest.fn(() => 'generated-link-id') }));

const { query, queryOne } = require('../../lib/postgres');
const TelegramService = require('./TelegramService');

test('saves source_history as a JSON array and tolerates legacy object history', async () => {
  queryOne
    .mockResolvedValueOnce({ id: 'link-1', duplicate_count: 0, inserted: true })
    .mockResolvedValueOnce({ id: 'link-1', whatsapp_link: 'https://chat.whatsapp.com/ABC123' });

  const result = await TelegramService.saveLink({
    whatsapp_link: 'https://chat.whatsapp.com/ABC123',
    source_account_id: 'account-1',
    source_account_name: '+967772628451',
    source_group: 'محادثة خاصة',
  });

  expect(result).toEqual({ isDuplicate: false, id: 'link-1' });
  const insertCall = queryOne.mock.calls[0];
  expect(insertCall[0]).toContain("jsonb_typeof(COALESCE(whatsapp_links.source_history");
  expect(JSON.parse(insertCall[1][5])).toEqual([
    { accountId: 'account-1', accountName: '+967772628451', group: 'محادثة خاصة', seenAt: expect.any(String) },
  ]);
  expect(query).toHaveBeenCalledWith(
    expect.stringContaining('UPDATE accounts SET links_collected'),
    ['account-1'],
  );
});
