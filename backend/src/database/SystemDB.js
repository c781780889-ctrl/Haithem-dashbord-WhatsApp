'use strict';
/**
 * SystemDB — إدارة مخطط قاعدة البيانات الرئيسية (النظام)
 * ─────────────────────────────────────────────────────────────────────
 * [DB-UNIFY] توحيد طبقة قاعدة البيانات:
 *  - SystemDB لم يعد يُنشئ pool مستقلًا من `pg` مباشرة.
 *  - كل الاستعلامات تمر عبر الـ pool المركزي الوحيد في `src/lib/postgres.js`
 *    (يضمن إعدادات موحّدة: keepAlive، reconnect، DB_POOL_MAX).
 */
const { getPool, closeAll: closePgPool } = require('../lib/postgres');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');

const SystemDB = {
    async init() {
        const p = getPool();

        // Remove database objects belonging exclusively to features removed from the application.
        await p.query(`CREATE TABLE IF NOT EXISTS system_migrations (version INT PRIMARY KEY, name TEXT NOT NULL, applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
        await p.query(`
            CREATE TABLE IF NOT EXISTS postgres_storage_alert_state (
                state_id TEXT PRIMARY KEY,
                alert_active BOOLEAN NOT NULL DEFAULT FALSE,
                last_usage_percent NUMERIC(7, 3),
                last_used_bytes BIGINT,
                last_alert_at TIMESTAMPTZ,
                updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
        `);
        await p.query(`
            ALTER TABLE postgres_storage_alert_state ADD COLUMN IF NOT EXISTS current_level TEXT NOT NULL DEFAULT 'normal';
            ALTER TABLE postgres_storage_alert_state ADD COLUMN IF NOT EXISTS current_status TEXT NOT NULL DEFAULT 'healthy';
            ALTER TABLE postgres_storage_alert_state ADD COLUMN IF NOT EXISTS last_snapshot JSONB;
            CREATE TABLE IF NOT EXISTS postgres_storage_snapshots (
                id BIGSERIAL PRIMARY KEY,
                usage_percent NUMERIC(7, 3) NOT NULL,
                used_bytes BIGINT NOT NULL,
                limit_bytes BIGINT NOT NULL,
                level TEXT NOT NULL,
                dominant_source TEXT,
                details JSONB NOT NULL DEFAULT '{}',
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            );
            CREATE INDEX IF NOT EXISTS postgres_storage_snapshots_created_at_idx ON postgres_storage_snapshots (created_at DESC);
            CREATE TABLE IF NOT EXISTS postgres_storage_audit_logs (
                id BIGSERIAL PRIMARY KEY,
                event_type TEXT NOT NULL,
                severity TEXT NOT NULL,
                action TEXT NOT NULL,
                result TEXT NOT NULL,
                details JSONB NOT NULL DEFAULT '{}',
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            );
            CREATE INDEX IF NOT EXISTS postgres_storage_audit_logs_created_at_idx ON postgres_storage_audit_logs (created_at DESC);
            INSERT INTO postgres_storage_alert_state (state_id)
            VALUES ('postgres-storage')
            ON CONFLICT (state_id) DO NOTHING;
        `);
        const removedFeatureTables = await p.query(`SELECT 1 FROM system_migrations WHERE version = 5 LIMIT 1`);
        if (!removedFeatureTables.rowCount) {
            await p.query(`
                DROP TABLE IF EXISTS group_number_activity CASCADE;
                DROP TABLE IF EXISTS group_number_sources CASCADE;
                DROP TABLE IF EXISTS group_numbers CASCADE;
                DROP TABLE IF EXISTS group_number_jobs CASCADE;
                INSERT INTO system_migrations (version, name) VALUES (5, 'remove_deleted_feature_tables')
                ON CONFLICT (version) DO NOTHING;
            `);
        }

        // ── الجداول الأساسية أولاً (بدون foreign keys) ──────────────────────
        await p.query(`
            CREATE TABLE IF NOT EXISTS users (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                username VARCHAR(100) UNIQUE NOT NULL,
                password TEXT NOT NULL,
                full_name VARCHAR(200),
                email VARCHAR(200),
                role VARCHAR(50) DEFAULT 'user',
                status VARCHAR(50) DEFAULT 'active',
                mfa_enabled BOOLEAN DEFAULT FALSE,
                mfa_secret TEXT,
                failed_login_count INT DEFAULT 0,
                last_failed_login TIMESTAMPTZ,
                locked_until TIMESTAMPTZ,
                last_login TIMESTAMPTZ,
                created_at TIMESTAMPTZ DEFAULT NOW(),
                updated_at TIMESTAMPTZ DEFAULT NOW()
            )
        `);

        // توافق مع قواعد البيانات التي أُنشئت بإصدارات قديمة؛ CREATE TABLE IF NOT EXISTS
        // لا يضيف الأعمدة الجديدة إلى جدول موجود، وغيابها يحوّل login/verify إلى 500.
        for (const statement of [
            `ALTER TABLE users ADD COLUMN IF NOT EXISTS full_name VARCHAR(200)`,
            `ALTER TABLE users ADD COLUMN IF NOT EXISTS email VARCHAR(200)`,
            `ALTER TABLE users ADD COLUMN IF NOT EXISTS role VARCHAR(50) DEFAULT 'user'`,
            `ALTER TABLE users ADD COLUMN IF NOT EXISTS status VARCHAR(50) DEFAULT 'active'`,
            `ALTER TABLE users ADD COLUMN IF NOT EXISTS mfa_enabled BOOLEAN DEFAULT FALSE`,
            `ALTER TABLE users ADD COLUMN IF NOT EXISTS mfa_secret TEXT`,
            `ALTER TABLE users ADD COLUMN IF NOT EXISTS failed_login_count INT DEFAULT 0`,
            `ALTER TABLE users ADD COLUMN IF NOT EXISTS last_failed_login TIMESTAMPTZ`,
            `ALTER TABLE users ADD COLUMN IF NOT EXISTS locked_until TIMESTAMPTZ`,
            `ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login TIMESTAMPTZ`,
            `ALTER TABLE users ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW()`,
            `ALTER TABLE users ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW()`
        ]) await p.query(statement).catch(() => {});

        await p.query(`
            CREATE TABLE IF NOT EXISTS accounts (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                user_id UUID,
                name VARCHAR(200) NOT NULL,
                phone_number VARCHAR(50),
                status VARCHAR(50) DEFAULT 'disconnected',
                health_status VARCHAR(50) DEFAULT 'unknown',
                role VARCHAR(50) DEFAULT 'stopped',
                task_status VARCHAR(50) DEFAULT 'idle',
                connection_type VARCHAR(50) DEFAULT 'baileys',
                messages_sent_today INT DEFAULT 0,
                last_activity_at TIMESTAMPTZ,
                created_at TIMESTAMPTZ DEFAULT NOW(),
                updated_at TIMESTAMPTZ DEFAULT NOW()
            )
        `);

        // ── الجداول التي تعتمد على users ────────────────────────────────────
        await p.query(`
            CREATE TABLE IF NOT EXISTS subscriptions (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                user_id UUID UNIQUE NOT NULL,
                plan_type VARCHAR(100) NOT NULL,
                status VARCHAR(50) DEFAULT 'active',
                max_accounts INT DEFAULT 1,
                expires_at TIMESTAMPTZ,
                notes TEXT,
                created_at TIMESTAMPTZ DEFAULT NOW(),
                updated_at TIMESTAMPTZ DEFAULT NOW()
            )
        `);

        await p.query(`
            CREATE TABLE IF NOT EXISTS subscription_renewals (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                subscription_id UUID,
                plan_type VARCHAR(100),
                extended_hours INT,
                note TEXT,
                created_at TIMESTAMPTZ DEFAULT NOW()
            )
        `);

        await p.query(`
            CREATE TABLE IF NOT EXISTS licenses (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                user_id UUID,
                license_key VARCHAR(100) UNIQUE NOT NULL,
                status VARCHAR(50) DEFAULT 'active',
                plan_type VARCHAR(100),
                issued_by UUID,
                expires_at TIMESTAMPTZ,
                created_at TIMESTAMPTZ DEFAULT NOW(),
                updated_at TIMESTAMPTZ DEFAULT NOW()
            )
        `);

        await p.query(`
            CREATE TABLE IF NOT EXISTS activity_logs (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                user_id UUID,
                username VARCHAR(100),
                action VARCHAR(100),
                details TEXT,
                ip_address VARCHAR(100),
                created_at TIMESTAMPTZ DEFAULT NOW()
            )
        `);

        await p.query(`
            CREATE TABLE IF NOT EXISTS login_attempts (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                username VARCHAR(100),
                ip_address VARCHAR(100),
                success BOOLEAN DEFAULT FALSE,
                created_at TIMESTAMPTZ DEFAULT NOW()
            )
        `);

        await p.query(`
            CREATE TABLE IF NOT EXISTS jwt_families (
                family_id VARCHAR(200) PRIMARY KEY,
                user_id UUID,
                revoked BOOLEAN DEFAULT FALSE,
                created_at TIMESTAMPTZ DEFAULT NOW()
            )
        `);

        await p.query(`
            CREATE TABLE IF NOT EXISTS refresh_tokens (
                token_hash VARCHAR(500) PRIMARY KEY,
                family_id VARCHAR(200),
                user_id UUID,
                used BOOLEAN DEFAULT FALSE,
                expires_at TIMESTAMPTZ,
                created_at TIMESTAMPTZ DEFAULT NOW()
            )
        `);

        await p.query(`
            CREATE TABLE IF NOT EXISTS session_data (
                account_id UUID,
                key TEXT NOT NULL,
                value TEXT,
                updated_at TIMESTAMPTZ DEFAULT NOW(),
                PRIMARY KEY (account_id, key)
            )
        `);


        // ── Keyword Monitoring Tables ─────────────────────────────────────
        await p.query(`
            CREATE TABLE IF NOT EXISTS kw_keywords (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                user_id UUID NOT NULL,
                word TEXT NOT NULL,
                category TEXT DEFAULT 'عام',
                priority VARCHAR(20) DEFAULT 'normal',
                color VARCHAR(20) DEFAULT '#00A884',
                case_sensitive BOOLEAN DEFAULT FALSE,
                is_active BOOLEAN DEFAULT TRUE,
                match_count INT DEFAULT 0,
                created_at TIMESTAMPTZ DEFAULT NOW(),
                updated_at TIMESTAMPTZ DEFAULT NOW()
            )
        `);
        await p.query(`CREATE INDEX IF NOT EXISTS idx_kw_keywords_user ON kw_keywords(user_id)`).catch(() => {});

        await p.query(`
            CREATE TABLE IF NOT EXISTS kw_alerts (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                user_id UUID NOT NULL,
                keyword_id UUID,
                matched_keyword TEXT NOT NULL,
                message_text TEXT,
                sender_name TEXT,
                sender_phone TEXT,
                group_name TEXT,
                group_jid TEXT,
                account_id UUID,
                message_time TIMESTAMPTZ DEFAULT NOW(),
                status VARCHAR(30) DEFAULT 'new',
                internal_note TEXT,
                created_at TIMESTAMPTZ DEFAULT NOW(),
                updated_at TIMESTAMPTZ DEFAULT NOW()
            )
        `);
        await p.query(`CREATE INDEX IF NOT EXISTS idx_kw_alerts_user ON kw_alerts(user_id, message_time DESC)`).catch(() => {});
        await p.query(`CREATE INDEX IF NOT EXISTS idx_kw_alerts_status ON kw_alerts(user_id, status)`).catch(() => {});
        await p.query(`
            CREATE TABLE IF NOT EXISTS kw_ignored_messages (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                user_id UUID NOT NULL,
                account_id UUID NOT NULL,
                message_id TEXT NOT NULL,
                remote_jid TEXT,
                message_hash TEXT,
                ignored_by UUID,
                ignored_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                UNIQUE(user_id, account_id, message_id)
            )
        `);
        await p.query(`CREATE INDEX IF NOT EXISTS idx_kw_ignored_lookup ON kw_ignored_messages(user_id, account_id, message_id)`).catch(() => {});

        await p.query(`
            CREATE TABLE IF NOT EXISTS kw_settings (
                user_id UUID PRIMARY KEY,
                settings JSONB DEFAULT '{}',
                updated_at TIMESTAMPTZ DEFAULT NOW()
            )
        `);

        await p.query(`
            CREATE TABLE IF NOT EXISTS kw_activity_log (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                user_id UUID NOT NULL,
                action VARCHAR(100),
                details TEXT,
                created_at TIMESTAMPTZ DEFAULT NOW()
            )
        `);
        await p.query(`CREATE INDEX IF NOT EXISTS idx_kw_activity_user ON kw_activity_log(user_id, created_at DESC)`).catch(() => {});

        // ── Keyword Center v2: durable inbox, normalized messages, notifications, replies ──
        // These tables are additive so existing keyword data remains readable during rollout.
        await p.query(`
            CREATE TABLE IF NOT EXISTS kw_event_queue (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                user_id UUID NOT NULL,
                account_id UUID NOT NULL,
                message_id TEXT NOT NULL,
                event_type VARCHAR(40) NOT NULL DEFAULT 'message_received',
                payload JSONB NOT NULL DEFAULT '{}',
                status VARCHAR(20) NOT NULL DEFAULT 'received',
                attempts INT NOT NULL DEFAULT 0,
                available_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                locked_at TIMESTAMPTZ,
                processed_at TIMESTAMPTZ,
                last_error TEXT,
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                UNIQUE(account_id, message_id, event_type)
            )
        `);
        await p.query(`CREATE INDEX IF NOT EXISTS idx_kw_queue_ready ON kw_event_queue(status, available_at)`).catch(() => {});
        await p.query(`CREATE INDEX IF NOT EXISTS idx_kw_queue_user ON kw_event_queue(user_id, created_at DESC)`).catch(() => {});

        await p.query(`
            CREATE TABLE IF NOT EXISTS kw_messages (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                user_id UUID NOT NULL,
                account_id UUID NOT NULL,
                message_id TEXT NOT NULL,
                remote_jid TEXT,
                participant_jid TEXT,
                sender_phone TEXT,
                sender_name TEXT,
                chat_name TEXT,
                message_text TEXT,
                is_group BOOLEAN NOT NULL DEFAULT FALSE,
                message_time TIMESTAMPTZ,
                raw_payload JSONB NOT NULL DEFAULT '{}',
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                UNIQUE(account_id, message_id)
            )
        `);
        await p.query(`CREATE INDEX IF NOT EXISTS idx_kw_messages_user_time ON kw_messages(user_id, message_time DESC)`).catch(() => {});
        await p.query(`CREATE INDEX IF NOT EXISTS idx_kw_messages_sender ON kw_messages(user_id, sender_phone)`).catch(() => {});

        await p.query(`
            CREATE TABLE IF NOT EXISTS kw_notifications (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                user_id UUID NOT NULL,
                alert_id UUID,
                type VARCHAR(40) NOT NULL DEFAULT 'keyword_match',
                title TEXT NOT NULL,
                body TEXT,
                is_read BOOLEAN NOT NULL DEFAULT FALSE,
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                read_at TIMESTAMPTZ
            )
        `);
        await p.query(`CREATE INDEX IF NOT EXISTS idx_kw_notifications_user ON kw_notifications(user_id, is_read, created_at DESC)`).catch(() => {});

        await p.query(`
            CREATE TABLE IF NOT EXISTS kw_replies (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                user_id UUID NOT NULL,
                alert_id UUID NOT NULL,
                account_id UUID NOT NULL,
                recipient_jid TEXT NOT NULL,
                body TEXT NOT NULL,
                status VARCHAR(20) NOT NULL DEFAULT 'queued',
                whatsapp_message_id TEXT,
                error TEXT,
                sent_at TIMESTAMPTZ,
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
        `);
        await p.query(`CREATE INDEX IF NOT EXISTS idx_kw_replies_user ON kw_replies(user_id, created_at DESC)`).catch(() => {});

        await p.query(`
            CREATE TABLE IF NOT EXISTS kw_service_health (
                account_id UUID PRIMARY KEY,
                user_id UUID,
                status VARCHAR(30) NOT NULL DEFAULT 'starting',
                last_heartbeat TIMESTAMPTZ,
                last_event_at TIMESTAMPTZ,
                last_error TEXT,
                updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
        `);

        await p.query(`
            CREATE TABLE IF NOT EXISTS ai_agents (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(), user_id UUID NOT NULL,
                name TEXT NOT NULL, description TEXT, goal TEXT, instructions TEXT,
                model TEXT, autonomy VARCHAR(20) NOT NULL DEFAULT 'supervised',
                tools JSONB NOT NULL DEFAULT '[]', memory JSONB NOT NULL DEFAULT '{}',
                guardrails JSONB NOT NULL DEFAULT '{}', max_steps INT NOT NULL DEFAULT 10,
                timeout_seconds INT NOT NULL DEFAULT 120, retry_limit INT NOT NULL DEFAULT 2,
                status VARCHAR(20) NOT NULL DEFAULT 'paused', created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
        `);
        await p.query(`CREATE INDEX IF NOT EXISTS idx_ai_agents_user ON ai_agents(user_id,status)`).catch(() => {});
        await p.query(`
            CREATE TABLE IF NOT EXISTS ai_workflows (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(), user_id UUID NOT NULL,
                name TEXT NOT NULL, description TEXT, trigger_type TEXT NOT NULL DEFAULT 'manual',
                nodes JSONB NOT NULL DEFAULT '[]', version INT NOT NULL DEFAULT 1,
                status VARCHAR(20) NOT NULL DEFAULT 'draft', retry_limit INT NOT NULL DEFAULT 2,
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
        `);
        await p.query(`CREATE INDEX IF NOT EXISTS idx_ai_workflows_user ON ai_workflows(user_id,status)`).catch(() => {});
        await p.query(`
            CREATE TABLE IF NOT EXISTS ai_tasks (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(), user_id UUID NOT NULL,
                workflow_id UUID REFERENCES ai_workflows(id) ON DELETE SET NULL, agent_id UUID REFERENCES ai_agents(id) ON DELETE SET NULL,
                name TEXT NOT NULL, task_type TEXT NOT NULL DEFAULT 'manual', payload JSONB NOT NULL DEFAULT '{}',
                status VARCHAR(20) NOT NULL DEFAULT 'queued', priority INT NOT NULL DEFAULT 5,
                risk_score INT NOT NULL DEFAULT 0, confidence NUMERIC(5,4), retry_count INT NOT NULL DEFAULT 0,
                result JSONB, error_code TEXT, error_message TEXT, started_at TIMESTAMPTZ, finished_at TIMESTAMPTZ,
                idempotency_key TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                UNIQUE(user_id,idempotency_key)
            )
        `);
        await p.query(`CREATE INDEX IF NOT EXISTS idx_ai_tasks_user_status ON ai_tasks(user_id,status,created_at DESC)`).catch(() => {});
        await p.query(`
            CREATE TABLE IF NOT EXISTS ai_approvals (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(), user_id UUID NOT NULL,
                task_id UUID NOT NULL REFERENCES ai_tasks(id) ON DELETE CASCADE, reason TEXT NOT NULL,
                proposed_action TEXT, risk_score INT NOT NULL, confidence NUMERIC(5,4), status VARCHAR(20) NOT NULL DEFAULT 'pending',
                decision_by UUID, decision_note TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), decided_at TIMESTAMPTZ
            )
        `);
        await p.query(`CREATE INDEX IF NOT EXISTS idx_ai_approvals_user ON ai_approvals(user_id,status,created_at DESC)`).catch(() => {});
        await p.query(`
            CREATE TABLE IF NOT EXISTS ai_alerts (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(), user_id UUID NOT NULL,
                severity VARCHAR(20) NOT NULL, source TEXT NOT NULL, description TEXT NOT NULL,
                status VARCHAR(20) NOT NULL DEFAULT 'open', resolution TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), resolved_at TIMESTAMPTZ
            )
        `);
        await p.query(`CREATE INDEX IF NOT EXISTS idx_ai_alerts_user ON ai_alerts(user_id,status,created_at DESC)`).catch(() => {});
        await p.query(`
            CREATE TABLE IF NOT EXISTS ai_events (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(), user_id UUID, event_type TEXT NOT NULL,
                payload JSONB NOT NULL DEFAULT '{}', idempotency_key TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                UNIQUE(event_type,idempotency_key)
            )
        `);
        await p.query(`CREATE INDEX IF NOT EXISTS idx_ai_events_user ON ai_events(user_id,created_at DESC)`).catch(() => {});
        await p.query(`
            CREATE TABLE IF NOT EXISTS ai_audit_log (
                id BIGSERIAL PRIMARY KEY, user_id UUID, task_id UUID, workflow_id UUID, agent_id UUID,
                action TEXT NOT NULL, details JSONB NOT NULL DEFAULT '{}', created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
        `);
        await p.query(`CREATE INDEX IF NOT EXISTS idx_ai_audit_user ON ai_audit_log(user_id,created_at DESC)`).catch(() => {});

        // Safe upgrades for installations created by the legacy schema.
        await p.query(`ALTER TABLE kw_keywords ADD COLUMN IF NOT EXISTS match_type VARCHAR(30) DEFAULT 'contains'`).catch(() => {});
        await p.query(`ALTER TABLE kw_keywords ADD COLUMN IF NOT EXISTS description TEXT`).catch(() => {});
        await p.query(`ALTER TABLE kw_keywords ADD COLUMN IF NOT EXISTS notify_enabled BOOLEAN DEFAULT TRUE`).catch(() => {});
        await p.query(`ALTER TABLE kw_keywords ADD COLUMN IF NOT EXISTS private_reply_enabled BOOLEAN DEFAULT FALSE`).catch(() => {});
        await p.query(`ALTER TABLE kw_keywords ADD COLUMN IF NOT EXISTS terms JSONB`).catch(() => {});
        await p.query(`ALTER TABLE kw_alerts ADD COLUMN IF NOT EXISTS message_id TEXT`).catch(() => {});
        await p.query(`ALTER TABLE kw_alerts ADD COLUMN IF NOT EXISTS is_pinned BOOLEAN DEFAULT FALSE`).catch(() => {});
        await p.query(`ALTER TABLE kw_alerts ADD COLUMN IF NOT EXISTS is_archived BOOLEAN DEFAULT FALSE`).catch(() => {});
        await p.query(`ALTER TABLE kw_alerts ADD COLUMN IF NOT EXISTS notification_id UUID`).catch(() => {});
        await p.query(`CREATE UNIQUE INDEX IF NOT EXISTS ux_kw_alerts_event ON kw_alerts(account_id, message_id, keyword_id) WHERE message_id IS NOT NULL`).catch(() => {});

        // ── Telegram System Tables ────────────────────────────────────────
        const TelegramMigrations = require('./TelegramMigrations');
        await TelegramMigrations.run();
        const LinkImportMigrations = require('./LinkImportMigrations');
        await LinkImportMigrations.run();
        const PrivateWhatsAppMigrations = require('./PrivateWhatsAppMigrations');
        await PrivateWhatsAppMigrations.run();

        // ── Indexes for Multi-Tenant Performance ──────────────────────────────
        await p.query(`CREATE INDEX IF NOT EXISTS idx_accounts_user_id ON accounts(user_id)`).catch(() => {});
        await p.query(`CREATE INDEX IF NOT EXISTS idx_subscriptions_user_id ON subscriptions(user_id)`).catch(() => {});
        await p.query(`CREATE INDEX IF NOT EXISTS idx_subscriptions_status ON subscriptions(status, expires_at)`).catch(() => {});
        // Migrate existing subscriptions table if UNIQUE constraint missing
        await p.query(`
            DO $$ BEGIN
                IF NOT EXISTS (
                    SELECT 1 FROM pg_constraint
                    WHERE conname = 'subscriptions_user_id_key'
                ) THEN
                    -- Remove duplicate subscriptions, keep latest per user
                    DELETE FROM subscriptions s1
                    USING subscriptions s2
                    WHERE s1.user_id = s2.user_id AND s1.created_at < s2.created_at;
                    -- Add unique constraint
                    ALTER TABLE subscriptions ADD CONSTRAINT subscriptions_user_id_key UNIQUE (user_id);
                END IF;
            END $$;
        `).catch(() => {});

        // ── Migration: إضافة حقل enable_telegram لجدول subscriptions ────────
        await p.query(`
            DO $$ BEGIN
                IF NOT EXISTS (
                    SELECT 1 FROM information_schema.columns
                    WHERE table_name='subscriptions' AND column_name='enable_telegram'
                ) THEN
                    ALTER TABLE subscriptions ADD COLUMN enable_telegram BOOLEAN DEFAULT FALSE;
                END IF;
            END $$;
        `).catch(() => {});

        // ── [إصلاح تسجيل الدخول] Migration: استكمال أعمدة جدول refresh_tokens ──
        //    جدول refresh_tokens في قاعدة بيانات الإنتاج قديم جداً (أُنشئ قبل
        //    اكتمال ميزة "تتبّع عائلة التوكنات" / اكتشاف إعادة الاستخدام)،
        //    و`CREATE TABLE IF NOT EXISTS` لا يضيف أعمدة جديدة لجدول موجود
        //    مسبقاً. النتيجة: كانت الأعمدة الناقصة تظهر واحداً تلو الآخر مع كل
        //    محاولة تسجيل دخول ("family_id" ثم "used" ...) بدل أن يُكتشف
        //    النقص دفعة واحدة. الآن نتأكد من وجود كل عمود يعتمد عليه
        //    saveRefreshToken/findRefreshToken/revoke* في نفس الاستدعاء،
        //    باستخدام `ADD COLUMN IF NOT EXISTS` (مدعومة في PostgreSQL) بدل
        //    فحص information_schema لكل عمود على حدة.
        await p.query(`ALTER TABLE refresh_tokens ADD COLUMN IF NOT EXISTS family_id VARCHAR(200)`).catch(() => {});
        await p.query(`ALTER TABLE refresh_tokens ADD COLUMN IF NOT EXISTS user_id UUID`).catch(() => {});
        await p.query(`ALTER TABLE refresh_tokens ADD COLUMN IF NOT EXISTS used BOOLEAN DEFAULT FALSE`).catch(() => {});
        await p.query(`ALTER TABLE refresh_tokens ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ`).catch(() => {});
        await p.query(`ALTER TABLE refresh_tokens ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW()`).catch(() => {});
        await p.query(`ALTER TABLE refresh_tokens ADD COLUMN IF NOT EXISTS token_hash VARCHAR(500)`).catch(() => {});
        await p.query(`CREATE UNIQUE INDEX IF NOT EXISTS ux_refresh_tokens_token_hash ON refresh_tokens(token_hash)`).catch(() => {});
        await p.query(`CREATE INDEX IF NOT EXISTS idx_refresh_tokens_family_id ON refresh_tokens(family_id)`).catch(() => {});
        await p.query(`CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user_id ON refresh_tokens(user_id)`).catch(() => {});

        console.log('[SystemDB] Schema initialized.');
    },

    async query(sql, params = []) {
        const p = getPool();
        return await p.query(sql, params);
    },

    async get(sql, params = []) {
        const result = await this.query(sql, params);
        return result.rows[0] || null;
    },

    async all(sql, params = []) {
        const result = await this.query(sql, params);
        return result.rows;
    },

    async run(sql, params = []) {
        const result = await this.query(sql, params);
        return { rowCount: result.rowCount };
    },

        async seedSuperAdmin() {
        const username = process.env.ADMIN_USERNAME || 'admin';
        const password = process.env.ADMIN_PASSWORD || 'Admin@123456';
        const existing = await this.get(`SELECT id FROM users WHERE role = 'super_admin' LIMIT 1`);

        // Normal redeploys must not overwrite a password changed in the UI.
        // Set RESET_ADMIN_PASSWORD=true for an explicit one-time reset.
        if (existing) {
            if (process.env.RESET_ADMIN_PASSWORD === 'true' && process.env.ADMIN_PASSWORD) {
                const hash = await bcrypt.hash(password, 12);
                await this.run(
                    `UPDATE users
                     SET username=$1, password=$2, status='active', failed_login_count=0,
                         locked_until=NULL, updated_at=NOW()
                     WHERE id=$3`,
                    [username, hash, existing.id]
                );
                console.log(`[SystemDB] Admin credentials reset for: ${username}`);
            }
            return;
        }

        const hash = await bcrypt.hash(password, 12);
        await this.run(
            `INSERT INTO users (id, username, password, full_name, role, status)
             VALUES ($1, $2, $3, $4, 'super_admin', 'active')
             ON CONFLICT (username) DO NOTHING`,
            [uuidv4(), username, hash, 'Super Admin']
        );
        console.log(`[SystemDB] Super admin seeded: ${username}`);
    },

    async log(userId, username, action, details, ip = null) {
        await this.run(
            `INSERT INTO activity_logs (id, user_id, username, action, details, ip_address)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [uuidv4(), userId || null, username || null, action, details || null, ip || null]
        ).catch(() => {});
    },

    async recordAttempt(username, ip, success) {
        await this.run(
            `INSERT INTO login_attempts (id, username, ip_address, success) VALUES ($1, $2, $3, $4)`,
            [uuidv4(), username, ip, success]
        ).catch(() => {});
    },

    async isBlocked(username) {
        return await this.get(
            `SELECT locked_until FROM users WHERE username=$1 AND locked_until > NOW()`, [username]
        );
    },

    // [DB-UNIFY] إغلاق الـ pool المركزي الوحيد
    async close() {
        await closePgPool();
    },
};

// ── دوال إضافية مطلوبة من AuthController ────────────────────────────────────

Object.assign(SystemDB, {

    async getActiveSubscription(userId) {
        return await this.get(
            `SELECT * FROM subscriptions
             WHERE user_id = $1 AND status = 'active'
               AND (expires_at IS NULL OR expires_at > NOW())
             ORDER BY created_at DESC LIMIT 1`,
            [userId]
        ).catch(() => null);
    },

    async getDaysRemaining(sub) {
        if (!sub || !sub.expires_at) return 9999;
        const ms = new Date(sub.expires_at) - Date.now();
        return Math.max(0, Math.ceil(ms / 86400000));
    },

    // [FIX-AUTH-REUSE] كان هذا الاستدعاء يبتلع أي خطأ كتابة بصمت (.catch(()=>{}))
    // — فلو فشل الإدراج لأي سبب (تحميل مؤقت على DB، إعادة تشغيل الخادم أثناء
    // الكتابة...)، يبقى الـ refresh token صالحاً تشفيرياً (JWT موقّع بنجاح)
    // لكن بلا أي صف مطابق في قاعدة البيانات. أول محاولة refresh حقيقية بهذا
    // التوكن كانت تُفسَّر خطأً على أنها "إعادة استخدام" (لأن findRefreshToken
    // ترجع null)، فيُعتبر الـ family كله "مخترقاً" وتُبطل الجلسة بالكامل رغم
    // أنه أول استخدام فعلي — بالضبط ما ظهر في سجلات النشر: "[Auth] REUSE
    // DETECTED" فور تسجيل الدخول رغم عدم وجود أي سرقة حقيقية. الآن الخطأ
    // يُرفع للأعلى ليتعامل معه المستدعي (issue/refresh) صراحة بدل الفشل الصامت.
    async saveRefreshToken(userId, tokenHash, ip, userAgent, expiresAt, familyId) {
        await this.run(
            `INSERT INTO refresh_tokens (token_hash, family_id, user_id, used, expires_at)
             VALUES ($1, $2, $3, FALSE, $4)
             ON CONFLICT (token_hash) DO NOTHING`,
            [tokenHash, familyId || null, userId, expiresAt]
        );
    },

    // [FIX-AUTH-REUSE] يُرجع الصف فقط إن كان لا يزال غير مُستخدَم (used=FALSE)
    // وغير منتهي الصلاحية — هذا هو الفحص الصحيح لتمييز "توكن صالح للاستخدام"
    // عن "توكن مُستخدَم سابقاً/منتهي"، بدل الاعتماد فقط على وجود الصف (كان
    // أي صف موجود يُعتبر صالحاً حتى لو used=TRUE بالفعل، مما يسمح نظرياً
    // بإعادة استخدام توكن مُدار بالفعل بدل رفضه واعتباره اختراقاً محتملاً).
    async findRefreshToken(tokenHash) {
        return await this.get(
            `SELECT * FROM refresh_tokens WHERE token_hash = $1 AND used = FALSE AND expires_at > NOW()`,
            [tokenHash]
        ).catch(() => null);
    },

    async revokeRefreshToken(tokenHash) {
        await this.run(
            `UPDATE refresh_tokens SET used = TRUE WHERE token_hash = $1`, [tokenHash]
        ).catch(() => {});
    },

    async revokeAllUserTokensByFamily(familyId) {
        await this.run(
            `UPDATE refresh_tokens SET used = TRUE WHERE family_id = $1`, [familyId]
        ).catch(() => {});
    },

    async revokeAllUserTokens(userId) {
        await this.run(
            `UPDATE refresh_tokens SET used = TRUE WHERE user_id = $1`, [userId]
        ).catch(() => {});
    },

    async resetDailyMessageCounters() {
        return await this.run(
            `UPDATE accounts SET messages_sent_today = 0 WHERE messages_sent_today <> 0`
        );
    },
});

// ── deleteAllSessionData ────────────────────────────────────────────
Object.assign(SystemDB, {
    async deleteAllSessionData(accountId) {
        await this.run(
            `DELETE FROM session_data WHERE account_id = $1`, [accountId]
        ).catch(() => {});
    },
});

module.exports = SystemDB;
