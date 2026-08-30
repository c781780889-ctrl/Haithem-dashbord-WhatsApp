'use strict';

const { query } = require('../lib/postgres');

const LinkImportMigrations = {
  async run() {
    await query(`
      CREATE TABLE IF NOT EXISTS link_import_sources (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL,
        filename TEXT NOT NULL,
        file_size_bytes INT NOT NULL,
        total_found INT NOT NULL DEFAULT 0,
        new_count INT NOT NULL DEFAULT 0,
        duplicate_count INT NOT NULL DEFAULT 0,
        invalid_count INT NOT NULL DEFAULT 0,
        review_count INT NOT NULL DEFAULT 0,
        processing_ms INT,
        status VARCHAR(20) NOT NULL DEFAULT 'completed',
        request_id TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await query(`
      CREATE TABLE IF NOT EXISTS link_import_links (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL,
        source_id UUID REFERENCES link_import_sources(id) ON DELETE SET NULL,
        discovered_link_id UUID,
        url TEXT NOT NULL,
        canonical_url TEXT NOT NULL,
        invite_code TEXT NOT NULL,
        validation_status VARCHAR(20) NOT NULL DEFAULT 'valid',
        last_status VARCHAR(30),
        last_error TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE(user_id, canonical_url)
      )
    `);
    await query(`
      CREATE TABLE IF NOT EXISTS link_import_tasks (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL,
        status VARCHAR(20) NOT NULL DEFAULT 'pending',
        min_delay_seconds INT NOT NULL DEFAULT 60,
        max_delay_seconds INT NOT NULL DEFAULT 180,
        max_retries INT NOT NULL DEFAULT 2,
        retry_backoff_seconds INT NOT NULL DEFAULT 15,
        queue_priority INT NOT NULL DEFAULT 5,
        ad_library_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
        ad_payloads JSONB NOT NULL DEFAULT '[]'::jsonb,
        workflow_mode VARCHAR(30) NOT NULL DEFAULT 'join_only',
        distribution_mode VARCHAR(30) NOT NULL DEFAULT 'all_accounts',
        source_link_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
        wait_after_join_seconds INT NOT NULL DEFAULT 0,
        wait_after_publish_seconds INT NOT NULL DEFAULT 0,
        wait_after_leave_seconds INT NOT NULL DEFAULT 0,
        leave_enabled BOOLEAN NOT NULL DEFAULT FALSE,
        total_operations INT NOT NULL DEFAULT 0,
        completed_operations INT NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        completed_at TIMESTAMPTZ,
        request_id TEXT,
        cycle_limit INT NOT NULL DEFAULT 30,
        cycle_duration_minutes INT NOT NULL DEFAULT 60,
        auto_resume BOOLEAN NOT NULL DEFAULT TRUE
      )
    `);
    await query(`
      CREATE TABLE IF NOT EXISTS link_import_cycles (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        task_id UUID NOT NULL REFERENCES link_import_tasks(id) ON DELETE CASCADE,
        user_id UUID NOT NULL,
        account_id UUID NOT NULL,
        cycle_number INT NOT NULL,
        cycle_start TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        cycle_end TIMESTAMPTZ,
        processed_count INT NOT NULL DEFAULT 0,
        success_count INT NOT NULL DEFAULT 0,
        request_count INT NOT NULL DEFAULT 0,
        failed_count INT NOT NULL DEFAULT 0,
        remaining_count INT NOT NULL DEFAULT 0,
        current_operation_id UUID,
        current_link_id UUID,
        last_result VARCHAR(30),
        status VARCHAR(20) NOT NULL DEFAULT 'RUNNING',
        next_cycle_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE(task_id, account_id, cycle_number)
      )
    `);
    await query(`
      CREATE TABLE IF NOT EXISTS link_import_operations (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        task_id UUID NOT NULL REFERENCES link_import_tasks(id) ON DELETE CASCADE,
        user_id UUID NOT NULL,
        account_id UUID NOT NULL,
        link_id UUID NOT NULL REFERENCES link_import_links(id) ON DELETE CASCADE,
        cycle_id UUID REFERENCES link_import_cycles(id) ON DELETE SET NULL,
        cycle_counted_at TIMESTAMPTZ,
        status VARCHAR(20) NOT NULL DEFAULT 'pending',
        current_stage VARCHAR(20) NOT NULL DEFAULT 'pending',
        join_status VARCHAR(20) NOT NULL DEFAULT 'pending',
        publish_status VARCHAR(20) NOT NULL DEFAULT 'pending',
        leave_status VARCHAR(20) NOT NULL DEFAULT 'skipped',
        group_id TEXT,
        joined_by_operation BOOLEAN NOT NULL DEFAULT FALSE,
        attempt_count INT NOT NULL DEFAULT 0,
        last_error TEXT,
        started_at TIMESTAMPTZ,
        completed_at TIMESTAMPTZ,
        join_started_at TIMESTAMPTZ,
        join_completed_at TIMESTAMPTZ,
        publish_started_at TIMESTAMPTZ,
        publish_completed_at TIMESTAMPTZ,
        leave_started_at TIMESTAMPTZ,
        leave_completed_at TIMESTAMPTZ,
        wait_started_at TIMESTAMPTZ,
        wait_completed_at TIMESTAMPTZ,
        stage_updated_at TIMESTAMPTZ,
        next_retry_at TIMESTAMPTZ,
        next_run_at TIMESTAMPTZ,
        reschedule_count INT NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE(task_id, account_id, link_id)
      )
    `);
    await query(`
      CREATE TABLE IF NOT EXISTS join_automation_settings (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL UNIQUE,
        automation_enabled BOOLEAN NOT NULL DEFAULT TRUE,
        min_delay_seconds INT NOT NULL DEFAULT 60,
        max_delay_seconds INT NOT NULL DEFAULT 180,
        max_concurrent_jobs INT NOT NULL DEFAULT 1,
        retry_count INT NOT NULL DEFAULT 2,
        retry_backoff_seconds INT NOT NULL DEFAULT 15,
        queue_priority INT NOT NULL DEFAULT 5,
        daily_operation_limit INT NOT NULL DEFAULT 10,
        daily_limit_protection_enabled BOOLEAN NOT NULL DEFAULT FALSE,
        cycle_limit INT NOT NULL DEFAULT 30,
        cycle_duration_minutes INT NOT NULL DEFAULT 60,
        auto_resume BOOLEAN NOT NULL DEFAULT TRUE,
        account_settings JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await query(`
      CREATE TABLE IF NOT EXISTS join_automation_discovery_jobs (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL,
        source_account_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
        status VARCHAR(20) NOT NULL DEFAULT 'queued',
        queue_job_id TEXT,
        messages_scanned INT NOT NULL DEFAULT 0,
        found_count INT NOT NULL DEFAULT 0,
        error TEXT,
        started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        completed_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        request_id TEXT
      )
    `);
    await query(`
      CREATE TABLE IF NOT EXISTS join_automation_account_states (
        user_id UUID NOT NULL,
        account_id UUID NOT NULL,
        enabled BOOLEAN NOT NULL DEFAULT TRUE,
        max_concurrent_jobs INT NOT NULL DEFAULT 1,
        pause_on_error BOOLEAN NOT NULL DEFAULT TRUE,
        health_threshold INT NOT NULL DEFAULT 3,
        last_error TEXT,
        last_transition_at TIMESTAMPTZ,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (user_id, account_id)
      )
    `);
    await query(`
      CREATE TABLE IF NOT EXISTS link_import_events (
        id BIGSERIAL PRIMARY KEY,
        user_id UUID NOT NULL,
        task_id UUID REFERENCES link_import_tasks(id) ON DELETE CASCADE,
        operation_id UUID REFERENCES link_import_operations(id) ON DELETE CASCADE,
        account_id UUID,
        link_id UUID,
        event_type VARCHAR(40) NOT NULL,
        payload JSONB NOT NULL DEFAULT '{}',
        reason TEXT,
        next_run_at TIMESTAMPTZ,
        job_id TEXT,
        worker_id TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    // Safe upgrades for databases created before the staged workflow.
    await query(`ALTER TABLE link_import_events ADD COLUMN IF NOT EXISTS reason TEXT`).catch(() => {});
    await query(`ALTER TABLE link_import_events ADD COLUMN IF NOT EXISTS next_run_at TIMESTAMPTZ`).catch(() => {});
    await query(`ALTER TABLE link_import_events ADD COLUMN IF NOT EXISTS job_id TEXT`).catch(() => {});
    await query(`ALTER TABLE link_import_events ADD COLUMN IF NOT EXISTS worker_id TEXT`).catch(() => {});
    await query(`ALTER TABLE link_import_sources ADD COLUMN IF NOT EXISTS request_id TEXT`).catch(() => {});
    await query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_link_import_sources_request ON link_import_sources(user_id,request_id) WHERE request_id IS NOT NULL`).catch(() => {});
    await query(`ALTER TABLE join_automation_settings ADD COLUMN IF NOT EXISTS daily_operation_limit INT NOT NULL DEFAULT 10`).catch(() => {});
    await query(`ALTER TABLE join_automation_settings ADD COLUMN IF NOT EXISTS daily_limit_protection_enabled BOOLEAN NOT NULL DEFAULT FALSE`).catch(() => {});
    await query(`ALTER TABLE join_automation_settings ADD COLUMN IF NOT EXISTS cycle_limit INT NOT NULL DEFAULT 30`).catch(() => {});
    await query(`ALTER TABLE join_automation_settings ADD COLUMN IF NOT EXISTS cycle_duration_minutes INT NOT NULL DEFAULT 60`).catch(() => {});
    await query(`ALTER TABLE join_automation_settings ADD COLUMN IF NOT EXISTS auto_resume BOOLEAN NOT NULL DEFAULT TRUE`).catch(() => {});
    await query(`ALTER TABLE join_automation_discovery_jobs ADD COLUMN IF NOT EXISTS queue_job_id TEXT`).catch(() => {});
    await query(`ALTER TABLE join_automation_discovery_jobs ADD COLUMN IF NOT EXISTS messages_scanned INT NOT NULL DEFAULT 0`).catch(() => {});
    await query(`ALTER TABLE join_automation_discovery_jobs ADD COLUMN IF NOT EXISTS request_id TEXT`).catch(() => {});
    await query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_join_automation_discovery_request ON join_automation_discovery_jobs(user_id,request_id) WHERE request_id IS NOT NULL`).catch(() => {});
    await query(`ALTER TABLE link_import_links ADD COLUMN IF NOT EXISTS discovered_link_id UUID`).catch(() => {});
    await query(`CREATE INDEX IF NOT EXISTS idx_link_import_links_discovered ON link_import_links(discovered_link_id)`).catch(() => {});
    await query(`ALTER TABLE link_import_tasks ADD COLUMN IF NOT EXISTS retry_backoff_seconds INT NOT NULL DEFAULT 15`).catch(() => {});
    await query(`ALTER TABLE link_import_tasks ADD COLUMN IF NOT EXISTS queue_priority INT NOT NULL DEFAULT 5`).catch(() => {});
    await query(`ALTER TABLE link_import_tasks ADD COLUMN IF NOT EXISTS ad_library_ids JSONB NOT NULL DEFAULT '[]'::jsonb`).catch(() => {});
    await query(`ALTER TABLE link_import_tasks ADD COLUMN IF NOT EXISTS scheduled_at TIMESTAMPTZ`).catch(() => {});
    await query(`ALTER TABLE link_import_operations ADD COLUMN IF NOT EXISTS scheduled_at TIMESTAMPTZ`).catch(() => {});
    await query(`ALTER TABLE link_import_operations ADD COLUMN IF NOT EXISTS next_run_at TIMESTAMPTZ`).catch(() => {});
    await query(`ALTER TABLE link_import_operations ADD COLUMN IF NOT EXISTS idempotency_key VARCHAR(255)`).catch(() => {});
    await query(`ALTER TABLE link_import_operations ADD COLUMN IF NOT EXISTS error_code VARCHAR(80)`).catch(() => {});
    await query(`ALTER TABLE link_import_operations ADD COLUMN IF NOT EXISTS cycle_id UUID`).catch(() => {});
    await query(`ALTER TABLE link_import_operations ADD COLUMN IF NOT EXISTS cycle_counted_at TIMESTAMPTZ`).catch(() => {});
    await query(`ALTER TABLE link_import_cycles ADD COLUMN IF NOT EXISTS remaining_count INT NOT NULL DEFAULT 0`).catch(() => {});
    await query(`ALTER TABLE link_import_cycles ADD COLUMN IF NOT EXISTS current_operation_id UUID`).catch(() => {});
    await query(`ALTER TABLE link_import_cycles ADD COLUMN IF NOT EXISTS current_link_id UUID`).catch(() => {});
    await query(`ALTER TABLE link_import_cycles ADD COLUMN IF NOT EXISTS last_result VARCHAR(30)`).catch(() => {});
    await query(`ALTER TABLE link_import_operations ADD COLUMN IF NOT EXISTS lease_expires_at TIMESTAMPTZ`).catch(() => {});
    await query(`ALTER TABLE link_import_operations ADD COLUMN IF NOT EXISTS heartbeat_at TIMESTAMPTZ`).catch(() => {});
    await query(`ALTER TABLE link_import_operations ADD COLUMN IF NOT EXISTS queue_job_id TEXT`).catch(() => {});
    await query(`ALTER TABLE link_import_operations ADD COLUMN IF NOT EXISTS worker_id TEXT`).catch(() => {});
    await query(`ALTER TABLE link_import_operations ADD COLUMN IF NOT EXISTS result JSONB NOT NULL DEFAULT '{}'::jsonb`).catch(() => {});
    await query(`CREATE INDEX IF NOT EXISTS idx_link_import_ops_lease ON link_import_operations(status, lease_expires_at)`).catch(() => {});
    await query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_link_import_ops_idempotency ON link_import_operations(idempotency_key) WHERE idempotency_key IS NOT NULL`).catch(() => {});
    await query(`CREATE INDEX IF NOT EXISTS idx_join_automation_settings_user ON join_automation_settings(user_id)`).catch(() => {});
    await query(`CREATE INDEX IF NOT EXISTS idx_join_automation_discovery_user ON join_automation_discovery_jobs(user_id, created_at DESC)`).catch(() => {});
    await query(`CREATE INDEX IF NOT EXISTS idx_join_automation_account_states_user ON join_automation_account_states(user_id, updated_at DESC)`).catch(() => {});
    await query(`ALTER TABLE link_import_tasks ADD COLUMN IF NOT EXISTS ad_payloads JSONB NOT NULL DEFAULT '[]'::jsonb`).catch(() => {});
    await query(`ALTER TABLE link_import_tasks ADD COLUMN IF NOT EXISTS request_id TEXT`).catch(() => {});
    await query(`ALTER TABLE link_import_tasks ADD COLUMN IF NOT EXISTS cycle_limit INT NOT NULL DEFAULT 30`).catch(() => {});
    await query(`ALTER TABLE link_import_tasks ADD COLUMN IF NOT EXISTS cycle_duration_minutes INT NOT NULL DEFAULT 60`).catch(() => {});
    await query(`ALTER TABLE link_import_tasks ADD COLUMN IF NOT EXISTS auto_resume BOOLEAN NOT NULL DEFAULT TRUE`).catch(() => {});
    await query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_link_import_tasks_request ON link_import_tasks(user_id,request_id) WHERE request_id IS NOT NULL`).catch(() => {});
    await query(`ALTER TABLE link_import_operations ADD COLUMN IF NOT EXISTS processing_started_at TIMESTAMPTZ`).catch(() => {});
    await query(`ALTER TABLE link_import_operations ADD COLUMN IF NOT EXISTS recovery_count INT NOT NULL DEFAULT 0`).catch(() => {});
    await query(`ALTER TABLE link_import_operations ADD COLUMN IF NOT EXISTS reschedule_count INT NOT NULL DEFAULT 0`).catch(() => {});
    await query(`ALTER TABLE link_import_operations ADD COLUMN IF NOT EXISTS membership_state VARCHAR(30)`).catch(() => {});
    await query(`ALTER TABLE link_import_operations ADD COLUMN IF NOT EXISTS verification_evidence JSONB NOT NULL DEFAULT '{}'::jsonb`).catch(() => {});
    await query(`ALTER TABLE link_import_tasks ADD COLUMN IF NOT EXISTS workflow_mode VARCHAR(30) NOT NULL DEFAULT 'join_only'`).catch(() => {});
    await query(`ALTER TABLE link_import_tasks ADD COLUMN IF NOT EXISTS distribution_mode VARCHAR(30) NOT NULL DEFAULT 'all_accounts'`).catch(() => {});
    await query(`ALTER TABLE link_import_tasks ADD COLUMN IF NOT EXISTS source_link_ids JSONB NOT NULL DEFAULT '[]'::jsonb`).catch(() => {});
    await query(`ALTER TABLE link_import_tasks ADD COLUMN IF NOT EXISTS wait_after_join_seconds INT NOT NULL DEFAULT 0`).catch(() => {});
    await query(`ALTER TABLE link_import_tasks ADD COLUMN IF NOT EXISTS wait_after_publish_seconds INT NOT NULL DEFAULT 0`).catch(() => {});
    await query(`ALTER TABLE link_import_tasks ADD COLUMN IF NOT EXISTS wait_after_leave_seconds INT NOT NULL DEFAULT 0`).catch(() => {});
    await query(`ALTER TABLE link_import_tasks ADD COLUMN IF NOT EXISTS leave_enabled BOOLEAN NOT NULL DEFAULT FALSE`).catch(() => {});
    await query(`ALTER TABLE link_import_operations ADD COLUMN IF NOT EXISTS current_stage VARCHAR(20) NOT NULL DEFAULT 'pending'`).catch(() => {});
    await query(`ALTER TABLE link_import_operations ADD COLUMN IF NOT EXISTS join_status VARCHAR(20) NOT NULL DEFAULT 'pending'`).catch(() => {});
    await query(`ALTER TABLE link_import_operations ADD COLUMN IF NOT EXISTS publish_status VARCHAR(20) NOT NULL DEFAULT 'pending'`).catch(() => {});
    await query(`ALTER TABLE link_import_operations ADD COLUMN IF NOT EXISTS leave_status VARCHAR(20) NOT NULL DEFAULT 'skipped'`).catch(() => {});
    await query(`ALTER TABLE link_import_operations ADD COLUMN IF NOT EXISTS group_id TEXT`).catch(() => {});
    await query(`ALTER TABLE link_import_operations ADD COLUMN IF NOT EXISTS joined_by_operation BOOLEAN NOT NULL DEFAULT FALSE`).catch(() => {});
    await query(`ALTER TABLE link_import_operations ADD COLUMN IF NOT EXISTS join_started_at TIMESTAMPTZ`).catch(() => {});
    await query(`ALTER TABLE link_import_operations ADD COLUMN IF NOT EXISTS join_completed_at TIMESTAMPTZ`).catch(() => {});
    await query(`ALTER TABLE link_import_operations ADD COLUMN IF NOT EXISTS publish_started_at TIMESTAMPTZ`).catch(() => {});
    await query(`ALTER TABLE link_import_operations ADD COLUMN IF NOT EXISTS publish_completed_at TIMESTAMPTZ`).catch(() => {});
    await query(`ALTER TABLE link_import_operations ADD COLUMN IF NOT EXISTS leave_started_at TIMESTAMPTZ`).catch(() => {});
    await query(`ALTER TABLE link_import_operations ADD COLUMN IF NOT EXISTS leave_completed_at TIMESTAMPTZ`).catch(() => {});
    await query(`ALTER TABLE link_import_operations ADD COLUMN IF NOT EXISTS wait_started_at TIMESTAMPTZ`).catch(() => {});
    await query(`ALTER TABLE link_import_operations ADD COLUMN IF NOT EXISTS wait_completed_at TIMESTAMPTZ`).catch(() => {});
    await query(`ALTER TABLE link_import_operations ADD COLUMN IF NOT EXISTS stage_updated_at TIMESTAMPTZ`).catch(() => {});
    await query(`CREATE INDEX IF NOT EXISTS idx_link_import_sources_user ON link_import_sources(user_id, created_at DESC)`).catch(() => {});
    await query(`CREATE INDEX IF NOT EXISTS idx_link_import_links_user ON link_import_links(user_id, created_at DESC)`).catch(() => {});
    await query(`CREATE INDEX IF NOT EXISTS idx_link_import_ops_ready ON link_import_operations(status, next_retry_at, created_at)`).catch(() => {});
    await query(`CREATE INDEX IF NOT EXISTS idx_link_import_ops_account_status ON link_import_operations(account_id,status,updated_at DESC)`).catch(() => {});
    await query(`CREATE INDEX IF NOT EXISTS idx_link_import_ops_account_next_run ON link_import_operations(account_id,next_run_at)`).catch(() => {});
    await query(`CREATE INDEX IF NOT EXISTS idx_link_import_ops_task ON link_import_operations(task_id, status)`).catch(() => {});
    await query(`CREATE INDEX IF NOT EXISTS idx_link_import_ops_cycle ON link_import_operations(cycle_id,status)`).catch(() => {});
    await query(`CREATE INDEX IF NOT EXISTS idx_link_import_cycles_due ON link_import_cycles(status,next_cycle_at)`).catch(() => {});
    await query(`CREATE INDEX IF NOT EXISTS idx_link_import_events_user ON link_import_events(user_id, created_at DESC)`).catch(() => {});
    await query(`CREATE INDEX IF NOT EXISTS idx_link_import_events_account_time ON link_import_events(account_id,created_at DESC)`).catch(() => {});
    await query(`
      CREATE TABLE IF NOT EXISTS link_import_outbox (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL,
        aggregate_type VARCHAR(40) NOT NULL,
        aggregate_id UUID NOT NULL,
        event_type VARCHAR(60) NOT NULL,
        payload JSONB NOT NULL DEFAULT '{}'::jsonb,
        status VARCHAR(20) NOT NULL DEFAULT 'PENDING',
        attempt_count INT NOT NULL DEFAULT 0,
        available_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        processed_at TIMESTAMPTZ,
        last_error TEXT,
        worker_id TEXT,
        lease_expires_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE(aggregate_type,aggregate_id,event_type)
      )
    `).catch(() => {});
    await query(`ALTER TABLE link_import_outbox ADD COLUMN IF NOT EXISTS worker_id TEXT`).catch(() => {});
    await query(`ALTER TABLE link_import_outbox ADD COLUMN IF NOT EXISTS lease_expires_at TIMESTAMPTZ`).catch(() => {});
    await query(`CREATE INDEX IF NOT EXISTS idx_link_import_outbox_ready ON link_import_outbox(status,available_at,created_at)`).catch(() => {});
    await query(`
      CREATE TABLE IF NOT EXISTS link_import_audit_logs (
        id BIGSERIAL PRIMARY KEY,
        actor_id UUID NOT NULL,
        action VARCHAR(60) NOT NULL,
        entity_type VARCHAR(40) NOT NULL,
        entity_id TEXT,
        before_state JSONB NOT NULL DEFAULT '{}'::jsonb,
        after_state JSONB NOT NULL DEFAULT '{}'::jsonb,
        ip INET,
        user_agent TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `).catch(() => {});
    await query(`CREATE INDEX IF NOT EXISTS idx_link_import_audit_actor ON link_import_audit_logs(actor_id,created_at DESC)`).catch(() => {});
    await query(`
      CREATE TABLE IF NOT EXISTS link_import_account_guards (
        account_id UUID PRIMARY KEY,
        circuit_state VARCHAR(20) NOT NULL DEFAULT 'CLOSED',
        reason_code VARCHAR(80),
        reason TEXT,
        opened_at TIMESTAMPTZ,
        consecutive_503 INT NOT NULL DEFAULT 0,
        deferred_count INT NOT NULL DEFAULT 0,
        lock_collision_count INT NOT NULL DEFAULT 0,
        recovery_count INT NOT NULL DEFAULT 0,
        retry_count INT NOT NULL DEFAULT 0,
        last_signal_at TIMESTAMPTZ,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `).catch(() => {});
    await query(`ALTER TABLE link_import_account_guards ADD COLUMN IF NOT EXISTS circuit_state VARCHAR(20) NOT NULL DEFAULT 'CLOSED'`).catch(() => {});
    await query(`ALTER TABLE link_import_account_guards ADD COLUMN IF NOT EXISTS reason_code VARCHAR(80)`).catch(() => {});
    await query(`ALTER TABLE link_import_account_guards ADD COLUMN IF NOT EXISTS reason TEXT`).catch(() => {});
    await query(`ALTER TABLE link_import_account_guards ADD COLUMN IF NOT EXISTS opened_at TIMESTAMPTZ`).catch(() => {});
    await query(`ALTER TABLE link_import_account_guards ADD COLUMN IF NOT EXISTS consecutive_503 INT NOT NULL DEFAULT 0`).catch(() => {});
    await query(`ALTER TABLE link_import_account_guards ADD COLUMN IF NOT EXISTS deferred_count INT NOT NULL DEFAULT 0`).catch(() => {});
    await query(`ALTER TABLE link_import_account_guards ADD COLUMN IF NOT EXISTS lock_collision_count INT NOT NULL DEFAULT 0`).catch(() => {});
    await query(`ALTER TABLE link_import_account_guards ADD COLUMN IF NOT EXISTS recovery_count INT NOT NULL DEFAULT 0`).catch(() => {});
    await query(`ALTER TABLE link_import_account_guards ADD COLUMN IF NOT EXISTS retry_count INT NOT NULL DEFAULT 0`).catch(() => {});
    await query(`ALTER TABLE link_import_account_guards ADD COLUMN IF NOT EXISTS last_signal_at TIMESTAMPTZ`).catch(() => {});
    await query(`ALTER TABLE link_import_account_guards ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`).catch(() => {});
    await query(`CREATE INDEX IF NOT EXISTS idx_link_import_guards_state ON link_import_account_guards(circuit_state,updated_at DESC)`).catch(() => {});

    // Backfill links imported by older builds into the primary join-automation list.
    // This is idempotent and also repairs rows created before whatsapp_links materialization.
    await query(`
      INSERT INTO whatsapp_links
        (id,whatsapp_link,source_account_name,source_group,source_history,discovered_by_account_ids,discovered_at,last_seen,duplicate_count,status,processing_status,joined,copied,deleted,import_user_id)
      SELECT gen_random_uuid(),l.canonical_url,'استيراد يدوي',CONCAT('Word: ',COALESCE(s.filename,'ملف مستورد')),
             jsonb_build_array(jsonb_build_object('accountId',NULL,'accountName','استيراد يدوي','group',CONCAT('Word: ',COALESCE(s.filename,'ملف مستورد')),'seenAt',COALESCE(s.created_at,NOW()))),
             '[]'::jsonb,COALESCE(s.created_at,NOW()),COALESCE(s.created_at,NOW()),0,'new','new',false,false,false,l.user_id
        FROM link_import_links l
        LEFT JOIN link_import_sources s ON s.id=l.source_id
       WHERE l.discovered_link_id IS NULL
      ON CONFLICT (whatsapp_link) DO UPDATE SET import_user_id=COALESCE(whatsapp_links.import_user_id,EXCLUDED.import_user_id)
    `).catch(() => {});
    await query(`
      UPDATE link_import_links l
         SET discovered_link_id=wl.id,updated_at=NOW()
        FROM whatsapp_links wl
       WHERE l.discovered_link_id IS NULL
         AND wl.whatsapp_link=l.canonical_url
         AND (wl.import_user_id=l.user_id OR wl.import_user_id IS NULL)
    `).catch(() => {});
    console.log('[LinkImportMigrations] Tables ready');
  },
};

module.exports = LinkImportMigrations;
