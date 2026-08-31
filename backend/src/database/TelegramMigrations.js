'use strict';
/**
 * Telegram System Migrations
 * إنشاء/تحديث جداول نظام تيليجرام في قاعدة البيانات
 */

const { query } = require('../lib/postgres');

const TelegramMigrations = {
    async run() {
        try {
            // ── جدول حسابات تيليجرام ─────────────────────────────────────
            await query(`
                CREATE TABLE IF NOT EXISTS telegram_accounts (
                    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                    user_id UUID,
                    name VARCHAR(200) NOT NULL,
                    phone_number VARCHAR(50),
                    api_id VARCHAR(100),
                    api_hash VARCHAR(200),
                    session_string TEXT,
                    bot_token TEXT,
                    bot_username VARCHAR(100),
                    status VARCHAR(50) DEFAULT 'disconnected',
                    last_activity_at TIMESTAMPTZ,
                    links_collected INT DEFAULT 0,
                    channels_monitored INT DEFAULT 0,
                    notes TEXT,
                    created_at TIMESTAMPTZ DEFAULT NOW(),
                    updated_at TIMESTAMPTZ DEFAULT NOW()
                )
            `);

            // ── أعمدة المصادقة الحديثة ─────────────────────────────────
            const alterCmds = [
                `ALTER TABLE telegram_accounts ADD COLUMN IF NOT EXISTS session_encrypted TEXT`,
                `ALTER TABLE telegram_accounts ADD COLUMN IF NOT EXISTS telegram_user_id TEXT`,
                `ALTER TABLE telegram_accounts ADD COLUMN IF NOT EXISTS username VARCHAR(200)`,
                `ALTER TABLE telegram_accounts ADD COLUMN IF NOT EXISTS first_name VARCHAR(200)`,
                `ALTER TABLE telegram_accounts ADD COLUMN IF NOT EXISTS last_name VARCHAR(200)`,
                `ALTER TABLE telegram_accounts ADD COLUMN IF NOT EXISTS last_connected_at TIMESTAMPTZ`,
                `ALTER TABLE telegram_accounts ADD COLUMN IF NOT EXISTS auth_required BOOLEAN NOT NULL DEFAULT false`,
                `ALTER TABLE telegram_auth_sessions ADD COLUMN IF NOT EXISTS last_error TEXT`,
                `ALTER TABLE telegram_accounts ADD COLUMN IF NOT EXISTS bot_token TEXT`,
                `ALTER TABLE telegram_accounts ADD COLUMN IF NOT EXISTS bot_username VARCHAR(100)`,
                `ALTER TABLE telegram_keyword_results ADD COLUMN IF NOT EXISTS sender_access_hash TEXT`,
                `ALTER TABLE telegram_keyword_results ADD COLUMN IF NOT EXISTS sender_first_name TEXT`,
                `ALTER TABLE telegram_keyword_results ADD COLUMN IF NOT EXISTS sender_last_name TEXT`,
                `ALTER TABLE telegram_keyword_results ADD COLUMN IF NOT EXISTS sender_peer_type VARCHAR(30)`,
                `ALTER TABLE telegram_keyword_results ADD COLUMN IF NOT EXISTS ignored BOOLEAN DEFAULT FALSE`,
                `ALTER TABLE telegram_accounts ALTER COLUMN phone_number DROP NOT NULL`,
            ];
            for (const cmd of alterCmds) {
                await query(cmd).catch(() => {}); // تجاهل أخطاء "already exists"
            }
            await query(`
                CREATE TABLE IF NOT EXISTS telegram_auth_sessions (
                    id UUID PRIMARY KEY DEFAULT gen_random_uuid(), user_id UUID NOT NULL,
                    phone_reference TEXT NOT NULL, phone_code_hash TEXT,
                    state VARCHAR(32) NOT NULL DEFAULT 'created', client_reference TEXT,
                    expires_at TIMESTAMPTZ NOT NULL, attempts INT NOT NULL DEFAULT 0, last_error TEXT,
                    created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW()
                )
            `);
            await query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_tg_auth_active_phone ON telegram_auth_sessions(user_id,phone_reference) WHERE state IN ('created','code_requested','waiting_code','verifying','waiting_2fa')`).catch(() => {});
            await query(`CREATE INDEX IF NOT EXISTS idx_tg_auth_expiry ON telegram_auth_sessions(expires_at)`).catch(() => {});

            // ── جدول روابط واتساب المكتشفة ──────────────────────────────
            await query(`
                CREATE TABLE IF NOT EXISTS whatsapp_links (
                    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                    whatsapp_link TEXT NOT NULL UNIQUE,
                    source_account_id UUID,
                    source_account_name VARCHAR(200),
                    source_group VARCHAR(500),
                    source_channel VARCHAR(500),
                    discovered_at TIMESTAMPTZ DEFAULT NOW(),
                    last_seen TIMESTAMPTZ DEFAULT NOW(),
                    duplicate_count INT DEFAULT 0,
                    source_history JSONB NOT NULL DEFAULT '[]'::jsonb,
                    discovered_by_account_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
                    last_verified_at TIMESTAMPTZ,
                    processing_status VARCHAR(30) NOT NULL DEFAULT 'new',
                    next_operation_at TIMESTAMPTZ,
                    last_operation_id UUID,
                    status VARCHAR(50) DEFAULT 'new',
                    joined BOOLEAN DEFAULT false,
                    copied BOOLEAN DEFAULT false,
                    deleted BOOLEAN DEFAULT false,
                    import_user_id UUID,
                    notes TEXT,
                    created_at TIMESTAMPTZ DEFAULT NOW(),
                    updated_at TIMESTAMPTZ DEFAULT NOW()
                )
            `);

            await query(`ALTER TABLE whatsapp_links ADD COLUMN IF NOT EXISTS copied_at TIMESTAMPTZ`).catch(() => {});
            await query(`ALTER TABLE whatsapp_links ADD COLUMN IF NOT EXISTS source_history JSONB NOT NULL DEFAULT '[]'::jsonb`).catch(() => {});
            await query(`ALTER TABLE whatsapp_links ADD COLUMN IF NOT EXISTS discovered_by_account_ids JSONB NOT NULL DEFAULT '[]'::jsonb`).catch(() => {});
            await query(`ALTER TABLE whatsapp_links ADD COLUMN IF NOT EXISTS last_verified_at TIMESTAMPTZ`).catch(() => {});
            await query(`ALTER TABLE whatsapp_links ADD COLUMN IF NOT EXISTS processing_status VARCHAR(30) NOT NULL DEFAULT 'new'`).catch(() => {});
            await query(`ALTER TABLE whatsapp_links ADD COLUMN IF NOT EXISTS next_operation_at TIMESTAMPTZ`).catch(() => {});
            await query(`ALTER TABLE whatsapp_links ADD COLUMN IF NOT EXISTS last_operation_id UUID`).catch(() => {});
            await query(`ALTER TABLE whatsapp_links ADD COLUMN IF NOT EXISTS import_user_id UUID`).catch(() => {});
            await query(`ALTER TABLE whatsapp_links ADD COLUMN IF NOT EXISTS joined_by_accounts JSONB NOT NULL DEFAULT '[]'::jsonb`).catch(() => {});
            await query(`ALTER TABLE whatsapp_links ADD COLUMN IF NOT EXISTS membership_state VARCHAR(30)`).catch(() => {});
            await query(`CREATE INDEX IF NOT EXISTS idx_whatsapp_links_import_user ON whatsapp_links(import_user_id) WHERE import_user_id IS NOT NULL`).catch(() => {});
            await query(`CREATE INDEX IF NOT EXISTS idx_whatsapp_links_processing ON whatsapp_links(processing_status, next_operation_at) WHERE deleted=false`).catch(() => {});
            await query(`CREATE INDEX IF NOT EXISTS idx_whatsapp_links_copied ON whatsapp_links(copied, discovered_at DESC) WHERE deleted=false`).catch(() => {});

            // ── الرسائل المتجاهلة في مركز كلمات تيليجرام ────────────────
            await query(`
                CREATE TABLE IF NOT EXISTS telegram_ignored_messages (
                    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                    telegram_account_id UUID NOT NULL,
                    chat_id TEXT NOT NULL,
                    message_id TEXT NOT NULL,
                    sender_id TEXT,
                    message_hash TEXT,
                    ignored_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                    ignored_by UUID,
                    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                    UNIQUE (telegram_account_id, chat_id, message_id)
                )
            `);
            await query(`CREATE INDEX IF NOT EXISTS idx_tg_ignored_lookup ON telegram_ignored_messages(telegram_account_id, chat_id, message_id)`).catch(() => {});
            await query(`CREATE INDEX IF NOT EXISTS idx_tg_ignored_hash ON telegram_ignored_messages(message_hash) WHERE message_hash IS NOT NULL`).catch(() => {});

            // ── المستخدمون المحظورون في مركز كلمات تيليجرام ─────────────
            await query(`
                CREATE TABLE IF NOT EXISTS telegram_keyword_blocked_users (
                    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                    user_id UUID NOT NULL,
                    telegram_user_id TEXT NOT NULL,
                    telegram_username TEXT,
                    display_name TEXT,
                    blocked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                    blocked_by UUID,
                    reason TEXT,
                    is_active BOOLEAN NOT NULL DEFAULT TRUE,
                    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                    UNIQUE (user_id, telegram_user_id)
                )
            `);
            await query(`CREATE INDEX IF NOT EXISTS idx_tg_blocked_users_active ON telegram_keyword_blocked_users(user_id, is_active, telegram_user_id)`).catch(() => {});
            await query(`CREATE INDEX IF NOT EXISTS idx_tg_blocked_users_search ON telegram_keyword_blocked_users(user_id, telegram_username, display_name)`).catch(() => {});

            // ── المحادثات المثبتة في مركز كلمات تيليجرام ────────────────
            await query(`
                CREATE TABLE IF NOT EXISTS telegram_keyword_pinned_chats (
                    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                    user_id UUID NOT NULL,
                    telegram_account_id UUID NOT NULL REFERENCES telegram_accounts(id) ON DELETE CASCADE,
                    chat_id TEXT NOT NULL,
                    chat_title TEXT,
                    chat_username TEXT,
                    chat_type VARCHAR(30),
                    pinned_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                    UNIQUE (user_id, telegram_account_id, chat_id)
                )
            `);
            await query(`CREATE INDEX IF NOT EXISTS idx_tg_pinned_chats_user_order ON telegram_keyword_pinned_chats(user_id, pinned_at DESC)`).catch(() => {});
            await query(`CREATE INDEX IF NOT EXISTS idx_tg_pinned_chats_lookup ON telegram_keyword_pinned_chats(user_id, telegram_account_id, chat_id)`).catch(() => {});

            // ── المحادثات الذكية في Telegram ────────────────────────────
            await query(`
                CREATE TABLE IF NOT EXISTS telegram_smart_rules (
                    id UUID PRIMARY KEY DEFAULT gen_random_uuid(), user_id UUID NOT NULL,
                    name TEXT NOT NULL, description TEXT, instructions TEXT NOT NULL,
                    match_mode VARCHAR(20) NOT NULL DEFAULT 'balanced', min_score INT NOT NULL DEFAULT 70,
                    priority VARCHAR(20) NOT NULL DEFAULT 'medium', account_ids JSONB NOT NULL DEFAULT '[]',
                    group_mode VARCHAR(20) NOT NULL DEFAULT 'all', group_ids JSONB NOT NULL DEFAULT '[]',
                    exclude_group_ids JSONB NOT NULL DEFAULT '[]', is_active BOOLEAN NOT NULL DEFAULT TRUE,
                    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
                )
            `);
            await query(`
                CREATE TABLE IF NOT EXISTS telegram_smart_results (
                    id UUID PRIMARY KEY DEFAULT gen_random_uuid(), user_id UUID NOT NULL,
                    rule_id UUID NOT NULL REFERENCES telegram_smart_rules(id) ON DELETE CASCADE,
                    telegram_account_id UUID NOT NULL REFERENCES telegram_accounts(id) ON DELETE CASCADE,
                    chat_id TEXT NOT NULL, chat_title TEXT, chat_username TEXT, chat_type VARCHAR(30), message_id TEXT NOT NULL, sender_id TEXT,
                    sender_username TEXT, sender_name TEXT, message_text TEXT NOT NULL,
                    context JSONB NOT NULL DEFAULT '{}'::jsonb, match_score NUMERIC(5,2) NOT NULL DEFAULT 0,
                    is_match BOOLEAN NOT NULL DEFAULT FALSE, reason TEXT, status VARCHAR(30) NOT NULL DEFAULT 'new',
                    is_saved BOOLEAN NOT NULL DEFAULT FALSE, is_pinned BOOLEAN NOT NULL DEFAULT FALSE,
                    deleted_in_telegram BOOLEAN NOT NULL DEFAULT FALSE, deleted_at TIMESTAMPTZ,
                    detected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), analyzed_at TIMESTAMPTZ,
                    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                    UNIQUE (telegram_account_id, chat_id, message_id, rule_id)
                )
            `);
            await query(`ALTER TABLE telegram_smart_results ADD COLUMN IF NOT EXISTS chat_title TEXT`).catch(() => {});
            await query(`ALTER TABLE telegram_smart_results ADD COLUMN IF NOT EXISTS chat_username TEXT`).catch(() => {});
            await query(`ALTER TABLE telegram_smart_results ADD COLUMN IF NOT EXISTS chat_type VARCHAR(30)`).catch(() => {});
            await query(`
                CREATE TABLE IF NOT EXISTS telegram_smart_settings (
                    user_id UUID PRIMARY KEY, enabled BOOLEAN NOT NULL DEFAULT TRUE,
                    default_min_score INT NOT NULL DEFAULT 70, context_before INT NOT NULL DEFAULT 2,
                    context_after INT NOT NULL DEFAULT 2, analysis_language VARCHAR(10) NOT NULL DEFAULT 'ar',
                    retention_days INT NOT NULL DEFAULT 90, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
                )
            `);
            await query(`
                CREATE TABLE IF NOT EXISTS telegram_smart_logs (
                    id BIGSERIAL PRIMARY KEY, user_id UUID NOT NULL, rule_id UUID,
                    result_id UUID, telegram_account_id UUID, chat_id TEXT, message_id TEXT,
                    decision VARCHAR(30) NOT NULL, match_score NUMERIC(5,2), reason TEXT,
                    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
                )
            `);
            await query(`
                CREATE TABLE IF NOT EXISTS telegram_smart_notifications (
                    id UUID PRIMARY KEY DEFAULT gen_random_uuid(), user_id UUID NOT NULL,
                    result_id UUID, rule_id UUID, telegram_account_id UUID,
                    severity VARCHAR(20) NOT NULL DEFAULT 'high', title TEXT NOT NULL,
                    sender_name TEXT, sender_username TEXT, chat_title TEXT, chat_id TEXT, message_id TEXT, message_excerpt TEXT,
                    rule_name TEXT, match_score NUMERIC(5,2), payload JSONB NOT NULL DEFAULT '{}'::jsonb,
                    is_read BOOLEAN NOT NULL DEFAULT FALSE, read_at TIMESTAMPTZ,
                    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
                )
            `);
            await query(`ALTER TABLE telegram_smart_notifications ADD COLUMN IF NOT EXISTS chat_id TEXT`).catch(() => {});
            await query(`ALTER TABLE telegram_smart_notifications ADD COLUMN IF NOT EXISTS message_id TEXT`).catch(() => {});
            const smartIndexes = [
                `CREATE INDEX IF NOT EXISTS idx_tg_smart_rules_user_active ON telegram_smart_rules(user_id,is_active,priority)`,
                `CREATE INDEX IF NOT EXISTS idx_tg_smart_results_user_detected ON telegram_smart_results(user_id,detected_at DESC)`,
                `CREATE INDEX IF NOT EXISTS idx_tg_smart_results_user_state ON telegram_smart_results(user_id,status,is_match,is_pinned,is_saved)`,
                `CREATE INDEX IF NOT EXISTS idx_tg_smart_results_chat ON telegram_smart_results(user_id,telegram_account_id,chat_id,detected_at DESC)`,
                `CREATE INDEX IF NOT EXISTS idx_tg_smart_logs_user_created ON telegram_smart_logs(user_id,created_at DESC)`,
                `CREATE INDEX IF NOT EXISTS idx_tg_smart_notifications_user_created ON telegram_smart_notifications(user_id,created_at DESC)`,
                `CREATE INDEX IF NOT EXISTS idx_tg_smart_notifications_user_unread ON telegram_smart_notifications(user_id,is_read,created_at DESC)`,
            ];
            for (const idx of smartIndexes) await query(idx).catch(() => {});

            // ── مركز كلمات تيليجرام ─────────────────────────────────────
            await query(`
                CREATE TABLE IF NOT EXISTS telegram_keywords (
                    id UUID PRIMARY KEY DEFAULT gen_random_uuid(), user_id UUID NOT NULL,
                    keyword TEXT NOT NULL, match_mode VARCHAR(30) NOT NULL DEFAULT 'contains',
                    case_sensitive BOOLEAN NOT NULL DEFAULT false, normalize_arabic BOOLEAN NOT NULL DEFAULT true,
                    search_groups BOOLEAN NOT NULL DEFAULT true, search_channels BOOLEAN NOT NULL DEFAULT true,
                    account_ids JSONB NOT NULL DEFAULT '[]', is_active BOOLEAN NOT NULL DEFAULT true,
                    created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW()
                )
            `);
            // جميع كلمات Telegram عامة؛ إزالة أي قوائم حسابات قديمة أو محددة.
            await query(`UPDATE telegram_keywords SET account_ids='[]'::jsonb, updated_at=NOW() WHERE account_ids IS DISTINCT FROM '[]'::jsonb`).catch(() => {});
            await query(`
                CREATE TABLE IF NOT EXISTS telegram_keyword_results (
                    id UUID PRIMARY KEY DEFAULT gen_random_uuid(), user_id UUID NOT NULL,
                    keyword_id UUID NOT NULL REFERENCES telegram_keywords(id) ON DELETE CASCADE,
                    telegram_account_id UUID NOT NULL REFERENCES telegram_accounts(id) ON DELETE CASCADE,
                    chat_id TEXT NOT NULL, message_id TEXT NOT NULL, sender_id TEXT,
                    sender_access_hash TEXT, sender_first_name TEXT, sender_last_name TEXT, sender_peer_type VARCHAR(30),
                    sender_username TEXT, sender_name TEXT, sender_phone TEXT, message_text TEXT NOT NULL,
                    chat_title TEXT, chat_username TEXT, chat_type VARCHAR(30), message_timestamp TIMESTAMPTZ,
                    detected_at TIMESTAMPTZ DEFAULT NOW(), reply_status VARCHAR(30) DEFAULT 'available',
                    replied_at TIMESTAMPTZ, reply_error TEXT, ignored BOOLEAN DEFAULT false,
                    deleted_in_telegram BOOLEAN NOT NULL DEFAULT false, deleted_at TIMESTAMPTZ,
                    UNIQUE(telegram_account_id, chat_id, message_id, keyword_id)
                )
            `);
            await query(`ALTER TABLE telegram_keyword_results ADD COLUMN IF NOT EXISTS chat_username TEXT`).catch(() => {});
            await query(`ALTER TABLE telegram_keyword_results ADD COLUMN IF NOT EXISTS deleted_in_telegram BOOLEAN NOT NULL DEFAULT false`).catch(() => {});
            await query(`ALTER TABLE telegram_keyword_results ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ`).catch(() => {});
            await query(`CREATE INDEX IF NOT EXISTS idx_tg_results_deleted ON telegram_keyword_results(user_id,deleted_in_telegram,deleted_at DESC)`).catch(() => {});
            await query(`
                CREATE TABLE IF NOT EXISTS telegram_keyword_events (
                    id BIGSERIAL PRIMARY KEY, user_id UUID NOT NULL, telegram_account_id UUID,
                    event_type VARCHAR(40) NOT NULL, result_id UUID, payload JSONB DEFAULT '{}',
                    created_at TIMESTAMPTZ DEFAULT NOW()
                )
            `);
            const keywordIndexes = [
                `CREATE INDEX IF NOT EXISTS idx_tg_keywords_user_active ON telegram_keywords(user_id,is_active)`,
                `CREATE INDEX IF NOT EXISTS idx_tg_results_user_detected ON telegram_keyword_results(user_id,detected_at DESC)`,
                `CREATE INDEX IF NOT EXISTS idx_tg_results_account_chat ON telegram_keyword_results(telegram_account_id,chat_id,message_timestamp DESC)`,
                `CREATE INDEX IF NOT EXISTS idx_tg_results_message ON telegram_keyword_results(message_id)`,
                `CREATE INDEX IF NOT EXISTS idx_tg_events_user_created ON telegram_keyword_events(user_id,created_at DESC)`,
            ];
            for (const idx of keywordIndexes) await query(idx).catch(() => {});

            // ── تنظيف ومنع تكرار حسابات Telegram ─────────────────────────
            // احتفظ بالحساب الأحدث عند وجود تكرارات قديمة، ثم أضف قيوداً جزئية
            // تسمح بالحسابات القديمة التي لا تحتوي على معرف Telegram بعد.
            await query(`
                WITH ranked AS (
                    SELECT id, ROW_NUMBER() OVER (
                        PARTITION BY user_id, telegram_user_id
                        ORDER BY last_connected_at DESC NULLS LAST, created_at DESC NULLS LAST, id DESC
                    ) AS rn
                    FROM telegram_accounts
                    WHERE user_id IS NOT NULL AND telegram_user_id IS NOT NULL AND telegram_user_id <> ''
                )
                DELETE FROM telegram_accounts a USING ranked r
                WHERE a.id = r.id AND r.rn > 1
            `).catch(() => {});
            await query(`
                WITH ranked AS (
                    SELECT id, ROW_NUMBER() OVER (
                        PARTITION BY user_id, phone_number
                        ORDER BY last_connected_at DESC NULLS LAST, created_at DESC NULLS LAST, id DESC
                    ) AS rn
                    FROM telegram_accounts
                    WHERE user_id IS NOT NULL AND phone_number IS NOT NULL AND phone_number <> ''
                )
                DELETE FROM telegram_accounts a USING ranked r
                WHERE a.id = r.id AND r.rn > 1
            `).catch(() => {});
            await query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_tg_accounts_user_telegram_unique ON telegram_accounts(user_id,telegram_user_id) WHERE user_id IS NOT NULL AND telegram_user_id IS NOT NULL AND telegram_user_id <> ''`).catch(() => {});
            await query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_tg_accounts_user_phone_unique ON telegram_accounts(user_id,phone_number) WHERE user_id IS NOT NULL AND phone_number IS NOT NULL AND phone_number <> ''`).catch(() => {});

            // ── أتمتة روابط تيليجرام: فصل الحسابات والروابط والعمليات ────────
            await query(`ALTER TABLE telegram_accounts ADD COLUMN IF NOT EXISTS automation_role VARCHAR(20) NOT NULL DEFAULT 'SEARCH_ROLE'`).catch(() => {});
            await query(`ALTER TABLE telegram_accounts ADD COLUMN IF NOT EXISTS automation_enabled BOOLEAN NOT NULL DEFAULT TRUE`).catch(() => {});
            await query(`ALTER TABLE telegram_accounts ADD COLUMN IF NOT EXISTS operation_count INTEGER NOT NULL DEFAULT 0`).catch(() => {});
            await query(`ALTER TABLE telegram_accounts ADD COLUMN IF NOT EXISTS error_count INTEGER NOT NULL DEFAULT 0`).catch(() => {});
            await query(`ALTER TABLE telegram_accounts ADD COLUMN IF NOT EXISTS last_error TEXT`).catch(() => {});
            await query(`ALTER TABLE telegram_accounts ADD COLUMN IF NOT EXISTS stopped_at TIMESTAMPTZ`).catch(() => {});
            await query(`ALTER TABLE telegram_accounts ADD COLUMN IF NOT EXISTS stop_reason TEXT`).catch(() => {});
            await query(`ALTER TABLE telegram_accounts ADD COLUMN IF NOT EXISTS last_operation_at TIMESTAMPTZ`).catch(() => {});
            await query(`ALTER TABLE telegram_accounts ADD COLUMN IF NOT EXISTS last_heartbeat_at TIMESTAMPTZ`).catch(() => {});
            await query(`ALTER TABLE telegram_accounts ADD COLUMN IF NOT EXISTS worker_id TEXT`).catch(() => {});
            await query(`ALTER TABLE telegram_accounts ADD COLUMN IF NOT EXISTS worker_state VARCHAR(30) NOT NULL DEFAULT 'DISCONNECTED'`).catch(() => {});
            await query(`ALTER TABLE telegram_accounts ADD COLUMN IF NOT EXISTS connection_state VARCHAR(30) NOT NULL DEFAULT 'DISCONNECTED'`).catch(() => {});
            await query(`ALTER TABLE telegram_accounts ADD COLUMN IF NOT EXISTS last_success_at TIMESTAMPTZ`).catch(() => {});
            await query(`ALTER TABLE telegram_accounts ADD COLUMN IF NOT EXISTS next_allowed_operation_at TIMESTAMPTZ`).catch(() => {});
            await query(`ALTER TABLE telegram_accounts ADD COLUMN IF NOT EXISTS role_transition_version BIGINT NOT NULL DEFAULT 0`).catch(() => {});
            await query(`CREATE INDEX IF NOT EXISTS idx_tg_accounts_automation_role ON telegram_accounts(user_id,automation_role,automation_enabled)`).catch(() => {});
            await query(`CREATE INDEX IF NOT EXISTS idx_tg_accounts_health ON telegram_accounts(user_id,worker_state,connection_state,last_heartbeat_at DESC)`).catch(() => {});

            await query(`
                CREATE TABLE IF NOT EXISTS telegram_automation_links (
                    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                    user_id UUID NOT NULL,
                    normalized_url TEXT NOT NULL,
                    original_url TEXT NOT NULL,
                    telegram_identifier TEXT,
                    link_type VARCHAR(20) NOT NULL,
                    source_account_id UUID NOT NULL REFERENCES telegram_accounts(id) ON DELETE RESTRICT,
                    source_chat_id TEXT,
                    source_message_id TEXT,
                    source_history JSONB NOT NULL DEFAULT '[]'::jsonb,
                    first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                    last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                    status VARCHAR(30) NOT NULL DEFAULT 'NEW',
                    join_status VARCHAR(30) NOT NULL DEFAULT 'PENDING',
                    joined_by_accounts JSONB NOT NULL DEFAULT '[]'::jsonb,
                    last_error TEXT,
                    archived BOOLEAN NOT NULL DEFAULT FALSE,
                    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                    UNIQUE(user_id, normalized_url)
                )
            `);
            // File imports do not have a Telegram discovery account. Keep the foreign key for real discovery sources, but allow direct file imports.
            await query(`ALTER TABLE telegram_automation_links ALTER COLUMN source_account_id DROP NOT NULL`).catch(() => {});
            await query(`CREATE INDEX IF NOT EXISTS idx_tg_auto_links_status ON telegram_automation_links(user_id,status,join_status,archived)`).catch(() => {});
            await query(`CREATE INDEX IF NOT EXISTS idx_tg_auto_links_seen ON telegram_automation_links(user_id,last_seen_at DESC)`).catch(() => {});

            // ── Global Telegram Join Registry ────────────────────────────────
            // مصدر الحقيقة المشترك بين كل المستخدمين والحسابات والـWorkers.
            await query(`
                CREATE TABLE IF NOT EXISTS telegram_global_join_links (
                    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                    original_url TEXT NOT NULL,
                    normalized_url TEXT NOT NULL UNIQUE,
                    url_hash CHAR(64) NOT NULL UNIQUE,
                    telegram_identifier TEXT,
                    telegram_chat_id TEXT,
                    telegram_username TEXT,
                    link_type VARCHAR(20) NOT NULL,
                    status VARCHAR(30) NOT NULL DEFAULT 'PENDING',
                    reserved_by_account_id UUID,
                    reserved_operation_id UUID,
                    joined_by_account_id UUID,
                    joined_by_operation_id UUID,
                    joined_at TIMESTAMPTZ,
                    last_checked_at TIMESTAMPTZ,
                    last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                    last_error_code TEXT,
                    last_error TEXT,
                    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
                )
            `);
            await query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_tg_global_chat_id ON telegram_global_join_links(telegram_chat_id) WHERE telegram_chat_id IS NOT NULL`).catch(() => {});
            await query(`CREATE INDEX IF NOT EXISTS idx_tg_global_status ON telegram_global_join_links(status,updated_at DESC)`).catch(() => {});
            await query(`CREATE INDEX IF NOT EXISTS idx_tg_global_joined ON telegram_global_join_links(joined_at DESC) WHERE status IN ('JOINED','ALREADY_MEMBER')`).catch(() => {});
            await query(`
                CREATE TABLE IF NOT EXISTS telegram_global_join_audit (
                    id BIGSERIAL PRIMARY KEY,
                    user_id UUID,
                    account_id UUID,
                    operation_id UUID,
                    original_url TEXT,
                    normalized_url TEXT NOT NULL,
                    url_hash CHAR(64) NOT NULL,
                    telegram_chat_id TEXT,
                    action VARCHAR(40) NOT NULL,
                    previous_status VARCHAR(30),
                    new_status VARCHAR(30),
                    reason TEXT,
                    existing_account_id UUID,
                    existing_joined_at TIMESTAMPTZ,
                    worker_id TEXT,
                    task_id TEXT,
                    error_code TEXT,
                    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
                )
            `);
            await query(`CREATE INDEX IF NOT EXISTS idx_tg_global_audit_url ON telegram_global_join_audit(normalized_url,created_at DESC)`).catch(() => {});
            await query(`CREATE INDEX IF NOT EXISTS idx_tg_global_audit_action ON telegram_global_join_audit(action,created_at DESC)`).catch(() => {});
            await query(`
                INSERT INTO telegram_global_join_links(original_url,normalized_url,url_hash,telegram_identifier,link_type,status,joined_by_account_id,joined_at,last_seen_at)
                SELECT DISTINCT ON (l.normalized_url) l.original_url,l.normalized_url,lpad(md5(l.normalized_url),64,'0'),l.telegram_identifier,l.link_type,'JOINED',NULL,NULL,l.last_seen_at
                FROM telegram_automation_links l
                WHERE l.join_status='JOINED' OR l.status='SUCCESS'
                ORDER BY l.normalized_url,l.last_seen_at DESC
                ON CONFLICT(normalized_url) DO NOTHING
            `).catch(() => {});

            await query(`
                CREATE TABLE IF NOT EXISTS telegram_join_operations (
                    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                    user_id UUID NOT NULL,
                    link_id UUID NOT NULL REFERENCES telegram_automation_links(id) ON DELETE RESTRICT,
                    account_id UUID NOT NULL REFERENCES telegram_accounts(id) ON DELETE RESTRICT,
                    job_id UUID,
                    idempotency_key TEXT NOT NULL UNIQUE,
                    status VARCHAR(30) NOT NULL DEFAULT 'QUEUED',
                    result_code VARCHAR(40),
                    error_code VARCHAR(80),
                    error_message TEXT,
                    attempt_count INTEGER NOT NULL DEFAULT 0,
                    scheduled_at TIMESTAMPTZ,
                    last_attempt_at TIMESTAMPTZ,
                    joined_at TIMESTAMPTZ,
                    duration_ms INTEGER,
                    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                    UNIQUE(user_id, link_id, account_id)
                )
            `);
            // Allow a new run after FAILED/SKIPPED, while preventing duplicate active or successful relations.
            // The original table-level UNIQUE constraint blocked every future retry permanently.
            await query(`ALTER TABLE telegram_join_operations DROP CONSTRAINT IF EXISTS telegram_join_operations_user_id_link_id_account_id_key`).catch(() => {});
            await query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_tg_join_ops_relation_active ON telegram_join_operations(user_id,link_id,account_id) WHERE status IN ('QUEUED','PROCESSING','RETRY','SUCCESS')`).catch(() => {});
            await query(`CREATE INDEX IF NOT EXISTS idx_tg_join_ops_queue ON telegram_join_operations(status,scheduled_at)`).catch(() => {});
            await query(`CREATE INDEX IF NOT EXISTS idx_tg_join_ops_account ON telegram_join_operations(user_id,account_id,created_at DESC)`).catch(() => {});
            await query(`ALTER TABLE telegram_join_operations ADD COLUMN IF NOT EXISTS lease_expires_at TIMESTAMPTZ`).catch(() => {});
            await query(`ALTER TABLE telegram_join_operations ADD COLUMN IF NOT EXISTS heartbeat_at TIMESTAMPTZ`).catch(() => {});
            await query(`ALTER TABLE telegram_join_operations ADD COLUMN IF NOT EXISTS worker_id TEXT`).catch(() => {});
            await query(`ALTER TABLE telegram_join_operations ADD COLUMN IF NOT EXISTS processing_started_at TIMESTAMPTZ`).catch(() => {});
            await query(`ALTER TABLE telegram_join_operations ADD COLUMN IF NOT EXISTS recovery_count INTEGER NOT NULL DEFAULT 0`).catch(() => {});
            await query(`ALTER TABLE telegram_join_operations ADD COLUMN IF NOT EXISTS queue_job_id TEXT`).catch(() => {});
            await query(`ALTER TABLE telegram_join_operations ADD COLUMN IF NOT EXISTS membership_state VARCHAR(30)`).catch(() => {});
            await query(`ALTER TABLE telegram_join_operations ADD COLUMN IF NOT EXISTS verification_evidence JSONB`).catch(() => {});
            await query(`CREATE INDEX IF NOT EXISTS idx_tg_join_ops_lease ON telegram_join_operations(status,lease_expires_at)`).catch(() => {});
            await query(`CREATE INDEX IF NOT EXISTS idx_tg_join_ops_ready ON telegram_join_operations(status,scheduled_at,created_at)`).catch(() => {});

            // ── مراجعة العضويات المكررة بين حسابات JOIN_ROLE ───────────────
            await query(`
                CREATE TABLE IF NOT EXISTS telegram_membership_reviews (
                    id UUID PRIMARY KEY DEFAULT gen_random_uuid(), user_id UUID NOT NULL,
                    status VARCHAR(20) NOT NULL DEFAULT 'RUNNING', keep_account_id UUID,
                    summary JSONB NOT NULL DEFAULT '{}'::jsonb, worker_id TEXT,
                    started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), completed_at TIMESTAMPTZ
                )
            `);
            await query(`CREATE INDEX IF NOT EXISTS idx_tg_membership_reviews_user ON telegram_membership_reviews(user_id,started_at DESC)`).catch(() => {});
            await query(`
                CREATE TABLE IF NOT EXISTS telegram_membership_review_audit (
                    id BIGSERIAL PRIMARY KEY, review_id UUID, user_id UUID NOT NULL,
                    account_id UUID, group_id TEXT, action VARCHAR(30) NOT NULL,
                    status VARCHAR(30) NOT NULL, reason TEXT, details JSONB NOT NULL DEFAULT '{}'::jsonb,
                    worker_id TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
                )
            `);
            await query(`CREATE INDEX IF NOT EXISTS idx_tg_membership_review_audit_review ON telegram_membership_review_audit(review_id,created_at DESC)`).catch(() => {});
            await query(`CREATE INDEX IF NOT EXISTS idx_tg_membership_review_audit_group ON telegram_membership_review_audit(group_id,created_at DESC)`).catch(() => {});

            await query(`
                CREATE TABLE IF NOT EXISTS telegram_automation_jobs (
                    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                    user_id UUID NOT NULL,
                    job_type VARCHAR(20) NOT NULL,
                    status VARCHAR(30) NOT NULL DEFAULT 'QUEUED',
                    requested_account_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
                    requested_link_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
                    total_count INTEGER NOT NULL DEFAULT 0,
                    processed_count INTEGER NOT NULL DEFAULT 0,
                    success_count INTEGER NOT NULL DEFAULT 0,
                    failed_count INTEGER NOT NULL DEFAULT 0,
                    skipped_count INTEGER NOT NULL DEFAULT 0,
                    settings JSONB NOT NULL DEFAULT '{}'::jsonb,
                    error_message TEXT,
                    started_at TIMESTAMPTZ,
                    completed_at TIMESTAMPTZ,
                    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
                )
            `);
            await query(`CREATE INDEX IF NOT EXISTS idx_tg_auto_jobs_user ON telegram_automation_jobs(user_id,created_at DESC)`).catch(() => {});
            await query(`ALTER TABLE telegram_automation_jobs ADD COLUMN IF NOT EXISTS request_id TEXT`).catch(() => {});
            await query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_tg_auto_jobs_request ON telegram_automation_jobs(user_id,request_id) WHERE request_id IS NOT NULL`).catch(() => {});

            // ── تفضيلات أتمتة الانضمام المحفوظة لكل مستخدم ────────────────
            await query(`
                CREATE TABLE IF NOT EXISTS telegram_join_automation_settings (
                    user_id UUID PRIMARY KEY,
                    min_delay_seconds INTEGER NOT NULL DEFAULT 120,
                    max_delay_seconds INTEGER NOT NULL DEFAULT 150,
                    max_retries INTEGER NOT NULL DEFAULT 1,
                    retry_backoff_seconds INTEGER NOT NULL DEFAULT 60,
                    strategy VARCHAR(20) NOT NULL DEFAULT 'smart',
                    selected_search_account_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
                    selected_account_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
                    selected_link_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
                    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                    CONSTRAINT tg_join_settings_delay_check CHECK (min_delay_seconds >= 30 AND max_delay_seconds >= min_delay_seconds),
                    CONSTRAINT tg_join_settings_retry_check CHECK (max_retries BETWEEN 0 AND 2),
                    CONSTRAINT tg_join_settings_strategy_check CHECK (strategy IN ('least_loaded','smart','round_robin'))
                )
            `);
            await query(`ALTER TABLE telegram_join_automation_settings ADD COLUMN IF NOT EXISTS selected_search_account_ids JSONB NOT NULL DEFAULT '[]'::jsonb`).catch(() => {});
            await query(`CREATE INDEX IF NOT EXISTS idx_tg_join_settings_updated ON telegram_join_automation_settings(updated_at DESC)`).catch(() => {});

            await query(`
                CREATE TABLE IF NOT EXISTS telegram_automation_events (
                    id BIGSERIAL PRIMARY KEY,
                    user_id UUID NOT NULL,
                    job_id UUID,
                    operation_id UUID,
                    account_id UUID,
                    link_id UUID,
                    event_type VARCHAR(40) NOT NULL,
                    status VARCHAR(30),
                    payload JSONB NOT NULL DEFAULT '{}'::jsonb,
                    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
                )
            `);
            await query(`CREATE INDEX IF NOT EXISTS idx_tg_auto_events_user ON telegram_automation_events(user_id,created_at DESC)`).catch(() => {});

            // Durable outbox: DB commit is the source of truth; a dispatcher may
            // publish to BullMQ after commit and safely retry when Redis is down.
            await query(`
                CREATE TABLE IF NOT EXISTS telegram_automation_outbox (
                    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                    aggregate_type VARCHAR(40) NOT NULL,
                    aggregate_id UUID NOT NULL,
                    event_type VARCHAR(60) NOT NULL,
                    payload JSONB NOT NULL DEFAULT '{}'::jsonb,
                    status VARCHAR(20) NOT NULL DEFAULT 'PENDING',
                    attempt_count INTEGER NOT NULL DEFAULT 0,
                    available_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                    processed_at TIMESTAMPTZ,
                    last_error TEXT,
                    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                    UNIQUE(aggregate_type,aggregate_id,event_type)
                )
            `);
            await query(`CREATE INDEX IF NOT EXISTS idx_tg_outbox_ready ON telegram_automation_outbox(status,available_at,created_at)`).catch(() => {});

            // Durable historical discovery jobs. The HTTP request only creates a
            // row; the discovery worker resumes from cursor after a crash.
            await query(`
                CREATE TABLE IF NOT EXISTS telegram_discovery_jobs (
                    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                    user_id UUID NOT NULL,
                    account_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
                    status VARCHAR(30) NOT NULL DEFAULT 'QUEUED',
                    progress NUMERIC(5,2) NOT NULL DEFAULT 0,
                    total_accounts INTEGER NOT NULL DEFAULT 0,
                    processed_accounts INTEGER NOT NULL DEFAULT 0,
                    total_dialogs INTEGER NOT NULL DEFAULT 0,
                    processed_dialogs INTEGER NOT NULL DEFAULT 0,
                    links_found INTEGER NOT NULL DEFAULT 0,
                    links_saved INTEGER NOT NULL DEFAULT 0,
                    duplicates INTEGER NOT NULL DEFAULT 0,
                    cursor JSONB NOT NULL DEFAULT '{}'::jsonb,
                    error TEXT,
                    queue_job_id TEXT,
                    worker_id TEXT,
                    lease_expires_at TIMESTAMPTZ,
                    heartbeat_at TIMESTAMPTZ,
                    started_at TIMESTAMPTZ,
                    completed_at TIMESTAMPTZ,
                    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
                )
            `);
            await query(`ALTER TABLE telegram_discovery_jobs ADD COLUMN IF NOT EXISTS request_id TEXT`).catch(() => {});
            await query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_tg_discovery_request ON telegram_discovery_jobs(user_id,request_id) WHERE request_id IS NOT NULL`).catch(() => {});
            await query(`CREATE INDEX IF NOT EXISTS idx_tg_discovery_user ON telegram_discovery_jobs(user_id,created_at DESC)`).catch(() => {});
            await query(`CREATE INDEX IF NOT EXISTS idx_tg_discovery_ready ON telegram_discovery_jobs(status,lease_expires_at,created_at)`).catch(() => {});

            await query(`
                CREATE TABLE IF NOT EXISTS telegram_automation_audit_logs (
                    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                    actor_id UUID,
                    user_id UUID,
                    action VARCHAR(60) NOT NULL,
                    entity_type VARCHAR(40) NOT NULL,
                    entity_id UUID,
                    before_state JSONB NOT NULL DEFAULT '{}'::jsonb,
                    after_state JSONB NOT NULL DEFAULT '{}'::jsonb,
                    ip INET,
                    user_agent TEXT,
                    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
                )
            `);
            await query(`CREATE INDEX IF NOT EXISTS idx_tg_audit_user_created ON telegram_automation_audit_logs(user_id,created_at DESC)`).catch(() => {});

            await query(`
                CREATE TABLE IF NOT EXISTS telegram_automation_notifications (
                    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                    user_id UUID NOT NULL,
                    notification_type VARCHAR(50) NOT NULL,
                    title TEXT NOT NULL,
                    body TEXT NOT NULL,
                    entity_type VARCHAR(40),
                    entity_id UUID,
                    is_read BOOLEAN NOT NULL DEFAULT FALSE,
                    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                    read_at TIMESTAMPTZ
                )
            `);
            await query(`CREATE INDEX IF NOT EXISTS idx_tg_notifications_user ON telegram_automation_notifications(user_id,is_read,created_at DESC)`).catch(() => {});

            await query(`
                CREATE TABLE IF NOT EXISTS telegram_automation_idempotency (
                    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                    user_id UUID NOT NULL,
                    action VARCHAR(50) NOT NULL,
                    idempotency_key TEXT NOT NULL,
                    status VARCHAR(20) NOT NULL DEFAULT 'PROCESSING',
                    response_json JSONB,
                    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                    completed_at TIMESTAMPTZ,
                    UNIQUE(user_id,action,idempotency_key)
                )
            `);
            await query(`CREATE INDEX IF NOT EXISTS idx_tg_idempotency_created ON telegram_automation_idempotency(user_id,created_at DESC)`).catch(() => {});

            // ── Indexes للأداء ────────────────────────────────────────────
            const indexes = [
                `CREATE INDEX IF NOT EXISTS idx_whatsapp_links_status ON whatsapp_links(status)`,
                `CREATE INDEX IF NOT EXISTS idx_whatsapp_links_discovered ON whatsapp_links(discovered_at DESC)`,
                `CREATE INDEX IF NOT EXISTS idx_whatsapp_links_account ON whatsapp_links(source_account_id)`,
                `CREATE INDEX IF NOT EXISTS idx_whatsapp_links_deleted ON whatsapp_links(deleted)`,
                `CREATE INDEX IF NOT EXISTS idx_telegram_accounts_user ON telegram_accounts(user_id)`,
                `CREATE INDEX IF NOT EXISTS idx_telegram_accounts_status ON telegram_accounts(status)`,
            ];
            for (const idx of indexes) {
                await query(idx).catch(() => {});
            }

            console.log('[TelegramMigrations] Tables ready');
        } catch (err) {
            if (!err.message?.includes('already exists')) {
                console.error('[TelegramMigrations] Error:', err.message);
            }
        }
    }
};

module.exports = TelegramMigrations;
