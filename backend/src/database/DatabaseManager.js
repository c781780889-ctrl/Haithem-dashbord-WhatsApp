'use strict';
/**
 * DatabaseManager — Per-Account PostgreSQL Schema Manager
 * ─────────────────────────────────────────────────────────────────────
 * [DB-UNIFY] توحيد طبقة قاعدة البيانات:
 *  - DatabaseManager لم يعد يُنشئ pool مستقلًا من `pg` مباشرة.
 *  - إنشاء الـ schema لكل حساب + عميل الاتصال المخصّص (search_path) يتم
 *    عبر الـ pool المركزي الوحيد في `src/lib/postgres.js` (createAccountPool)،
 *    لضمان إعدادات اتصال موحّدة (ssl, keepAlive, reconnect, DB_POOL_MAX).
 */
const { getPool, createAccountPool } = require('../lib/postgres');
const SystemDB = require('./SystemDB');

const accountDBs = new Map();

const ACCOUNT_SCHEMA = (s) => `
CREATE SCHEMA IF NOT EXISTS "${s}";
SET search_path TO "${s}", public;

CREATE TABLE IF NOT EXISTS groups (id TEXT PRIMARY KEY, name TEXT, description TEXT, participant_count INT DEFAULT 0, category TEXT DEFAULT 'general', is_active BOOLEAN DEFAULT TRUE, joined_at TIMESTAMPTZ DEFAULT NOW(), last_sync_at TIMESTAMPTZ, created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW());
CREATE TABLE IF NOT EXISTS group_members (group_id TEXT, phone TEXT NOT NULL, name TEXT, is_admin BOOLEAN DEFAULT FALSE, joined_at TIMESTAMPTZ DEFAULT NOW(), PRIMARY KEY (group_id, phone));
CREATE TABLE IF NOT EXISTS links (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), url TEXT NOT NULL, group_id TEXT, source_message TEXT, category TEXT DEFAULT 'general', is_spam BOOLEAN DEFAULT FALSE, extracted_at TIMESTAMPTZ DEFAULT NOW(), created_at TIMESTAMPTZ DEFAULT NOW());
CREATE TABLE IF NOT EXISTS schedules (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), name TEXT, status VARCHAR(50) DEFAULT 'active', cron_expr TEXT, ad_library_id UUID, target_groups JSONB DEFAULT '[]', next_run_at TIMESTAMPTZ, last_run_at TIMESTAMPTZ, run_count INT DEFAULT 0, created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW());
CREATE TABLE IF NOT EXISTS ad_library (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), name TEXT NOT NULL, content TEXT DEFAULT '', media_paths JSONB DEFAULT '[]', media_types JSONB DEFAULT '[]', links JSONB DEFAULT '[]', format_options JSONB DEFAULT '{}', priority INT DEFAULT 5, tags TEXT DEFAULT '', is_active BOOLEAN DEFAULT TRUE, use_count INT DEFAULT 0, created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW());
ALTER TABLE ad_library ADD COLUMN IF NOT EXISTS last_used_at TIMESTAMPTZ;
CREATE TABLE IF NOT EXISTS campaigns (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), name TEXT, status VARCHAR(50) DEFAULT 'pending', target_groups JSONB DEFAULT '[]', ad_library_id UUID, target_type VARCHAR(50) DEFAULT 'group_members', batch_size INT DEFAULT 50, interval_seconds INT DEFAULT 10, daily_limit INT DEFAULT 1000, scheduled_at TIMESTAMPTZ, sent_count INT DEFAULT 0, failed_count INT DEFAULT 0, total_targets INT DEFAULT 0, started_at TIMESTAMPTZ, finished_at TIMESTAMPTZ, created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW());
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS target_type VARCHAR(50) DEFAULT 'group_members';
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS batch_size INT DEFAULT 50;
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS interval_seconds INT DEFAULT 10;
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS daily_limit INT DEFAULT 1000;
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS scheduled_at TIMESTAMPTZ;
CREATE TABLE IF NOT EXISTS campaign_targets (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), campaign_id UUID NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE, target_jid TEXT NOT NULL, status VARCHAR(20) DEFAULT 'pending', sent_at TIMESTAMPTZ, error_msg TEXT, created_at TIMESTAMPTZ DEFAULT NOW());
CREATE INDEX IF NOT EXISTS campaign_targets_campaign_id_idx ON campaign_targets(campaign_id);
CREATE TABLE IF NOT EXISTS campaign_logs (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), campaign_id UUID NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE, level VARCHAR(20) DEFAULT 'info', message TEXT, created_at TIMESTAMPTZ DEFAULT NOW());
CREATE INDEX IF NOT EXISTS campaign_logs_campaign_id_idx ON campaign_logs(campaign_id);
CREATE TABLE IF NOT EXISTS campaign_exclusions (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), campaign_id UUID NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE, target_jid TEXT, reason VARCHAR(50), created_at TIMESTAMPTZ DEFAULT NOW());
CREATE INDEX IF NOT EXISTS campaign_exclusions_campaign_id_idx ON campaign_exclusions(campaign_id);
CREATE TABLE IF NOT EXISTS broadcast_schedules (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), name TEXT, account_id TEXT, status VARCHAR(50) DEFAULT 'paused', target_group_jids JSONB DEFAULT '[]', ad_library_ids JSONB DEFAULT '[]', rotation_mode VARCHAR(50) DEFAULT 'sequential', active_days JSONB DEFAULT '[0,1,2,3,4,5,6]', publish_times JSONB DEFAULT '[]', max_per_day INT DEFAULT 3, send_to_members BOOLEAN DEFAULT FALSE, exclude_admins BOOLEAN DEFAULT TRUE, next_run_at TIMESTAMPTZ, last_run_at TIMESTAMPTZ, created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW());
ALTER TABLE broadcast_schedules ADD COLUMN IF NOT EXISTS account_id TEXT;
ALTER TABLE broadcast_schedules ADD COLUMN IF NOT EXISTS target_group_jids JSONB DEFAULT '[]';
ALTER TABLE broadcast_schedules ADD COLUMN IF NOT EXISTS ad_library_ids JSONB DEFAULT '[]';
ALTER TABLE broadcast_schedules ADD COLUMN IF NOT EXISTS rotation_mode VARCHAR(50) DEFAULT 'sequential';
ALTER TABLE broadcast_schedules ADD COLUMN IF NOT EXISTS active_days JSONB DEFAULT '[0,1,2,3,4,5,6]';
ALTER TABLE broadcast_schedules ADD COLUMN IF NOT EXISTS publish_times JSONB DEFAULT '[]';
ALTER TABLE broadcast_schedules ADD COLUMN IF NOT EXISTS max_per_day INT DEFAULT 3;
ALTER TABLE broadcast_schedules ADD COLUMN IF NOT EXISTS send_to_members BOOLEAN DEFAULT FALSE;
ALTER TABLE broadcast_schedules ADD COLUMN IF NOT EXISTS exclude_admins BOOLEAN DEFAULT TRUE;
CREATE TABLE IF NOT EXISTS direct_publish_log (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), account_id TEXT, ad_library_id UUID, target_group_jids JSONB DEFAULT '[]', custom_content TEXT DEFAULT '', status VARCHAR(50) DEFAULT 'sent', send_to_members BOOLEAN DEFAULT FALSE, exclude_admins BOOLEAN DEFAULT TRUE, members_sent INT DEFAULT 0, sent_at TIMESTAMPTZ DEFAULT NOW(), created_at TIMESTAMPTZ DEFAULT NOW());
ALTER TABLE direct_publish_log ADD COLUMN IF NOT EXISTS account_id TEXT;
ALTER TABLE direct_publish_log ADD COLUMN IF NOT EXISTS target_group_jids JSONB DEFAULT '[]';
ALTER TABLE direct_publish_log ADD COLUMN IF NOT EXISTS custom_content TEXT DEFAULT '';
ALTER TABLE direct_publish_log ADD COLUMN IF NOT EXISTS status VARCHAR(50) DEFAULT 'sent';
ALTER TABLE direct_publish_log ADD COLUMN IF NOT EXISTS send_to_members BOOLEAN DEFAULT FALSE;
ALTER TABLE direct_publish_log ADD COLUMN IF NOT EXISTS exclude_admins BOOLEAN DEFAULT TRUE;
ALTER TABLE direct_publish_log ADD COLUMN IF NOT EXISTS members_sent INT DEFAULT 0;
ALTER TABLE direct_publish_log ADD COLUMN IF NOT EXISTS sent_at TIMESTAMPTZ DEFAULT NOW();
ALTER TABLE direct_publish_log ADD COLUMN IF NOT EXISTS ad_library_ids JSONB DEFAULT '[]';
ALTER TABLE direct_publish_log ADD COLUMN IF NOT EXISTS groups_targeted INT DEFAULT 0;
ALTER TABLE direct_publish_log ADD COLUMN IF NOT EXISTS groups_sent INT DEFAULT 0;
ALTER TABLE direct_publish_log ADD COLUMN IF NOT EXISTS groups_failed INT DEFAULT 0;
ALTER TABLE direct_publish_log ADD COLUMN IF NOT EXISTS members_targeted INT DEFAULT 0;
ALTER TABLE direct_publish_log ADD COLUMN IF NOT EXISTS members_failed INT DEFAULT 0;
ALTER TABLE direct_publish_log ADD COLUMN IF NOT EXISTS member_delay_ms INT DEFAULT 1500;
ALTER TABLE direct_publish_log ADD COLUMN IF NOT EXISTS details JSONB DEFAULT '[]';
CREATE TABLE IF NOT EXISTS group_exclusions (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), phone TEXT NOT NULL UNIQUE, reason TEXT, created_at TIMESTAMPTZ DEFAULT NOW());
CREATE TABLE IF NOT EXISTS sync_settings (id INT PRIMARY KEY DEFAULT 1, settings JSONB DEFAULT '{}', updated_at TIMESTAMPTZ DEFAULT NOW());
CREATE TABLE IF NOT EXISTS account_logs (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), level VARCHAR(20) DEFAULT 'info', message TEXT, details JSONB, created_at TIMESTAMPTZ DEFAULT NOW());
CREATE TABLE IF NOT EXISTS connection_attempts (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), status VARCHAR(50), method VARCHAR(50), duration_ms INT, error_message TEXT, created_at TIMESTAMPTZ DEFAULT NOW());
CREATE TABLE IF NOT EXISTS qr_events (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), attempt_id UUID, event_type VARCHAR(50), latency_ms INT, created_at TIMESTAMPTZ DEFAULT NOW());
CREATE TABLE IF NOT EXISTS baileys_events (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), event_type VARCHAR(100), success BOOLEAN DEFAULT TRUE, error_message TEXT, details JSONB, created_at TIMESTAMPTZ DEFAULT NOW());
CREATE TABLE IF NOT EXISTS diagnostics (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), report JSONB, score INT, created_at TIMESTAMPTZ DEFAULT NOW());
CREATE TABLE IF NOT EXISTS business_api_settings (id INT PRIMARY KEY DEFAULT 1, phone_number_id TEXT, access_token TEXT, webhook_verify_token TEXT, settings JSONB DEFAULT '{}', updated_at TIMESTAMPTZ DEFAULT NOW());
CREATE TABLE IF NOT EXISTS pairing_attempts (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), phone TEXT, code TEXT, status VARCHAR(50), latency_ms INT, created_at TIMESTAMPTZ DEFAULT NOW());
CREATE TABLE IF NOT EXISTS schema_migrations (version INT PRIMARY KEY, name TEXT, applied_at TIMESTAMPTZ DEFAULT NOW());
`;

const DatabaseManager = {
    systemDB: SystemDB,

    async init() {
        await SystemDB.init();
        console.log('[DatabaseManager] Initialized.');
    },

    async getAccountDB(accountId) {
        if (accountDBs.has(accountId)) return accountDBs.get(accountId);

        const schemaName = `acc_${accountId.replace(/-/g, '_')}`;

        // [DB-UNIFY] تطبيق الـ schema عبر عميل من الـ pool المركزي
        const client = await getPool().connect();
        try {
            // تشغيل كل statement منفصلاً لضمان تطبيق ALTER TABLE
            const schemaSQL = ACCOUNT_SCHEMA(schemaName);
            const statements = schemaSQL
                .split(';')
                .map(s => s.trim())
                .filter(s => s.length > 0);
            for (const stmt of statements) {
                try {
                    await client.query(stmt);
                } catch (stmtErr) {
                    if (!stmtErr.message.includes('already exists')) {
                        console.warn(`[DatabaseManager] stmt warning (${accountId}):`, stmtErr.message);
                    }
                }
            }
        } catch (err) {
            console.error(`[DatabaseManager] Schema error for ${accountId}:`, err.message);
        } finally {
            client.release();
        }

        // [DB-UNIFY] عميل اتصال مخصّص بـ search_path من الـ pool المركزي
        const db = createAccountPool(accountId, schemaName);
        accountDBs.set(accountId, db);
        return db;
    },

    async closeAll() {
        accountDBs.clear();
        // [DB-UNIFY] إغلاق الـ pool المركزي الوحيد
        await SystemDB.close();
    },
};

module.exports = DatabaseManager;
