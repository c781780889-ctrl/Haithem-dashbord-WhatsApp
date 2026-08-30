/**
 * PrivateWhatsAppMigrations
 *
 * System-level, additive migrations for the Private WhatsApp namespace.
 * The namespace is intentionally separate from account schemas and from the
 * existing public-account campaign tables.
 */
const { query } = require('../lib/postgres');

const PrivateWhatsAppMigrations = {
    async run() {
        await query(`
            CREATE TABLE IF NOT EXISTS private_whatsapp_publishing_accounts (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                name VARCHAR(200) NOT NULL,
                phone_number VARCHAR(50),
                session_ref TEXT,
                status VARCHAR(30) NOT NULL DEFAULT 'DISABLED',
                last_activity_at TIMESTAMPTZ,
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                UNIQUE(user_id, phone_number)
            )
        `);
        await query(`CREATE INDEX IF NOT EXISTS idx_private_wa_pub_accounts_user ON private_whatsapp_publishing_accounts(user_id,status)`).catch(() => {});

        await query(`
            CREATE TABLE IF NOT EXISTS private_whatsapp_contacts (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                normalized_phone VARCHAR(32) NOT NULL,
                original_phone VARCHAR(80),
                country_code VARCHAR(8),
                status VARCHAR(30) NOT NULL DEFAULT 'ACTIVE',
                consent_status VARCHAR(20) NOT NULL DEFAULT 'UNKNOWN',
                opt_out_status BOOLEAN NOT NULL DEFAULT FALSE,
                tags JSONB NOT NULL DEFAULT '[]'::jsonb,
                notes TEXT,
                first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                UNIQUE(user_id, normalized_phone),
                CHECK (consent_status IN ('OPTED_IN','OPTED_OUT','UNKNOWN'))
            )
        `);
        await query(`CREATE INDEX IF NOT EXISTS idx_private_wa_contacts_user_seen ON private_whatsapp_contacts(user_id,last_seen_at DESC)`).catch(() => {});
        await query(`CREATE INDEX IF NOT EXISTS idx_private_wa_contacts_user_consent ON private_whatsapp_contacts(user_id,consent_status,opt_out_status)`).catch(() => {});
        await query(`CREATE INDEX IF NOT EXISTS idx_private_wa_contacts_phone ON private_whatsapp_contacts(user_id,normalized_phone)`).catch(() => {});

        await query(`
            CREATE TABLE IF NOT EXISTS private_whatsapp_contact_sources (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                contact_id UUID NOT NULL REFERENCES private_whatsapp_contacts(id) ON DELETE CASCADE,
                user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                source_account_id UUID REFERENCES accounts(id) ON DELETE SET NULL,
                source_group_id TEXT NOT NULL,
                source_group_name TEXT,
                role VARCHAR(40) NOT NULL DEFAULT 'MEMBER',
                first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                UNIQUE(contact_id,source_account_id,source_group_id)
            )
        `);
        await query(`CREATE INDEX IF NOT EXISTS idx_private_wa_sources_user ON private_whatsapp_contact_sources(user_id,last_seen_at DESC)`).catch(() => {});
        await query(`CREATE INDEX IF NOT EXISTS idx_private_wa_sources_group ON private_whatsapp_contact_sources(user_id,source_group_id)`).catch(() => {});

        await query(`
            CREATE TABLE IF NOT EXISTS private_whatsapp_sync_jobs (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                status VARCHAR(30) NOT NULL DEFAULT 'QUEUED',
                requested_account_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
                total_accounts INTEGER NOT NULL DEFAULT 0,
                processed_accounts INTEGER NOT NULL DEFAULT 0,
                discovered_count INTEGER NOT NULL DEFAULT 0,
                new_contacts_count INTEGER NOT NULL DEFAULT 0,
                duplicate_count INTEGER NOT NULL DEFAULT 0,
                excluded_count INTEGER NOT NULL DEFAULT 0,
                error_message TEXT,
                request_id TEXT,
                settings JSONB NOT NULL DEFAULT '{}'::jsonb,
                started_at TIMESTAMPTZ,
                completed_at TIMESTAMPTZ,
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
        `);
        await query(`ALTER TABLE private_whatsapp_sync_jobs ADD COLUMN IF NOT EXISTS settings JSONB NOT NULL DEFAULT '{}'::jsonb`).catch(() => {});
        await query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_private_wa_sync_request ON private_whatsapp_sync_jobs(user_id,request_id) WHERE request_id IS NOT NULL`).catch(() => {});
        await query(`CREATE INDEX IF NOT EXISTS idx_private_wa_sync_jobs_user ON private_whatsapp_sync_jobs(user_id,created_at DESC)`).catch(() => {});

        await query(`
            CREATE TABLE IF NOT EXISTS private_whatsapp_sync_accounts (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                sync_job_id UUID NOT NULL REFERENCES private_whatsapp_sync_jobs(id) ON DELETE CASCADE,
                user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                account_id UUID REFERENCES accounts(id) ON DELETE SET NULL,
                status VARCHAR(30) NOT NULL DEFAULT 'QUEUED',
                cursor_group_id TEXT,
                cursor_phone TEXT,
                discovered_count INTEGER NOT NULL DEFAULT 0,
                new_contacts_count INTEGER NOT NULL DEFAULT 0,
                duplicate_count INTEGER NOT NULL DEFAULT 0,
                excluded_count INTEGER NOT NULL DEFAULT 0,
                attempts INTEGER NOT NULL DEFAULT 0,
                worker_id TEXT,
                lease_expires_at TIMESTAMPTZ,
                heartbeat_at TIMESTAMPTZ,
                started_at TIMESTAMPTZ,
                completed_at TIMESTAMPTZ,
                last_error TEXT,
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                UNIQUE(sync_job_id,account_id)
            )
        `);
        await query(`ALTER TABLE private_whatsapp_sync_accounts ADD COLUMN IF NOT EXISTS available_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`).catch(() => {});
        await query(`ALTER TABLE private_whatsapp_sync_accounts ADD COLUMN IF NOT EXISTS queue_job_id TEXT`).catch(() => {});
        await query(`CREATE INDEX IF NOT EXISTS idx_private_wa_sync_accounts_ready ON private_whatsapp_sync_accounts(status,available_at,lease_expires_at,created_at)`).catch(() => {});
        await query(`CREATE INDEX IF NOT EXISTS idx_private_wa_sync_accounts_job ON private_whatsapp_sync_accounts(sync_job_id,status)`).catch(() => {});

        await query(`
            CREATE TABLE IF NOT EXISTS private_whatsapp_audit_logs (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                user_id UUID REFERENCES users(id) ON DELETE CASCADE,
                actor_id UUID REFERENCES users(id) ON DELETE SET NULL,
                action VARCHAR(80) NOT NULL,
                entity_type VARCHAR(50) NOT NULL,
                entity_id UUID,
                payload JSONB NOT NULL DEFAULT '{}'::jsonb,
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
        `);
        await query(`CREATE INDEX IF NOT EXISTS idx_private_wa_audit_user ON private_whatsapp_audit_logs(user_id,created_at DESC)`).catch(() => {});

        await query(`
            CREATE TABLE IF NOT EXISTS private_whatsapp_settings (
                user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
                default_country_code VARCHAR(3),
                sync_enabled BOOLEAN NOT NULL DEFAULT TRUE,
                updated_by UUID REFERENCES users(id) ON DELETE SET NULL,
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
        `);

        console.log('[PrivateWhatsAppMigrations] Tables ready');
    },
};

module.exports = PrivateWhatsAppMigrations;
