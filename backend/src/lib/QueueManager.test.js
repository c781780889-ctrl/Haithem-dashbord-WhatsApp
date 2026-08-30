jest.mock('bullmq', () => ({ Queue: jest.fn(), Worker: jest.fn(), QueueEvents: jest.fn() }));
jest.mock('./redis', () => ({ getBullMQConnection: jest.fn(() => ({})) }));

const QueueManager = require('./QueueManager');

describe('QueueManager link discovery jobs', () => {
  test('uses a BullMQ-safe custom job id', async () => {
    const add = jest.fn().mockResolvedValue({ id: 'bullmq-job-1' });
    QueueManager._queues[QueueManager.constructor.QUEUES.LINK_DISCOVERY] = { add };

    await QueueManager.enqueueLinkDiscovery({ discoveryJobId: 'job-123' });

    expect(add).toHaveBeenCalledWith(
      'scan_whatsapp_links',
      { discoveryJobId: 'job-123' },
      expect.objectContaining({ jobId: 'link-discovery-job-123' }),
    );
  });

  test('fails loudly when a job has no registered handler', async () => {
    await expect(QueueManager._dispatch('wa-link-imports', { name: 'missing_handler', id: 'job-unknown' }))
      .rejects.toThrow('No handler for wa-link-imports::missing_handler');
  });

  test('reuses a duplicate future operation job instead of creating a second one', async () => {
    const existing = { getState: jest.fn().mockResolvedValue('delayed'), changeDelay: jest.fn().mockResolvedValue(undefined) };
    const add = jest.fn().mockRejectedValue(Object.assign(new Error('Job already exists'), { code: 'EJOBEXISTS' }));
    const getJob = jest.fn().mockResolvedValue(existing);
    QueueManager._queues[QueueManager.constructor.QUEUES.LINK_IMPORTS] = { add, getJob };

    const job = await QueueManager.enqueueLinkImportOperation(
      { operationId: 'op-1', accountId: 'account-1' },
      { delay: 45000, jobId: 'link-import-op-op-1' },
    );

    expect(job).toBe(existing);
    expect(add).toHaveBeenCalledTimes(1);
    expect(getJob).toHaveBeenCalledWith('link-import-op-op-1');
    expect(existing.changeDelay).toHaveBeenCalledWith(45000);
  });
});
