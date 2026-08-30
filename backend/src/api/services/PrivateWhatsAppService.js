const DatabaseManager = require('../../database/DatabaseManager');
const QueueManager = require('../../lib/QueueManager');
const SocketBridge = require('../../core/SocketBridge');
const {
    query,
    queryOne,
    queryAll,
    withTransaction,
} = require('../../lib/postgres');

const BATCH_SIZE = Math.max(25, Math.min(500, Number(process.env.PRIVATE_WHATSAPP_BATCH_SIZE || 250)));
const LEASE_MS = Math.max(30_000, Number(process.env.PRIVATE_WHATSAPP_LEASE_MS || 120_000));
const RECOVERY_MS = Math.max(10_000, Number(process.env.PRIVATE_WHATSAPP_RECOVERY_MS || 15_000));
const MAX_RETRIES = Math.max(1, Math.min(5, Number(process.env.PRIVATE_WHATSAPP_MAX_RETRIES || 3)));

let recoveryTimer = null;
let recoveryRunning = false;

function nowPlus(ms) {
    return new Date(Date.now() + ms);
}

function safeRequestId(value) {
    const text = String(value || '').trim();
    return text && text.length <= 180 ? text : null;
}

/**
 * Normalize only what is explicitly present. A local number is not guessed
 * unless the caller supplies a country code or PRIVATE_WHATSAPP_DEFAULT_COUNTRY_CODE.
 */
function normalizePhone(rawPhone, defaultCountryCode = '') {
    const raw = String(rawPhone || '').trim();
    if (!raw) return null;

    const digits = raw.replace(/[^0-9]/g, '');
    if (!digits) return null;

    let international;
    if (/^00\d+/.test(raw.replace(/[\s().-]/g, ''))) {
        international = digits.slice(2);
    } else if (raw.startsWith('+')) {
        international = digits;
    } else if (defaultCountryCode) {
        const country = String(defaultCountryCode).replace(/[^0-9]/g, '');
        if (!country || country.length > 3) return null;
        international = `${country}${digits.replace(/^0+/, '')}`;
    } else {
        return null;
    }

    if (international.length < 7 || international.length > 15) return null;
    return `+${international}`;
}

function countryCodeFromPhone(normalizedPhone, explicitCountryCode = '') {
    const country = String(explicitCountryCode || '').replace(/[^0-9]/g, '');
    return country.length >= 1 && country.length <= 3 ? country : null;
}

function emitProgress(userId, payload) {
    SocketBridge.to(`user:${userId}`).emit('private_whatsapp_sync_progress', payload);
}

async function scopedAccounts({ userId, admin = false, accountIds = [] } = {}) {
    const ids = Array.isArray(accountIds) ? accountIds.map(String).filter(Boolean) : [];
    const params = [Boolean(admin), userId];
    let filter = '( $1::boolean = TRUE OR a.user_id = $2 )';
    if (ids.length) {
        params.push(ids);
        filter += ` AND a.id = ANY($3::uuid[])`;
    }

    // Publishing accounts are a different resource and never qualify as
    // source accounts. The NOT EXISTS guard remains useful if a future
    // migration links the two resources explicitly.
    return queryAll(`
        SELECT a.id, a.user_id, a.name, a.phone_number, a.status, a.health_status,
               a.last_activity_at
        FROM accounts a
        WHERE ${filter}
          AND NOT EXISTS (
              SELECT 1 FROM private_whatsapp_publishing_accounts p
              WHERE p.user_id = a.user_id AND p.phone_number IS NOT NULL
                AND p.phone_number = a.phone_number
          )
        ORDER BY a.created_at DESC
    `, params);
}

async function writeAudit({ userId, actorId = userId, action, entityType, entityId = null, payload = {} }) {
    await query(`
        INSERT INTO private_whatsapp_audit_logs
            (user_id, actor_id, action, entity_type, entity_id, payload)
        VALUES ($1,$2,$3,$4,$5,$6::jsonb)
    `, [userId, actorId, action, entityType, entityId, JSON.stringify(payload)]).catch(error => {
        console.warn('[PrivateWhatsApp] audit write skipped:', error.message);
    });
}

async function refreshSyncJob(syncJobId) {
    return queryOne(`
        UPDATE private_whatsapp_sync_jobs j
        SET processed_accounts = x.processed_accounts,
            discovered_count = x.discovered_count,
            new_contacts_count = x.new_contacts_count,
            duplicate_count = x.duplicate_count,
            excluded_count = x.excluded_count,
            status = CASE
                WHEN x.failed_accounts > 0 AND x.finished_accounts + x.failed_accounts = j.total_accounts THEN 'FAILED'
                WHEN x.finished_accounts = j.total_accounts THEN 'COMPLETED'
                WHEN x.started_accounts > 0 THEN 'PROCESSING'
                ELSE 'QUEUED'
            END,
            completed_at = CASE
                WHEN x.finished_accounts + x.failed_accounts = j.total_accounts THEN COALESCE(j.completed_at, NOW())
                ELSE NULL
            END,
            updated_at = NOW()
        FROM (
            SELECT sync_job_id,
                   COUNT(*) FILTER (WHERE status = 'COMPLETED')::int AS finished_accounts,
                   COUNT(*) FILTER (WHERE status = 'FAILED')::int AS failed_accounts,
                   COUNT(*) FILTER (WHERE status IN ('PROCESSING','COMPLETED','FAILED'))::int AS started_accounts,
                   COALESCE(SUM(discovered_count),0)::int AS discovered_count,
                   COALESCE(SUM(new_contacts_count),0)::int AS new_contacts_count,
                   COALESCE(SUM(duplicate_count),0)::int AS duplicate_count,
                   COALESCE(SUM(excluded_count),0)::int AS excluded_count,
                   COUNT(*) FILTER (WHERE status IN ('COMPLETED','FAILED'))::int AS processed_accounts
            FROM private_whatsapp_sync_accounts
            WHERE sync_job_id = $1
            GROUP BY sync_job_id
        ) x
        WHERE j.id = $1
        RETURNING j.*
    `, [syncJobId]);
}

async function claimSyncAccount(syncAccountId, workerId) {
    return queryOne(`
        UPDATE private_whatsapp_sync_accounts
        SET status = 'PROCESSING',
            attempts = attempts + 1,
            worker_id = $2,
            lease_expires_at = $3,
            heartbeat_at = NOW(),
            started_at = COALESCE(started_at, NOW()),
            updated_at = NOW()
        WHERE id = $1
          AND available_at <= NOW()
          AND (
              status IN ('QUEUED','RETRY')
              OR (status = 'PROCESSING' AND lease_expires_at < NOW())
          )
          AND attempts < $4
        RETURNING *
    `, [syncAccountId, workerId, nowPlus(LEASE_MS), MAX_RETRIES + 1]);
}

async function updateSyncAccount(syncAccountId, patch) {
    const fields = [];
    const values = [];
    let index = 1;
    for (const [key, value] of Object.entries(patch)) {
        fields.push(`${key} = $${index++}`);
        values.push(value);
    }
    if (!fields.length) return null;
    values.push(syncAccountId);
    return queryOne(`
        UPDATE private_whatsapp_sync_accounts
        SET ${fields.join(', ')}, updated_at = NOW()
        WHERE id = $${index}
        RETURNING *
    `, values);
}

async function updateProgressFromAccount(syncAccountId, userId, syncJobId) {
    const account = await queryOne(`SELECT * FROM private_whatsapp_sync_accounts WHERE id = $1`, [syncAccountId]);
    const job = await refreshSyncJob(syncJobId);
    emitProgress(userId, {
        syncJobId,
        syncAccountId,
        status: job?.status || account?.status,
        accountId: account?.account_id,
        totalAccounts: job?.total_accounts || 0,
        processedAccounts: job?.processed_accounts || 0,
        discovered: job?.discovered_count || 0,
        newContacts: job?.new_contacts_count || 0,
        duplicates: job?.duplicate_count || 0,
        excluded: job?.excluded_count || 0,
    });
    return { account, job };
}

async function upsertContactAndSource({ userId, accountId, groupId, groupName, role, rawPhone, displayName, defaultCountryCode }) {
    const normalizedPhone = normalizePhone(rawPhone, defaultCountryCode);
    if (!normalizedPhone) return { kind: 'excluded', reason: 'INVALID_PHONE' };

    return withTransaction(async client => {
        const inserted = await client.query(`
            INSERT INTO private_whatsapp_contacts
                (user_id, normalized_phone, original_phone, country_code, status, consent_status, opt_out_status)
            VALUES ($1,$2,$3,$4,'ACTIVE','UNKNOWN',FALSE)
            ON CONFLICT (user_id, normalized_phone) DO NOTHING
            RETURNING id
        `, [userId, normalizedPhone, String(rawPhone), countryCodeFromPhone(normalizedPhone, defaultCountryCode)]);

        let contactId = inserted.rows[0]?.id;
        const isNew = Boolean(contactId);
        if (!contactId) {
            const existing = await client.query(
                `SELECT id FROM private_whatsapp_contacts WHERE user_id = $1 AND normalized_phone = $2`,
                [userId, normalizedPhone]
            );
            contactId = existing.rows[0]?.id;
        }
        if (!contactId) throw new Error('تعذر إنشاء أو قراءة جهة الاتصال');

        await client.query(`
            UPDATE private_whatsapp_contacts
            SET original_phone = COALESCE(original_phone,$3),
                last_seen_at = NOW(), updated_at = NOW()
            WHERE id = $1 AND user_id = $2
        `, [contactId, userId, String(rawPhone)]);

        const source = await client.query(`
            INSERT INTO private_whatsapp_contact_sources
                (contact_id,user_id,source_account_id,source_group_id,source_group_name,role)
            VALUES ($1,$2,$3,$4,$5,$6)
            ON CONFLICT (contact_id,source_account_id,source_group_id)
            DO UPDATE SET source_group_name = EXCLUDED.source_group_name,
                          role = EXCLUDED.role,
                          last_seen_at = NOW()
            RETURNING id
        `, [contactId, userId, accountId, groupId, groupName || null, role || 'MEMBER']);

        return { kind: isNew ? 'new' : 'duplicate', contactId, sourceId: source.rows[0]?.id, displayName: displayName || null };
    });
}

async function processSyncAccount({ syncAccountId, workerId }) {
    const claimed = await claimSyncAccount(syncAccountId, workerId);
    if (!claimed) return { outcome: 'already_claimed_or_finished' };

    const job = await queryOne(`SELECT * FROM private_whatsapp_sync_jobs WHERE id = $1`, [claimed.sync_job_id]);
    const userId = String(claimed.user_id);
    const defaultCountryCode = job?.settings?.default_country_code || process.env.PRIVATE_WHATSAPP_DEFAULT_COUNTRY_CODE || '';
    let discovered = Number(claimed.discovered_count || 0);
    let newContacts = Number(claimed.new_contacts_count || 0);
    let duplicates = Number(claimed.duplicate_count || 0);
    let excluded = Number(claimed.excluded_count || 0);

    try {
        const accountDB = await DatabaseManager.getAccountDB(String(claimed.account_id));
        const groups = await accountDB.all(`
            SELECT group_jid, name
            FROM wa_groups
            WHERE is_member = TRUE
            ORDER BY group_jid ASC
        `);

        let startGroupIndex = Math.max(0, groups.findIndex(group => String(group.group_jid) === String(claimed.cursor_group_id)));
        if (claimed.cursor_group_id && startGroupIndex < 0) startGroupIndex = 0;

        for (let groupIndex = startGroupIndex; groupIndex < groups.length; groupIndex += 1) {
            const group = groups[groupIndex];
            let cursorPhone = groupIndex === startGroupIndex && claimed.cursor_group_id === group.group_jid
                ? String(claimed.cursor_phone || '')
                : '';

            while (true) {
                const members = await accountDB.all(`
                    SELECT phone, name, is_admin
                    FROM group_members
                    WHERE group_id = $1 AND phone > $2
                    ORDER BY phone ASC
                    LIMIT $3
                `, [group.group_jid, cursorPhone, BATCH_SIZE]);
                if (!members.length) break;

                for (const member of members) {
                    discovered += 1;
                    cursorPhone = String(member.phone || '');
                    if (member.is_admin === true) {
                        excluded += 1;
                        continue;
                    }

                    const result = await upsertContactAndSource({
                        userId,
                        accountId: claimed.account_id,
                        groupId: group.group_jid,
                        groupName: group.name,
                        role: 'MEMBER',
                        rawPhone: member.phone,
                        displayName: member.name,
                        defaultCountryCode,
                    });
                    if (result.kind === 'new') newContacts += 1;
                    else if (result.kind === 'duplicate') duplicates += 1;
                    else excluded += 1;
                }

                await updateSyncAccount(syncAccountId, {
                    cursor_group_id: group.group_jid,
                    cursor_phone: cursorPhone,
                    discovered_count: discovered,
                    new_contacts_count: newContacts,
                    duplicate_count: duplicates,
                    excluded_count: excluded,
                    heartbeat_at: new Date(),
                    lease_expires_at: nowPlus(LEASE_MS),
                });
                await updateProgressFromAccount(syncAccountId, userId, claimed.sync_job_id);
                if (members.length < BATCH_SIZE) break;
            }
        }

        const finished = await updateSyncAccount(syncAccountId, {
            status: 'COMPLETED',
            discovered_count: discovered,
            new_contacts_count: newContacts,
            duplicate_count: duplicates,
            excluded_count: excluded,
            completed_at: new Date(),
            heartbeat_at: null,
            lease_expires_at: null,
            last_error: null,
        });
        const refreshed = await updateProgressFromAccount(syncAccountId, userId, claimed.sync_job_id);
        await writeAudit({
            userId,
            action: 'SYNC_ACCOUNT_COMPLETED',
            entityType: 'SYNC_ACCOUNT',
            entityId: syncAccountId,
            payload: { accountId: claimed.account_id, discovered, newContacts, duplicates, excluded },
        });
        return { outcome: 'completed', account: finished, job: refreshed.job };
    } catch (error) {
        const attempts = Number(claimed.attempts || 1);
        const retryable = attempts < MAX_RETRIES;
        await updateSyncAccount(syncAccountId, {
            status: retryable ? 'RETRY' : 'FAILED',
            available_at: retryable ? nowPlus(Math.min(60_000, 5_000 * attempts)) : new Date(),
            discovered_count: discovered,
            new_contacts_count: newContacts,
            duplicate_count: duplicates,
            excluded_count: excluded,
            last_error: String(error.message || error).slice(0, 1000),
            heartbeat_at: null,
            lease_expires_at: null,
        });
        const refreshed = await updateProgressFromAccount(syncAccountId, userId, claimed.sync_job_id);
        await writeAudit({
            userId,
            action: retryable ? 'SYNC_ACCOUNT_RETRY' : 'SYNC_ACCOUNT_FAILED',
            entityType: 'SYNC_ACCOUNT',
            entityId: syncAccountId,
            payload: { accountId: claimed.account_id, error: error.message, attempts },
        });
        throw error;
    }
}

async function createSyncJob({ userId, actorId = userId, admin = false, accountIds = [], requestId = null, defaultCountryCode = '' }) {
    const normalizedRequestId = safeRequestId(requestId);
    if (normalizedRequestId) {
        const existing = await queryOne(`
            SELECT * FROM private_whatsapp_sync_jobs WHERE user_id = $1 AND request_id = $2
        `, [userId, normalizedRequestId]);
        if (existing) return { job: existing, duplicate: true };
    }

    const savedSettings = await getSettings(userId);
    if (savedSettings.sync_enabled === false) {
        const error = new Error('المزامنة معطلة من إعدادات قسم خاص واتس اب');
        error.statusCode = 409;
        throw error;
    }
    const effectiveCountryCode = defaultCountryCode || savedSettings.default_country_code || '';
    const accounts = await scopedAccounts({ userId, admin, accountIds });
    if (!accounts.length) {
        const error = new Error('لا توجد حسابات واتساب عامة صالحة للمزامنة');
        error.statusCode = 422;
        throw error;
    }

    const result = await withTransaction(async client => {
        const jobResult = await client.query(`
            INSERT INTO private_whatsapp_sync_jobs
                (user_id,status,requested_account_ids,total_accounts,request_id,settings)
            VALUES ($1,'QUEUED',$2::jsonb,$3,$4,$5::jsonb)
            RETURNING *
        `, [userId, JSON.stringify(accounts.map(account => account.id)), accounts.length, normalizedRequestId,
            JSON.stringify({ default_country_code: String(effectiveCountryCode || '').replace(/[^0-9]/g, '').slice(0, 3) || null })]);
        const job = jobResult.rows[0];
        const rows = [];
        for (const account of accounts) {
            const accountResult = await client.query(`
                INSERT INTO private_whatsapp_sync_accounts
                    (sync_job_id,user_id,account_id,status,available_at)
                VALUES ($1,$2,$3,'QUEUED',NOW())
                RETURNING id, account_id
            `, [job.id, userId, account.id]);
            rows.push(accountResult.rows[0]);
        }
        return { job, rows };
    });

    const enqueueResults = await Promise.allSettled(result.rows.map(async row => {
        const queueJob = await QueueManager.enqueuePrivateWhatsAppSync({ syncAccountId: row.id }, { attempts: MAX_RETRIES });
        await query(`UPDATE private_whatsapp_sync_accounts SET queue_job_id = $1, updated_at = NOW() WHERE id = $2`, [String(queueJob.id), row.id]);
        return queueJob.id;
    }));

    const enqueueErrors = enqueueResults.filter(item => item.status === 'rejected').length;
    if (enqueueErrors) {
        console.warn(`[PrivateWhatsApp] ${enqueueErrors} sync queue jobs deferred to recovery worker.`);
    }

    await writeAudit({ userId, actorId, action: 'SYNC_REQUESTED', entityType: 'SYNC_JOB', entityId: result.job.id, payload: { accountIds: accounts.map(account => account.id), enqueueErrors } });
    emitProgress(userId, { syncJobId: result.job.id, status: 'QUEUED', totalAccounts: accounts.length, processedAccounts: 0, discovered: 0, newContacts: 0, duplicates: 0, excluded: 0 });
    return { job: result.job, duplicate: false, enqueueErrors };
}

async function getSyncJob(userId, syncJobId) {
    return queryOne(`
        SELECT j.*,
               COALESCE(jsonb_agg(a ORDER BY a.created_at) FILTER (WHERE a.id IS NOT NULL), '[]'::jsonb) AS accounts
        FROM private_whatsapp_sync_jobs j
        LEFT JOIN private_whatsapp_sync_accounts a ON a.sync_job_id = j.id
        WHERE j.id = $1 AND j.user_id = $2
        GROUP BY j.id
    `, [syncJobId, userId]);
}

async function listContacts(userId, options = {}) {
    const page = Math.max(1, Number(options.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(options.limit) || 50));
    const offset = (page - 1) * limit;
    const values = [userId];
    const conditions = ['c.user_id = $1'];

    if (options.search) {
        values.push(`%${String(options.search).trim()}%`);
        conditions.push(`(c.normalized_phone ILIKE $${values.length} OR c.original_phone ILIKE $${values.length})`);
    }
    if (options.consentStatus && ['OPTED_IN', 'OPTED_OUT', 'UNKNOWN'].includes(String(options.consentStatus))) {
        values.push(String(options.consentStatus));
        conditions.push(`c.consent_status = $${values.length}`);
    }
    if (options.status) {
        values.push(String(options.status));
        conditions.push(`c.status = $${values.length}`);
    }

    const where = conditions.join(' AND ');
    const count = await queryOne(`SELECT COUNT(*)::int AS total FROM private_whatsapp_contacts c WHERE ${where}`, values);
    values.push(limit, offset);
    const rows = await queryAll(`
        SELECT c.*,
               COALESCE(jsonb_agg(DISTINCT jsonb_build_object(
                   'accountId', s.source_account_id,
                   'groupId', s.source_group_id,
                   'groupName', s.source_group_name,
                   'role', s.role,
                   'lastSeenAt', s.last_seen_at
               )) FILTER (WHERE s.id IS NOT NULL), '[]'::jsonb) AS sources
        FROM private_whatsapp_contacts c
        LEFT JOIN private_whatsapp_contact_sources s ON s.contact_id = c.id AND s.user_id = c.user_id
        WHERE ${where}
        GROUP BY c.id
        ORDER BY c.last_seen_at DESC
        LIMIT $${values.length - 1} OFFSET $${values.length}
    `, values);
    return { rows, total: Number(count?.total || 0), page, limit, pages: Math.ceil(Number(count?.total || 0) / limit) };
}

async function updateConsent(userId, contactId, consentStatus) {
    if (!['OPTED_IN', 'OPTED_OUT', 'UNKNOWN'].includes(consentStatus)) {
        const error = new Error('حالة الموافقة غير صالحة');
        error.statusCode = 422;
        throw error;
    }
    const updated = await queryOne(`
        UPDATE private_whatsapp_contacts
        SET consent_status = $3,
            opt_out_status = ($3 = 'OPTED_OUT'),
            status = CASE WHEN $3 = 'OPTED_OUT' THEN 'DO_NOT_CONTACT'
                       WHEN $3 = 'OPTED_IN' AND status = 'DO_NOT_CONTACT' THEN 'ACTIVE'
                       ELSE status END,
            updated_at = NOW()
        WHERE id = $1 AND user_id = $2
        RETURNING *
    `, [contactId, userId, consentStatus]);
    if (!updated) {
        const error = new Error('جهة الاتصال غير موجودة');
        error.statusCode = 404;
        throw error;
    }
    await writeAudit({ userId, action: 'CONTACT_CONSENT_UPDATED', entityType: 'CONTACT', entityId: contactId, payload: { consentStatus } });
    return updated;
}

async function getSettings(userId) {
    const row = await queryOne(`
        SELECT user_id, default_country_code, sync_enabled, created_at, updated_at
        FROM private_whatsapp_settings
        WHERE user_id = $1
    `, [userId]);
    return row || { user_id: userId, default_country_code: '', sync_enabled: true, created_at: null, updated_at: null };
}

async function updateSettings(userId, actorId = userId, patch = {}) {
    const current = await getSettings(userId);
    const defaultCountryCode = String(patch.defaultCountryCode === undefined ? (current.default_country_code || '') : patch.defaultCountryCode).replace(/[^0-9]/g, '');
    if (defaultCountryCode.length > 3) {
        const error = new Error('رمز الدولة الافتراضي غير صالح');
        error.statusCode = 422;
        throw error;
    }
    const syncEnabled = patch.syncEnabled === undefined ? current.sync_enabled !== false : Boolean(patch.syncEnabled);
    const updated = await queryOne(`
        INSERT INTO private_whatsapp_settings (user_id, default_country_code, sync_enabled, updated_by)
        VALUES ($1,$2,$3,$4)
        ON CONFLICT (user_id) DO UPDATE SET
            default_country_code = EXCLUDED.default_country_code,
            sync_enabled = EXCLUDED.sync_enabled,
            updated_by = EXCLUDED.updated_by,
            updated_at = NOW()
        RETURNING user_id, default_country_code, sync_enabled, created_at, updated_at
    `, [userId, defaultCountryCode || null, syncEnabled, actorId]);
    await writeAudit({ userId, actorId, action: 'SETTINGS_UPDATED', entityType: 'SETTINGS', payload: { syncEnabled, hasDefaultCountryCode: Boolean(defaultCountryCode) } });
    return updated;
}

async function getPublishingAccounts(userId) {
    return queryAll(`
        SELECT id, name, phone_number, status, last_activity_at, created_at, updated_at
        FROM private_whatsapp_publishing_accounts
        WHERE user_id = $1
        ORDER BY created_at DESC
    `, [userId]);
}

async function getDashboard(userId, { admin = false } = {}) {
    const accounts = await scopedAccounts({ userId, admin });
    const [contactStats, syncJobs, settings, publishingAccounts] = await Promise.all([

        queryOne(`
            SELECT COUNT(*)::int AS contacts,
                   COUNT(*) FILTER (WHERE consent_status = 'OPTED_IN' AND opt_out_status = FALSE)::int AS opted_in,
                   COUNT(*) FILTER (WHERE consent_status = 'OPTED_OUT' OR opt_out_status = TRUE)::int AS opted_out,
                   COUNT(*) FILTER (WHERE consent_status = 'UNKNOWN')::int AS unknown
            FROM private_whatsapp_contacts WHERE user_id = $1
        `, [userId]),
        queryAll(`SELECT * FROM private_whatsapp_sync_jobs WHERE user_id = $1 ORDER BY created_at DESC LIMIT 10`, [userId]),
        getSettings(userId),
        getPublishingAccounts(userId),
    ]);

    let totalGroups = 0;
    for (const account of accounts) {
        try {
            const accountDB = await DatabaseManager.getAccountDB(String(account.id));
            const result = await accountDB.get(`SELECT COUNT(*)::int AS total FROM wa_groups WHERE is_member = TRUE`);
            totalGroups += Number(result?.total || 0);
        } catch (error) {
            console.warn(`[PrivateWhatsApp] groups count unavailable for ${account.id}:`, error.message);
        }
    }

    return {
        contacts: {
            total: Number(contactStats?.contacts || 0),
            optedIn: Number(contactStats?.opted_in || 0),
            optedOut: Number(contactStats?.opted_out || 0),
            unknown: Number(contactStats?.unknown || 0),
        },
        sourceAccounts: accounts,
        sourceAccountCount: accounts.length,
        connectedSourceAccountCount: accounts.filter(account => account.status === 'connected').length,
        groupCount: totalGroups,
        syncJobs,
        settings,
        publishingAccounts,
        publishingAccountsAvailable: true,
    };
}

async function recoverPendingJobs() {
    if (recoveryRunning) return 0;
    recoveryRunning = true;
    try {
        await query(`
            UPDATE private_whatsapp_sync_accounts
            SET status = 'RETRY', available_at = NOW(), worker_id = NULL,
                lease_expires_at = NULL, heartbeat_at = NULL, updated_at = NOW()
            WHERE status = 'PROCESSING' AND lease_expires_at < NOW()
        `);
        const pending = await queryAll(`
            SELECT id
            FROM private_whatsapp_sync_accounts
            WHERE status IN ('QUEUED','RETRY')
              AND available_at <= NOW()
              AND attempts < $1
            ORDER BY created_at ASC
            LIMIT 100
        `, [MAX_RETRIES + 1]);
        let enqueued = 0;
        for (const row of pending) {
            try {
                const queueJob = await QueueManager.enqueuePrivateWhatsAppSync({ syncAccountId: row.id }, { attempts: MAX_RETRIES });
                await query(`UPDATE private_whatsapp_sync_accounts SET queue_job_id = $1, updated_at = NOW() WHERE id = $2`, [String(queueJob.id), row.id]);
                enqueued += 1;
            } catch (error) {
                console.warn('[PrivateWhatsApp] recovery enqueue deferred:', error.message);
            }
        }
        return enqueued;
    } finally {
        recoveryRunning = false;
    }
}

function startRecoveryWorker() {
    if (recoveryTimer) return;
    recoverPendingJobs().catch(error => console.warn('[PrivateWhatsApp] initial recovery failed:', error.message));
    recoveryTimer = setInterval(() => recoverPendingJobs().catch(error => console.warn('[PrivateWhatsApp] recovery failed:', error.message)), RECOVERY_MS);
    recoveryTimer.unref?.();
    console.log(`[PrivateWhatsApp] Recovery worker started (${RECOVERY_MS}ms interval).`);
}

function stopRecoveryWorker() {
    if (recoveryTimer) clearInterval(recoveryTimer);
    recoveryTimer = null;
}

module.exports = {
    BATCH_SIZE,
    MAX_RETRIES,
    normalizePhone,
    createSyncJob,
    getSyncJob,
    listContacts,
    updateConsent,
    getSettings,
    updateSettings,
    getPublishingAccounts,
    getDashboard,
    processSyncAccount,
    recoverPendingJobs,
    startRecoveryWorker,
    stopRecoveryWorker,
};
