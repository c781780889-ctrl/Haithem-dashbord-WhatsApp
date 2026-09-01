'use strict';

const fs = require('fs');
const path = require('path');
const logger = require('../core/Logger').child({ module: 'StorageMonitor' });

const LEVELS = [
    { min: 95, key: 'emergency', label: 'Emergency' },
    { min: 90, key: 'critical', label: 'Critical' },
    { min: 80, key: 'high', label: 'High' },
    { min: 70, key: 'warning', label: 'Warning' },
];

function numberEnv(name, fallback) {
    const value = Number(process.env[name]);
    return Number.isFinite(value) && value > 0 ? value : fallback;
}

function levelFor(percent) {
    return LEVELS.find(level => percent >= level.min) || { key: 'normal', label: 'Normal' };
}

function statfs(targetPath) {
    const stat = fs.statfsSync(targetPath);
    const totalBytes = Number(stat.blocks) * Number(stat.bsize);
    const freeBytes = Number(stat.bavail) * Number(stat.bsize);
    const usedBytes = Math.max(0, totalBytes - freeBytes);
    const totalInodes = Number(stat.files || 0);
    const freeInodes = Number(stat.ffree || 0);
    return {
        path: targetPath,
        totalBytes,
        freeBytes,
        usedBytes,
        usagePercent: totalBytes ? (usedBytes / totalBytes) * 100 : 0,
        totalInodes,
        freeInodes,
        inodeUsagePercent: totalInodes ? ((totalInodes - freeInodes) / totalInodes) * 100 : 0,
    };
}

class StorageMonitor {
    constructor({ log = logger } = {}) {
        this.log = log;
        this.timer = null;
        this.lastLevel = 'normal';
        this.path = path.resolve(process.env.STORAGE_MONITOR_PATH || process.cwd());
        this.intervalMs = numberEnv('STORAGE_MONITOR_INTERVAL_MS', 60_000);
        this.warning = numberEnv('ALERT_STORAGE_WARNING_THRESHOLD', 70);
        this.high = numberEnv('ALERT_STORAGE_HIGH_THRESHOLD', 80);
        this.critical = numberEnv('ALERT_STORAGE_CRITICAL_THRESHOLD', 90);
        this.emergency = numberEnv('ALERT_STORAGE_EMERGENCY_THRESHOLD', 95);
    }

    status() {
        try {
            const result = statfs(this.path);
            const effectivePercent = Math.max(result.usagePercent, result.inodeUsagePercent);
            const level = effectivePercent >= this.emergency ? 'emergency'
                : effectivePercent >= this.critical ? 'critical'
                : effectivePercent >= this.high ? 'high'
                : effectivePercent >= this.warning ? 'warning' : 'normal';
            return { ...result, effectivePercent, level, checkedAt: new Date().toISOString() };
        } catch (error) {
            this.log.warn({ err: error }, '[StorageMonitor] Unable to inspect filesystem.');
            return { path: this.path, level: 'unknown', error: 'Storage metrics unavailable', checkedAt: new Date().toISOString() };
        }
    }

    async check() {
        const result = this.status();
        if (result.level !== this.lastLevel) {
            const severity = result.level === 'normal' ? 'info' : result.level === 'warning' ? 'warn' : 'error';
            this.log[severity]({ storage: result }, `[StorageMonitor] Storage level changed to ${result.level}.`);
            this.lastLevel = result.level;
        }
        if (result.level === 'emergency') {
            this.log.error({ storage: result }, '[StorageMonitor] Emergency storage threshold reached; no database files will be touched.');
            await this.safeCleanup().catch(error => this.log.warn({ err: error }, '[StorageMonitor] Safe cleanup failed.'));
        }
        return result;
    }

    async safeCleanup() {
        if (process.env.STORAGE_AUTO_CLEANUP !== 'true') {
            return { executed: false, reason: 'disabled_by_default' };
        }
        const configured = (process.env.APP_CLEANUP_DIRS || '').split(',').map(item => item.trim()).filter(Boolean);
        const allowedRoots = configured.map(item => path.resolve(item));
        const maxAgeMs = numberEnv('APP_TEMP_RETENTION_MS', 24 * 60 * 60 * 1000);
        const cutoff = Date.now() - maxAgeMs;
        let removed = 0;
        for (const root of allowedRoots) {
            if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) continue;
            for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
                const target = path.join(root, entry.name);
                const stat = fs.statSync(target);
                if (stat.mtimeMs >= cutoff) continue;
                if (entry.isFile() || entry.isSymbolicLink()) fs.rmSync(target, { force: true });
                else if (entry.isDirectory()) fs.rmSync(target, { recursive: true, force: true });
                removed += 1;
            }
        }
        return { executed: true, removed, roots: allowedRoots };
    }

    start() {
        if (this.timer) return;
        this.check().catch(error => this.log.warn({ err: error }, '[StorageMonitor] Initial check failed.'));
        this.timer = setInterval(() => this.check().catch(error => this.log.warn({ err: error }, '[StorageMonitor] Check failed.')), this.intervalMs);
        this.timer.unref?.();
        this.log.info({ path: this.path, intervalMs: this.intervalMs }, '[StorageMonitor] Started.');
    }

    stop() {
        if (this.timer) clearInterval(this.timer);
        this.timer = null;
    }
}

module.exports = new StorageMonitor();
module.exports.StorageMonitor = StorageMonitor;
module.exports.levelFor = levelFor;
module.exports.statfs = statfs;
