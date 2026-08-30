jest.mock('../../database/DatabaseManager', () => ({
    getAccountDB: jest.fn(),
}));
jest.mock('../../lib/QueueManager', () => ({
    enqueuePrivateWhatsAppSync: jest.fn(async ({ syncAccountId }) => ({ id: `queue-${syncAccountId}` })),
}));
jest.mock('../../core/SocketBridge', () => ({
    to: jest.fn(() => ({ emit: jest.fn() })),
}));
jest.mock('../../lib/postgres', () => ({
    query: jest.fn(async () => ({ rowCount: 1 })),
    queryOne: jest.fn(),
    queryAll: jest.fn(),
    withTransaction: jest.fn(),
}));

const DatabaseManager = require('../../database/DatabaseManager');
const QueueManager = require('../../lib/QueueManager');
const postgres = require('../../lib/postgres');
const PrivateWhatsAppService = require('./PrivateWhatsAppService');

function configureQueryOneForWorker(claimedAccount) {
    let claimAttempts = 0;
    postgres.queryOne.mockImplementation(async sql => {
        if (sql.includes("SET status = 'PROCESSING'")) {
            claimAttempts += 1;
            return claimAttempts === 1 ? claimedAccount : null;
        }
        if (sql.includes('SELECT * FROM private_whatsapp_sync_jobs')) {
            return { id: 'sync-1', settings: { default_country_code: '967' }, total_accounts: 1 };
        }
        if (sql.includes('UPDATE private_whatsapp_sync_jobs')) {
            return { id: 'sync-1', status: 'COMPLETED', total_accounts: 1, processed_accounts: 1 };
        }
        if (sql.includes('SELECT * FROM private_whatsapp_sync_accounts')) {
            return { ...claimedAccount, status: 'PROCESSING' };
        }
        return {};
    });
    return () => claimAttempts;
}

describe('Private WhatsApp worker integration', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        PrivateWhatsAppService.stopRecoveryWorker();
    });

    test('only one of two concurrent workers processes the same sync account', async () => {
        const claimed = {
            id: 'sync-account-1',
            sync_job_id: 'sync-1',
            user_id: 'user-1',
            account_id: 'account-1',
            status: 'PROCESSING',
            attempts: 1,
            cursor_group_id: null,
            cursor_phone: null,
            discovered_count: 0,
            new_contacts_count: 0,
            duplicate_count: 0,
            excluded_count: 0,
        };
        const claimAttempts = configureQueryOneForWorker(claimed);
        const accountDB = {
            all: jest.fn(async sql => {
                if (sql.includes('FROM wa_groups')) return [{ group_jid: 'group-1', name: 'Group 1' }];
                return [{ phone: '+967771234567', name: 'Member 1', is_admin: false }];
            }),
        };
        DatabaseManager.getAccountDB.mockResolvedValue(accountDB);
        const client = { query: jest.fn(async sql => {
            if (sql.includes('private_whatsapp_contacts') && sql.includes('INSERT')) return { rows: [{ id: 'contact-1' }] };
            if (sql.includes('private_whatsapp_contact_sources')) return { rows: [{ id: 'source-1' }] };
            return { rows: [] };
        }) };
        postgres.withTransaction.mockImplementation(callback => callback(client));

        const results = await Promise.all([
            PrivateWhatsAppService.processSyncAccount({ syncAccountId: 'sync-account-1', workerId: 'worker-a' }),
            PrivateWhatsAppService.processSyncAccount({ syncAccountId: 'sync-account-1', workerId: 'worker-b' }),
        ]);

        expect(claimAttempts()).toBe(2);
        expect(results.map(result => result.outcome).sort()).toEqual(['already_claimed_or_finished', 'completed']);
        expect(accountDB.all).toHaveBeenCalledTimes(2); // groups + one paginated member batch
        expect(postgres.withTransaction).toHaveBeenCalledTimes(1);
    });

    test('re-enqueues 100 pending accounts once and persists their queue ids', async () => {
        const pending = Array.from({ length: 100 }, (_, index) => ({ id: `sync-account-${index + 1}` }));
        postgres.queryAll.mockResolvedValue(pending);

        const count = await PrivateWhatsAppService.recoverPendingJobs();

        expect(count).toBe(100);
        expect(QueueManager.enqueuePrivateWhatsAppSync).toHaveBeenCalledTimes(100);
        expect(new Set(QueueManager.enqueuePrivateWhatsAppSync.mock.calls.map(([data]) => data.syncAccountId)).size).toBe(100);
        expect(postgres.query).toHaveBeenCalledTimes(101); // stale leases + one queue-id update per account
        expect(postgres.query.mock.calls.slice(1).every(([, params]) => String(params[1]).startsWith('sync-account-'))).toBe(true);
    });
});
