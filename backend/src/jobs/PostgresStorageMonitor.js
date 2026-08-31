/**
 * PostgresStorageMonitor
 *
 * يراقب حجم قاعدة البيانات الحالية مقارنةً بالسعة المحددة في البيئة.
 * عند عبور حد 70% لأول مرة، يُرسل إشعارًا فوريًا إلى لوحة التحكم عبر
 * طابور الإشعارات الموجود. لا يعيد إرسال التنبيه في كل دورة؛ يعاد تسليح
 * التنبيه فقط بعد انخفاض الاستخدام إلى ما دون الحد.
 */
const SystemDB = require('../database/SystemDB');
const QueueManager = require('../lib/QueueManager');
const logger = require('../core/Logger');

const DEFAULT_THRESHOLD_PERCENT = 70;
const DEFAULT_INTERVAL_MS = 60 * 1000;
const STATE_ID = 'postgres-storage';

function parsePositiveNumber(value, fallback) {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function formatBytes(bytes) {
    const value = Number(bytes);
    if (!Number.isFinite(value)) return 'غير معروف';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let size = value;
    let unit = 0;
    while (size >= 1024 && unit < units.length - 1) {
        size /= 1024;
        unit += 1;
    }
    return `${size.toFixed(unit === 0 ? 0 : 2)} ${units[unit]}`;
}

class PostgresStorageMonitor {
    constructor({ db = SystemDB, notifications = QueueManager, log = logger } = {}) {
        this.db = db;
        this.notifications = notifications;
        this.log = log;
        this.timer = null;
        this.isChecking = false;
        this.thresholdPercent = parsePositiveNumber(
            process.env.POSTGRES_STORAGE_ALERT_THRESHOLD_PERCENT,
            DEFAULT_THRESHOLD_PERCENT
        );
        this.intervalMs = parsePositiveNumber(
            process.env.POSTGRES_STORAGE_MONITOR_INTERVAL_MS,
            DEFAULT_INTERVAL_MS
        );
        this.limitBytes = parsePositiveNumber(
            process.env.POSTGRES_STORAGE_LIMIT_BYTES || process.env.DATABASE_STORAGE_LIMIT_BYTES,
            0
        );
    }

    async check() {
        if (!this.limitBytes) {
            this.log.warn('[PostgresStorageMonitor] Disabled: POSTGRES_STORAGE_LIMIT_BYTES is not configured.');
            return { enabled: false, reason: 'missing_storage_limit' };
        }
        if (this.isChecking) return { skipped: true, reason: 'check_in_progress' };
        this.isChecking = true;
        try {
            const usage = await this.db.get(
                `SELECT current_database() AS database_name,
                        pg_database_size(current_database())::bigint AS used_bytes`
            );
            const usedBytes = Number(usage?.used_bytes || 0);
            const usagePercent = (usedBytes / this.limitBytes) * 100;
            const overThreshold = usagePercent >= this.thresholdPercent;

            const state = await this.db.get(
                `SELECT alert_active FROM postgres_storage_alert_state
                 WHERE state_id = $1 FOR UPDATE`, [STATE_ID]
            );
            const wasActive = Boolean(state?.alert_active);

            if (overThreshold && !wasActive) {
                await this.db.run(
                    `INSERT INTO postgres_storage_alert_state (state_id, alert_active, last_usage_percent, last_used_bytes, last_alert_at, updated_at)
                     VALUES ($1, TRUE, $2, $3, NOW(), NOW())
                     ON CONFLICT (state_id) DO UPDATE SET
                       alert_active = TRUE,
                       last_usage_percent = EXCLUDED.last_usage_percent,
                       last_used_bytes = EXCLUDED.last_used_bytes,
                       last_alert_at = NOW(),
                       updated_at = NOW()`,
                    [STATE_ID, usagePercent, usedBytes]
                );
                await this.notifications.enqueueNotification({
                    type: 'error',
                    title: 'تنبيه مساحة PostgreSQL',
                    message: `استخدام قاعدة البيانات ${usage?.database_name || ''} وصل إلى ${usagePercent.toFixed(1)}% (${formatBytes(usedBytes)} من ${formatBytes(this.limitBytes)}). يرجى اتخاذ إجراء فوري لتجنب توقف الخدمة.`,
                });
                this.log.error({ usagePercent, usedBytes, limitBytes: this.limitBytes }, '[PostgresStorageMonitor] Storage threshold reached.');
            } else {
                await this.db.run(
                    `INSERT INTO postgres_storage_alert_state (state_id, alert_active, last_usage_percent, last_used_bytes, updated_at)
                     VALUES ($1, $2, $3, $4, NOW())
                     ON CONFLICT (state_id) DO UPDATE SET
                       alert_active = EXCLUDED.alert_active,
                       last_usage_percent = EXCLUDED.last_usage_percent,
                       last_used_bytes = EXCLUDED.last_used_bytes,
                       updated_at = NOW()`,
                    [STATE_ID, overThreshold, usagePercent, usedBytes]
                );
            }

            return { enabled: true, databaseName: usage?.database_name, usedBytes, limitBytes: this.limitBytes, usagePercent, alertActive: overThreshold };
        } catch (error) {
            this.log.error({ err: error }, '[PostgresStorageMonitor] Check failed.');
            return { enabled: true, error: error.message };
        } finally {
            this.isChecking = false;
        }
    }

    start() {
        if (this.timer) return;
        if (!this.limitBytes) {
            this.log.warn('[PostgresStorageMonitor] Not started: configure POSTGRES_STORAGE_LIMIT_BYTES.');
            return;
        }
        this.check();
        this.timer = setInterval(() => this.check(), this.intervalMs);
        this.timer.unref?.();
        this.log.info(`[PostgresStorageMonitor] Started. Threshold=${this.thresholdPercent}% interval=${this.intervalMs}ms.`);
    }

    stop() {
        if (this.timer) clearInterval(this.timer);
        this.timer = null;
    }
}

module.exports = new PostgresStorageMonitor();
module.exports.PostgresStorageMonitor = PostgresStorageMonitor;
module.exports.formatBytes = formatBytes;
