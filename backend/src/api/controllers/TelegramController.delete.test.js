const TelegramService = require('../../api/services/TelegramService');
const postgres = require('../../../src/lib/postgres');
const TelegramController = require('./TelegramController');

jest.mock('uuid', () => ({ v4: jest.fn() }));
jest.mock('../../api/services/TelegramService', () => ({
  stopWorker: jest.fn(),
}));
jest.mock('../services/LinkImportService', () => ({}));
jest.mock('../services/LinkDiscoveryService', () => ({}));
jest.mock('../services/AutomationHealthService', () => ({}));
jest.mock('../../bot/WhatsAppManager', () => ({}));
jest.mock('../../lib/QueueManager', () => ({}));
jest.mock('../middleware/MetricsMiddleware', () => ({ metrics: {} }));
jest.mock('../../core/SocketBridge', () => ({ emit: jest.fn() }));
jest.mock('../../lib/postgres', () => ({
  query: jest.fn(),
  queryOne: jest.fn(),
  queryAll: jest.fn(),
  withTransaction: jest.fn(),
}));

describe('TelegramController.deleteAccount', () => {
  beforeEach(() => jest.clearAllMocks());

  test('cleans restricted relations before deleting the account atomically', async () => {
    const client = { query: jest.fn().mockResolvedValue({ rows: [], rowCount: 1 }) };
    postgres.queryOne.mockResolvedValue({ id: 'account-1', user_id: 'user-1' });
    postgres.withTransaction.mockImplementation(callback => callback(client));
    const res = { json: jest.fn(), status: jest.fn() };
    res.status.mockReturnValue(res);

    await TelegramController.deleteAccount({
      params: { id: 'account-1' },
      user: { id: 'user-1', role: 'user' },
    }, res);

    expect(TelegramService.stopWorker).toHaveBeenCalledWith('account-1');
    expect(postgres.withTransaction).toHaveBeenCalledTimes(1);
    expect(client.query.mock.calls.map(([sql]) => sql.trim().split(/\s+/).slice(0, 3).join(' '))).toEqual([
      'UPDATE telegram_automation_links SET',
      'DELETE FROM telegram_join_operations',
      'DELETE FROM telegram_accounts',
    ]);
    expect(client.query.mock.calls[0][1]).toEqual(['account-1']);
    expect(client.query.mock.calls[1][1]).toEqual(['account-1']);
    expect(client.query.mock.calls[2][1]).toEqual(['account-1']);
    expect(res.json).toHaveBeenCalledWith({ success: true, message: 'تم حذف الحساب' });
  });
});

module.exports = {};
