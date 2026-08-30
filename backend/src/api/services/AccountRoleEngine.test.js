jest.mock('../../database/SystemDB', () => ({
  all: jest.fn(),
}));

const SystemDB = require('../../database/SystemDB');
const AccountRoleEngine = require('./AccountRoleEngine');

describe('AccountRoleEngine.getSummary', () => {
  beforeEach(() => jest.clearAllMocks());

  test('filters summary by the current user ID', async () => {
    SystemDB.all.mockResolvedValue([{ total: '1', connected: '1' }]);

    await AccountRoleEngine.getSummary('user-current');

    expect(SystemDB.all).toHaveBeenCalledTimes(1);
    const [sql, params] = SystemDB.all.mock.calls[0];
    expect(sql).toContain('WHERE ($1::uuid IS NULL OR user_id = $1)');
    expect(params).toEqual(['user-current']);
  });

  test('keeps admin summary unscoped only when explicitly passed null', async () => {
    SystemDB.all.mockResolvedValue([{ total: '3' }]);

    await AccountRoleEngine.getSummary(null);

    const [sql, params] = SystemDB.all.mock.calls[0];
    expect(sql).toContain('WHERE ($1::uuid IS NULL OR user_id = $1)');
    expect(params).toEqual([null]);
  });
});
