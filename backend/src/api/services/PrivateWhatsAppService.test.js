jest.mock('../../database/DatabaseManager', () => ({
    getAccountDB: jest.fn(),
}));
jest.mock('../../lib/QueueManager', () => ({
    enqueuePrivateWhatsAppSync: jest.fn(),
}));
jest.mock('../../core/SocketBridge', () => ({
    to: jest.fn(() => ({ emit: jest.fn() })),
}));
jest.mock('../../lib/postgres', () => ({
    query: jest.fn(),
    queryOne: jest.fn(),
    queryAll: jest.fn(),
    withTransaction: jest.fn(),
}));

const postgres = require('../../lib/postgres');
const { normalizePhone, createSyncJob } = require('./PrivateWhatsAppService');

describe('PrivateWhatsAppService.normalizePhone', () => {
    test('normalizes an international phone number to E.164-like form', () => {
        expect(normalizePhone('+967 77-123 (4567)')).toBe('+967771234567');
        expect(normalizePhone('00967771234567')).toBe('+967771234567');
    });

    test('uses an explicit default country code for local input', () => {
        expect(normalizePhone('077 123 4567', '967')).toBe('+967771234567');
    });

    test('does not guess a country code for local input', () => {
        expect(normalizePhone('0771234567')).toBeNull();
    });

    test('rejects values outside the supported international length', () => {
        expect(normalizePhone('+123')).toBeNull();
        expect(normalizePhone('+1234567890123456')).toBeNull();
    });

    test('does not create a sync job when sync is disabled in settings', async () => {
        postgres.queryOne.mockResolvedValue({ sync_enabled: false });
        await expect(createSyncJob({ userId: 'user-1' })).rejects.toMatchObject({ statusCode: 409 });
    });
});
