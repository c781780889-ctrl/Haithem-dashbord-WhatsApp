jest.mock('../core/Logger', () => ({ child: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }) }));

const fs = require('fs');
const { StorageMonitor } = require('./StorageMonitor');

describe('StorageMonitor', () => {
    afterEach(() => jest.restoreAllMocks());

    test('reports normal storage below warning threshold', () => {
        jest.spyOn(fs, 'statfsSync').mockReturnValue({ blocks: 100, bavail: 50, bsize: 10, files: 100, ffree: 50 });
        const monitor = new StorageMonitor({ log: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } });
        const result = monitor.status();
        expect(result.usagePercent).toBe(50);
        expect(result.level).toBe('normal');
    });

    test('uses the higher of byte and inode utilization', () => {
        jest.spyOn(fs, 'statfsSync').mockReturnValue({ blocks: 100, bavail: 30, bsize: 10, files: 100, ffree: 5 });
        const monitor = new StorageMonitor({ log: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } });
        const result = monitor.status();
        expect(result.usagePercent).toBe(70);
        expect(result.inodeUsagePercent).toBe(95);
        expect(result.effectivePercent).toBe(95);
        expect(result.level).toBe('emergency');
    });

    test('does not delete anything unless explicitly enabled', async () => {
        const monitor = new StorageMonitor({ log: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } });
        delete process.env.STORAGE_AUTO_CLEANUP;
        await expect(monitor.safeCleanup()).resolves.toEqual({ executed: false, reason: 'disabled_by_default' });
    });
});
