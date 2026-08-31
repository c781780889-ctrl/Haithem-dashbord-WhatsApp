jest.mock('../database/SystemDB', () => ({}));
jest.mock('../lib/QueueManager', () => ({}));
jest.mock('../core/Logger', () => ({ warn: jest.fn(), error: jest.fn(), info: jest.fn() }));
jest.mock('../lib/postgres', () => ({ withAdvisoryLock: async (_key, callback) => callback({}) }));

const { PostgresStorageMonitor } = require('./PostgresStorageMonitor');

describe('PostgresStorageMonitor', () => {
    function createMonitor({ usedBytes, alertActive = false } = {}) {
        const db = {
            get: jest.fn()
                .mockResolvedValueOnce({ database_name: 'testdb', used_bytes: usedBytes })
                .mockResolvedValueOnce({ alert_active: alertActive }),
            run: jest.fn().mockResolvedValue({ rowCount: 1 }),
        };
        const notifications = { enqueueNotification: jest.fn().mockResolvedValue({}) };
        const log = { warn: jest.fn(), error: jest.fn(), info: jest.fn() };
        const monitor = new PostgresStorageMonitor({ db, notifications, log });
        monitor.limitBytes = 1000;
        monitor.thresholdPercent = 70;
        return { monitor, db, notifications, log };
    }

    test('sends a clear notification when usage reaches 70%', async () => {
        const { monitor, notifications } = createMonitor({ usedBytes: 700 });

        const result = await monitor.check();

        expect(result.usagePercent).toBe(70);
        expect(notifications.enqueueNotification).toHaveBeenCalledWith(expect.objectContaining({
            type: 'warning',
            title: 'تنبيه PostgreSQL — Warning',
            message: expect.stringContaining('70.0%'),
        }));
    });

    test('does not send repeated notifications while the alert remains active', async () => {
        const { monitor, notifications } = createMonitor({ usedBytes: 800, alertActive: true });

        await monitor.check();

        expect(notifications.enqueueNotification).not.toHaveBeenCalled();
    });

    test('updates state and re-arms after usage drops below the threshold', async () => {
        const { monitor, db, notifications } = createMonitor({ usedBytes: 600, alertActive: true });

        const result = await monitor.check();

        expect(result.alertActive).toBe(false);
        expect(notifications.enqueueNotification).not.toHaveBeenCalled();
        expect(db.run).toHaveBeenCalled();
        expect(db.run.mock.calls.some((call) => call[1]?.[0] === 'postgres-storage' && call[1]?.[1] === false)).toBe(true);
    });
});
