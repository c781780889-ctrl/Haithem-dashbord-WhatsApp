const DatabaseManager = require('../../database/DatabaseManager');
const WhatsAppManager = require('../../bot/WhatsAppManager');
const JobScheduler = require('../../scheduler/JobScheduler');
const CampaignService = require('./CampaignService');

jest.mock('../../database/DatabaseManager', () => ({
  getAccountDB: jest.fn(),
}));

jest.mock('../../bot/WhatsAppManager', () => ({
  getGroupMembers: jest.fn(),
  isReady: jest.fn(),
  waitUntilReady: jest.fn(),
  getSession: jest.fn(),
  sendMessageSafe: jest.fn(),
}));

describe('CampaignService end-to-end orchestration', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    JobScheduler.isRunning = true;
    JobScheduler.scheduleTask = jest.fn()
      .mockResolvedValueOnce('job-1')
      .mockResolvedValueOnce('job-2');
    JobScheduler.pauseCampaignJobs = jest.fn().mockResolvedValue(0);
    WhatsAppManager.isReady.mockReturnValue(true);
    WhatsAppManager.getSession.mockReturnValue({});
  });

  test('createCampaign persists verified sendable JIDs instead of raw LIDs', async () => {
    const run = jest.fn().mockResolvedValue({ rowCount: 1 });
    const accountDB = { run, all: jest.fn(), get: jest.fn() };
    DatabaseManager.getAccountDB.mockResolvedValue(accountDB);
    WhatsAppManager.getGroupMembers.mockResolvedValue({
      total: 2,
      target_jids: ['member-lid@lid'],
      admins: [],
      sendable_by_jid: { 'member-lid@lid': '966500000001@s.whatsapp.net' },
    });

    await CampaignService.createCampaign('account-1', {
      name: 'حملة اختبار',
      adLibraryId: 'ad-1',
      targetType: 'group_members',
      targetIds: ['group-1'],
      excludeAdmins: true,
      excludeDuplicates: true,
    });

    expect(run).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO campaign_targets'),
      [expect.any(String), expect.any(String), '966500000001@s.whatsapp.net'],
    );
  });

  test('startCampaign queues every pending target exactly once', async () => {
    const run = jest.fn().mockResolvedValue({ rowCount: 1 });
    const all = jest.fn().mockResolvedValue([
      { id: 'target-1', target_jid: '966500000001@s.whatsapp.net' },
      { id: 'target-2', target_jid: '966500000002@s.whatsapp.net' },
    ]);
    const get = jest.fn()
      .mockResolvedValueOnce({ id: 'campaign-1', status: 'draft', ad_library_id: 'ad-1', interval_seconds: 0 })
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ content: 'رسالة اختبار' });

    const accountDB = { run, all, get };
    DatabaseManager.getAccountDB.mockResolvedValue(accountDB);

    const result = await CampaignService.startCampaign('account-1', 'campaign-1');

    expect(result).toEqual({ success: true, queued: 2 });
    expect(JobScheduler.scheduleTask).toHaveBeenCalledTimes(2);
    expect(JobScheduler.scheduleTask).toHaveBeenNthCalledWith(
      1,
      'account-1',
      'send_campaign_message',
      expect.objectContaining({ campaignId: 'campaign-1', targetId: 'target-1', to: '966500000001@s.whatsapp.net' }),
      expect.any(Date),
      10,
      { jobId: expect.stringMatching(/^campaign-campaign-1-target-1$/) },
    );
    expect(run).toHaveBeenCalledWith(
      expect.stringContaining("UPDATE campaign_targets SET status = 'queued'"),
      ['campaign-1'],
    );
  });
});

describe('JobScheduler campaign worker', () => {
  test('marks a delivered target and refreshes campaign progress', async () => {
    const run = jest.fn().mockResolvedValue({ rowCount: 1 });
    const get = jest.fn()
      .mockResolvedValueOnce({ status: 'running', ad_library_id: 'ad-1' })
      .mockResolvedValueOnce({ status: 'queued' })
      .mockResolvedValueOnce({ content: 'رسالة اختبار' })
      .mockResolvedValueOnce({ total: 1, sent: 1, failed: 0, pending: 0 });
    const accountDB = { run, get };
    WhatsAppManager.getSession.mockReturnValue({});
    WhatsAppManager.sendMessageSafe.mockResolvedValue({ key: { id: 'message-1' } });

    await JobScheduler._sendCampaignMessage(
      {
        data: {
          campaignId: 'campaign-1',
          targetId: 'target-1',
          to: '966500000001@s.whatsapp.net',
          fallbackContent: 'رسالة احتياطية',
        },
        attemptsMade: 0,
        opts: { attempts: 3 },
      },
      accountDB,
      'account-1',
      WhatsAppManager,
    );

    expect(WhatsAppManager.sendMessageSafe).toHaveBeenCalledWith(
      'account-1',
      '966500000001@s.whatsapp.net',
      { text: 'رسالة اختبار' },
      expect.objectContaining({ operationType: 'private', taskId: 'target-1' }),
    );
    expect(run).toHaveBeenCalledWith(
      expect.stringContaining("UPDATE campaign_targets SET status = 'sent'"),
      ['target-1'],
    );
    expect(run).toHaveBeenCalledWith(
      expect.stringContaining("UPDATE campaigns"),
      [1, 1, 0, true, 'campaign-1'],
    );
  });
});
