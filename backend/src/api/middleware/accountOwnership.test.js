jest.mock('../../database/DatabaseManager', () => ({
  systemDB: {
    get: jest.fn(),
    all: jest.fn(),
  },
}));

const DatabaseManager = require('../../database/DatabaseManager');
const { requireAccountOwnership } = require('./accountOwnership');

function response() {
  return {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
  };
}

describe('account tenant isolation', () => {
  beforeEach(() => jest.clearAllMocks());

  test('allows a user to access an account they own', async () => {
    DatabaseManager.systemDB.get.mockResolvedValue({ id: 'a1', user_id: 'u1' });
    const req = { params: { accountId: 'a1' }, user: { id: 'u1', role: 'user' } };
    const res = response();
    const next = jest.fn();

    await requireAccountOwnership(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });

  test('denies a user from accessing another user account', async () => {
    DatabaseManager.systemDB.get.mockResolvedValue({ id: 'b1', user_id: 'u2' });
    const req = { params: { accountId: 'b1' }, user: { id: 'u1', role: 'user' } };
    const res = response();
    const next = jest.fn();

    await requireAccountOwnership(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });

});
