const SystemDB = require('../database/SystemDB');
const QueueManager = require('../lib/QueueManager');
const logger = require('../core/Logger');
const { withAdvisoryLock } = require('../lib/postgres');

const LEVELS = [
    { min: 98, key: 'emergency_mode', label: 'Emergency Mode', type: 'error', action: 'تعليق المهام الخلفية غير الأساسية ومنع أي تنظيف خطِر.' },
    { min: 95, key: 'emergency_warning', label: 'Emergency Warning', type: 'error', action: 'منع العمليات غير الضرورية مع الحفاظ على العمليات الأساسية.' },
    { min: 90, key: 'critical', label: 'Critical', type: 'error', action: 'تشغيل VACUUM ANALYZE آمن على الجداول ذات الصفوف الميتة فقط.' },
    { min: 80, key: 'high_risk', label: 'High Risk', type: 'warning', action: 'تحليل الجداول والفهارس وWAL والملفات المؤقتة وReplication Slots.' },
    { min: 70, key: 'warning', label: 'Warning', type: 'warning', action: 'مراقبة وتنبيه المسؤول دون حذف تلقائي.' },
];
const SAFE_LEVEL = 'normal';
const STATE_ID = 'postgres-storage';
const DEFAULT_INTERVAL_MS = 60_000;

function positive(value, fallback = 0) {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? n : fallback;
}
function bytes(value) { return Number(value || 0); }
function formatBytes(value) {
    let n = bytes(value); const units = ['B', 'KB', 'MB', 'GB', 'TB']; let i = 0;
    while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
    return `${n.toFixed(i ? 2 : 0)} ${units[i]}`;
}
function levelFor(percent) { return LEVELS.find(item => percent >= item.min) || { key: SAFE_LEVEL, label: 'Normal', type: 'success', action: 'لا توجد إجراءات مطلوبة.' }; }

class PostgresStorageMonitor {
    constructor({ db = SystemDB, notifications = QueueManager, log = logger } = {}) {
        this.db = db; this.notifications = notifications; this.log = log; this.timer = null; this.isChecking = false;
        this.limitBytes = positive(process.env.POSTGRES_STORAGE_LIMIT_BYTES || process.env.DATABASE_STORAGE_LIMIT_BYTES);
        this.intervalMs = positive(process.env.POSTGRES_STORAGE_MONITOR_INTERVAL_MS, DEFAULT_INTERVAL_MS);
        this.autoVacuum = process.env.POSTGRES_STORAGE_AUTO_VACUUM !== 'false';
        this.monitorRetentionDays = Math.max(7, Number(process.env.POSTGRES_MONITOR_RETENTION_DAYS || 90));
        this.autoPruneMonitoringData = process.env.POSTGRES_MONITOR_AUTO_PRUNE !== 'false';
        this.lastPruneAt = 0;
    }

    async _query(sql, params = []) { return this.db.all ? this.db.all(sql, params) : (await this.db.query(sql, params)).rows; }
    async _one(sql, params = []) { return this.db.get ? this.db.get(sql, params) : (await this.db.query(sql, params)).rows[0]; }
    async _run(sql, params = []) { return this.db.run ? this.db.run(sql, params) : this.db.query(sql, params); }

    async _analysis() {
        const tables = await this._query(`SELECT schemaname, relname AS name, pg_total_relation_size(relid)::bigint AS total_bytes, pg_relation_size(relid)::bigint AS table_bytes, (pg_total_relation_size(relid)-pg_relation_size(relid))::bigint AS index_bytes, n_live_tup::bigint, n_dead_tup::bigint, last_autovacuum, last_autoanalyze FROM pg_stat_user_tables ORDER BY pg_total_relation_size(relid) DESC LIMIT 20`);
        const indexes = await this._query(`SELECT schemaname, indexrelname AS name, relname AS table_name, pg_relation_size(indexrelid)::bigint AS total_bytes, idx_scan::bigint FROM pg_stat_user_indexes ORDER BY pg_relation_size(indexrelid) DESC LIMIT 20`);
        const database = await this._query(`SELECT datname AS name, temp_files::bigint, temp_bytes::bigint, deadlocks::bigint, numbackends::int FROM pg_stat_database WHERE datname = current_database()`);
        let wal = []; try { wal = await this._query(`SELECT COALESCE(SUM(size),0)::bigint AS total_bytes, COUNT(*)::int AS file_count FROM pg_ls_waldir()`); } catch (error) { wal = [{ total_bytes: 0, file_count: 0, unavailable: error.message }]; }
        let slots = []; try { slots = await this._query(`SELECT slot_name, slot_type, active, COALESCE(pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn),0)::bigint AS retained_bytes FROM pg_replication_slots ORDER BY retained_bytes DESC`); } catch (error) { slots = [{ unavailable: error.message }]; }
        const totals = { tables: tables.reduce((s, r) => s + bytes(r.total_bytes), 0), indexes: indexes.reduce((s, r) => s + bytes(r.total_bytes), 0), wal: bytes(wal[0]?.total_bytes), temporary: bytes(database[0]?.temp_bytes) };
        const dominant = Object.entries(totals).sort((a, b) => b[1] - a[1])[0] || ['unknown', 0];
        const recommendations = [];
        if (dominant[0] === 'tables') recommendations.push('راجع الجداول الأكبر، سياسة الاحتفاظ، والصفوف الميتة؛ شغّل VACUUM/Autovacuum حسب الحاجة.');
        if (dominant[0] === 'indexes') recommendations.push('راجع الفهارس غير المستخدمة بعد التحقق من الاستعلامات؛ لا يُحذف أي فهرس تلقائيًا.');
        if (dominant[0] === 'wal') recommendations.push('افحص Replication Slots غير النشطة وتأكد من صحة النسخ قبل أي إجراء.');
        if (dominant[0] === 'temporary') recommendations.push('افحص الاستعلامات التي تنشئ ملفات مؤقتة كبيرة وwork_mem، دون قتل عمليات أساسية تلقائيًا.');
        recommendations.push('سجلات PostgreSQL وملفات النظام خارج صلاحية SQL القياسية؛ راجعها من مزود الاستضافة إذا لم تتوفر صلاحية pg_ls_dir.');
        return { tables, indexes, wal: wal[0] || {}, temporary: database[0] || {}, replicationSlots: slots, totals, dominantSource: { key: dominant[0], bytes: dominant[1] }, recommendations, analyzedAt: new Date().toISOString() };
    }

    async getStatus({ includeAnalysis = true } = {}) {
        if (!this.limitBytes) return { enabled: false, reason: 'missing_storage_limit', level: SAFE_LEVEL, label: 'Not configured' };
        const usage = await this._one(`SELECT current_database() AS database_name, pg_database_size(current_database())::bigint AS used_bytes`);
        const usedBytes = bytes(usage?.used_bytes); const remainingBytes = Math.max(0, this.limitBytes - usedBytes); const usagePercent = (usedBytes / this.limitBytes) * 100;
        const level = levelFor(usagePercent); const analysis = includeAnalysis && usagePercent >= 80 ? await this._analysis() : null;
        return { enabled: true, databaseName: usage?.database_name, usedBytes, usedPretty: formatBytes(usedBytes), limitBytes: this.limitBytes, limitPretty: formatBytes(this.limitBytes), remainingBytes, remainingPretty: formatBytes(remainingBytes), usagePercent, level: level.key, levelLabel: level.label, alertActive: level.key !== SAFE_LEVEL, status: level.key === 'emergency_mode' ? 'emergency' : level.key === 'normal' ? 'healthy' : 'degraded', action: level.action, analysis, checkedAt: new Date().toISOString() };
    }

    async _audit(eventType, level, action, result, details = {}) {
        await this._run(`INSERT INTO postgres_storage_audit_logs (event_type, severity, action, result, details, created_at) VALUES ($1,$2,$3,$4,$5::jsonb,NOW())`, [eventType, level, action, result, JSON.stringify(details)]).catch(error => this.log.warn({ err: error }, '[PostgresStorageMonitor] audit write failed'));
    }

    async _safeCleanup(status) {
        if (!this.autoVacuum || status.usagePercent < 90) return { executed: false, reason: 'safe_cleanup_disabled_or_not_required' };
        const candidates = await this._query(`SELECT format('VACUUM (ANALYZE) %I.%I', schemaname, relname) AS command, schemaname, relname, n_dead_tup::bigint AS dead_rows FROM pg_stat_user_tables WHERE n_dead_tup > 0 ORDER BY n_dead_tup DESC LIMIT 5`);
        const results = [];
        for (const candidate of candidates) {
            try { await this.db.query(candidate.command); results.push({ table: `${candidate.schemaname}.${candidate.relname}`, result: 'success', deadRows: bytes(candidate.dead_rows) }); }
            catch (error) { results.push({ table: `${candidate.schemaname}.${candidate.relname}`, result: 'failed', error: error.message }); }
        }
        await this._audit('safe_cleanup', status.level, 'VACUUM (ANALYZE) للجداول ذات الصفوف الميتة فقط', results.every(r => r.result === 'success') ? 'success' : 'partial_failure', { results });
        return { executed: true, results };
    }

    async _pruneMonitoringData() {
        if (!this.autoPruneMonitoringData || Date.now() - this.lastPruneAt < 60 * 60 * 1000) return { executed: false, reason: 'not_due' };
        this.lastPruneAt = Date.now();
        const days = this.monitorRetentionDays;
        const results = [];
        for (const table of ['postgres_storage_snapshots', 'postgres_storage_audit_logs']) {
            try {
                const result = await this._run(`DELETE FROM ${table} WHERE created_at < NOW() - ($1::int * INTERVAL '1 day')`, [days]);
                results.push({ table, deleted: Number(result?.rowCount || 0) });
            } catch (error) {
                // Tables may not exist during first boot; pruning is non-fatal.
                results.push({ table, deleted: 0, skipped: true });
            }
        }
        return { executed: true, retentionDays: days, results };
    }

    async check() {
        if (!this.limitBytes) { this.log.warn('[PostgresStorageMonitor] Disabled: POSTGRES_STORAGE_LIMIT_BYTES is not configured.'); return { enabled: false, reason: 'missing_storage_limit' }; }
        if (this.isChecking) return { skipped: true, reason: 'check_in_progress' }; this.isChecking = true;
        try {
            return await withAdvisoryLock('postgres-storage-monitor', async () => {
                const status = await this.getStatus({ includeAnalysis: true });
                status.emergencyMode = status.level === 'emergency_mode';
                if (this.notifications.setEmergencyMode) await this.notifications.setEmergencyMode(status.emergencyMode);
                const previous = await this._one(`SELECT current_level FROM postgres_storage_alert_state WHERE state_id=$1`, [STATE_ID]);
                const changed = (previous?.current_level || SAFE_LEVEL) !== status.level;
                await this._run(`INSERT INTO postgres_storage_alert_state (state_id, alert_active, current_level, current_status, last_usage_percent, last_used_bytes, last_snapshot, updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,NOW()) ON CONFLICT (state_id) DO UPDATE SET alert_active=EXCLUDED.alert_active,current_level=EXCLUDED.current_level,current_status=EXCLUDED.current_status,last_usage_percent=EXCLUDED.last_usage_percent,last_used_bytes=EXCLUDED.last_used_bytes,last_snapshot=EXCLUDED.last_snapshot,updated_at=NOW()`, [STATE_ID, status.level !== SAFE_LEVEL, status.level, status.status, status.usagePercent, status.usedBytes, JSON.stringify(status)]);
                await this._run(`INSERT INTO postgres_storage_snapshots (usage_percent, used_bytes, limit_bytes, level, dominant_source, details, created_at) VALUES ($1,$2,$3,$4,$5,$6::jsonb,NOW())`, [status.usagePercent, status.usedBytes, status.limitBytes, status.level, status.analysis?.dominantSource?.key || null, JSON.stringify(status)]).catch(error => this.log.warn({ err: error }, '[PostgresStorageMonitor] snapshot write failed'));
                await this._pruneMonitoringData().catch(error => this.log.warn({ err: error }, '[PostgresStorageMonitor] retention prune failed'));
                if (changed && status.level !== SAFE_LEVEL) {
                    const cleanup = status.level === 'critical' ? await this._safeCleanup(status) : { executed: false, reason: 'not_critical' };
                    const main = status.analysis?.dominantSource?.key || 'غير محدد';
                    const message = `${status.levelLabel}: استخدام PostgreSQL ${status.usagePercent.toFixed(1)}% — المستخدم ${status.usedPretty}، المتبقي ${status.remainingPretty}، المصدر الأكبر: ${main}. الإجراء: ${cleanup.executed ? 'تم تنفيذ VACUUM آمن وتسجيل نتيجته.' : status.action}`;
                    await this.notifications.enqueueNotification({ type: levelFor(status.usagePercent).type, title: `تنبيه PostgreSQL — ${status.levelLabel}`, message });
                    await this._audit('alert', status.level, status.action, 'notification_sent', { status, cleanup });
                } else if (changed && status.level === SAFE_LEVEL) await this._audit('recovered', SAFE_LEVEL, 'عودة المراقبة إلى الحالة الطبيعية', 'success', { status });
                return { ...status, changed };
            }, { wait: true });
        } catch (error) { this.log.error({ err: error }, '[PostgresStorageMonitor] Check failed.'); return { enabled: true, error: error.message }; }
        finally { this.isChecking = false; }
    }
    async getAudit(limit = 100) { return this._query(`SELECT id,event_type,severity,action,result,details,created_at FROM postgres_storage_audit_logs ORDER BY created_at DESC LIMIT $1`, [Math.min(500, Math.max(1, Number(limit) || 100))]); }
    start() { if (this.timer || !this.limitBytes) { if (!this.limitBytes) this.log.warn('[PostgresStorageMonitor] Not started: configure POSTGRES_STORAGE_LIMIT_BYTES.'); return; } this.check(); this.timer = setInterval(() => this.check(), this.intervalMs); this.timer.unref?.(); this.log.info(`[PostgresStorageMonitor] Started. interval=${this.intervalMs}ms.`); }
    stop() { if (this.timer) clearInterval(this.timer); this.timer = null; }
}

module.exports = new PostgresStorageMonitor();
module.exports.PostgresStorageMonitor = PostgresStorageMonitor;
module.exports.formatBytes = formatBytes;
module.exports.levelFor = levelFor;
module.exports.LEVELS = LEVELS;
