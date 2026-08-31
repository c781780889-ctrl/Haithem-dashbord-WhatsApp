jest.mock('../../lib/postgres', () => ({ query: jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }), queryOne: jest.fn().mockResolvedValue({ id: 'review-1' }), queryAll: jest.fn(), withAdvisoryLock: jest.fn() }));
jest.mock('./TelegramService', () => ({ getWorker: jest.fn() }));
jest.mock('../../core/SocketBridge', () => ({ to: jest.fn(() => ({ emit: jest.fn() })) }));

const { queryAll } = require('../../lib/postgres');
const TelegramService = require('./TelegramService');
const Service = require('./TelegramMembershipReviewService');

describe('TelegramMembershipReviewService', () => {
  beforeEach(() => jest.clearAllMocks());

  test('groups memberships globally and keeps one account without leaving it', async () => {
    queryAll.mockResolvedValueOnce([
      { id: 'a1', name: 'Account A', created_at: '2026-08-01' },
      { id: 'a2', name: 'Account B', created_at: '2026-08-02' },
    ]);
    TelegramService.getWorker.mockImplementation(id => ({ status: 'running', client: { getDialogs: jest.fn().mockResolvedValue([{ id: '-1001', title: 'Group A', isChannel: true, isGroup: false, entity: { id: '-1001', megagroup: true, username: 'group_a' } }]) } }));
    const result = await Service.review({ userId: 'u1' });
    expect(result.accountsScanned).toBe(2);
    expect(result.duplicateGroups).toBe(1);
    expect(result.groups[0].keepAccountId).toBe('a1');
    expect(result.groups[0].leaveAccountIds).toEqual(['a2']);
    expect(result.groups[0].leaveAccountIds).not.toContain(result.groups[0].keepAccountId);
  });

  test('requires explicit confirmation before any cleanup', async () => {
    await expect(Service.execute({ userId: 'u1', confirm: false })).rejects.toMatchObject({ code: 'CONFIRMATION_REQUIRED' });
  });
});
