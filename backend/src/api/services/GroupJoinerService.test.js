jest.mock('../../bot/WhatsAppManager', () => ({
  getSession: jest.fn(),
  isReady: jest.fn(),
}));
jest.mock('../../lib/postgres', () => ({
  queryAll: jest.fn(),
}));

const WhatsAppManager = require('../../bot/WhatsAppManager');
const service = require('./GroupJoinerService');

describe('GroupJoinerService live membership confirmation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    WhatsAppManager.isReady.mockReturnValue(true);
  });

  test('records joined only when WhatsApp metadata contains the current account', async () => {
    const sock = {
      user: { id: '12345:1@s.whatsapp.net' },
      groupAcceptInvite: jest.fn().mockResolvedValue('120363@g.us'),
      groupMetadata: jest.fn().mockResolvedValue({
        participants: [{ id: '12345@s.whatsapp.net' }],
      }),
    };
    WhatsAppManager.getSession.mockReturnValue(sock);

    const result = await service._doJoin('account-1', 'https://chat.whatsapp.com/ABC123456');

    expect(result).toEqual(expect.objectContaining({
      success: true,
      status: 'joined',
      confirmed: true,
      groupId: '120363@g.us',
    }));
    expect(sock.groupMetadata).toHaveBeenCalledWith('120363@g.us');
  });

  test('accepts a confirmed membership represented by a WhatsApp LID', async () => {
    const sock = {
      user: { id: '12345@s.whatsapp.net', lid: '98765@lid' },
      groupAcceptInvite: jest.fn().mockResolvedValue('120363@g.us'),
      groupMetadata: jest.fn().mockResolvedValue({
        participants: [{ id: '98765@lid' }],
      }),
    };
    WhatsAppManager.getSession.mockReturnValue(sock);

    const result = await service._doJoin('account-1', 'https://chat.whatsapp.com/ABC123456');

    expect(result).toEqual(expect.objectContaining({
      success: true,
      status: 'joined',
      confirmed: true,
    }));
  });

  test('records an accepted invite as joined when membership metadata is delayed', async () => {
    const sock = {
      user: { id: '12345@s.whatsapp.net' },
      groupAcceptInvite: jest.fn().mockResolvedValue('120363@g.us'),
      groupMetadata: jest.fn().mockResolvedValue({ participants: [] }),
    };
    WhatsAppManager.getSession.mockReturnValue(sock);

    const result = await service._doJoin('account-1', 'https://chat.whatsapp.com/ABC123456');

    expect(result).toEqual(expect.objectContaining({
      success: true,
      status: 'joined',
      confirmed: false,
      verificationPending: true,
      groupId: '120363@g.us',
    }));
  });

  test('classifies WhatsApp forbidden as an account restriction without retrying forever', async () => {
    const error = Object.assign(new Error('forbidden'), { statusCode: 403 });
    const sock = {
      user: { id: '12345@s.whatsapp.net' },
      groupAcceptInvite: jest.fn().mockRejectedValue(error),
    };
    WhatsAppManager.getSession.mockReturnValue(sock);

    const result = await service._doJoin('account-1', 'https://chat.whatsapp.com/ABC123456');

    expect(result).toEqual(expect.objectContaining({
      success: false,
      status: 'account_restricted',
      retryable: false,
      errorCode: 'ACCOUNT_RESTRICTED',
    }));
    expect(result.rawError).toBe('forbidden');
  });
});

 afterAll(() => {
  jest.restoreAllMocks();
});
