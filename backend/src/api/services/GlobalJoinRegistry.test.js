jest.mock('../../lib/postgres', () => ({
  query: jest.fn(),
  queryOne: jest.fn(),
  withAdvisoryLock: jest.fn(async (_key, callback) => callback({ query: jest.fn() })),
}));
jest.mock('../../core/SocketBridge', () => ({ to: jest.fn(() => ({ emit: jest.fn() })) }));

const { withAdvisoryLock, query } = require('../../lib/postgres');
const Registry = require('./GlobalJoinRegistry');
query.mockResolvedValue({ rows: [], rowCount: 0 });

describe('GlobalJoinRegistry', () => {
  test('normalizes equivalent public links and removes query parameters', () => {
    expect(Registry.normalize(' http://telegram.me/Example/?utm_source=x ')).toMatchObject({
      normalizedUrl: 'https://t.me/Example', linkType: 'PUBLIC', identifier: 'Example',
    });
  });

  test('allows one reservation and skips an existing joined reservation', async () => {
    const db = { query: jest.fn() };
    db.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: 'global-1', status: 'PENDING', reserved_operation_id: null }] })
      .mockResolvedValueOnce({ rows: [] });
    const first = await Registry.reserve({ client: db, userId: 'u1', accountId: 'a1', operationId: 'o1', originalUrl: 'https://t.me/example', normalizedUrl: 'https://t.me/example', linkType: 'PUBLIC' });
    expect(first.allowed).toBe(true);
    expect(db.query).toHaveBeenCalledWith(expect.stringContaining("status='RESERVED'"), expect.any(Array));

    const duplicateDb = { query: jest.fn() };
    duplicateDb.query.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [{ id: 'global-1', status: 'JOINED', reserved_operation_id: null, joined_by_account_id: 'a1' }] });
    const duplicate = await Registry.reserve({ client: duplicateDb, userId: 'u2', accountId: 'a2', operationId: 'o2', originalUrl: 'http://telegram.me/example/', normalizedUrl: 'http://telegram.me/example/', linkType: 'PUBLIC' });
    expect(duplicate).toMatchObject({ allowed: false, reason: 'GLOBAL_DUPLICATE', status: 'SKIPPED_DUPLICATE' });
    expect(duplicate.normalized.normalizedUrl).toBe('https://t.me/example');
  });

  test('uses advisory locking when no transaction client is provided', async () => {
    const lockedDb = { query: jest.fn().mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [{ id: 'global-2', status: 'PENDING' }] }).mockResolvedValueOnce({ rows: [] }) };
    withAdvisoryLock.mockImplementationOnce(async (_key, callback) => callback(lockedDb));
    const result = await Registry.reserve({ userId: 'u1', accountId: 'a1', operationId: 'o3', originalUrl: 'https://t.me/other_channel' });
    expect(result.allowed).toBe(true);
    expect(withAdvisoryLock).toHaveBeenCalledWith(expect.stringContaining('telegram-global-link:'), expect.any(Function));
  });
});
