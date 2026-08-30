'use strict';
/**
 * QueueManager — [FIX-20] Centralized Queue System
 *
 * المشكلة قبل الإصلاح:
 *   - PrivateCampaignService يستخدم setTimeout داخل loop لإرسال الرسائل:
 *       for (const member of members) {
 *           await delay(waitMs);      ← setTimeout مباشر
 *           await sendMessage(...)
 *       }
 *   - المشاكل:
 *       1. إذا مات الـ process: كل المهام المعلّقة تضيع
 *       2. لا يمكن إيقاف/استئناف حملة بعد بدء التنفيذ
 *       3. استهلاك memory متزايد مع كل حملة (عشرات الـ timers المعلّقة)
 *       4. لا يمكن مراقبة التقدم من خارج الـ process
 *
 * الحل — QueueManager مع 3 Queues مخصصة:
 *   ┌─────────────────────┬────────────────────────────────────────────────┐
 *   │ wa-campaigns        │ إرسال رسائل الحملات (Broadcast + Private)      │
 *   │ wa-sync             │ مزامنة المجموعات + تحديث البيانات               │
 *   │ wa-notifications    │ إشعارات النظام الداخلية                         │
 *   └─────────────────────┴────────────────────────────────────────────────┘
 *
 * كل Worker لديه concurrency مستقل ومعدّل إرسال محكوم
 */

const { Queue, Worker, QueueEvents } = require('bullmq');
const { getBullMQConnection }        = require('./redis');
const { metrics }                    = require('../api/middleware/MetricsMiddleware');

// ── Queue Names ───────────────────────────────────────────────────────────────
const QUEUES = {
    CAMPAIGNS:     'wa-campaigns',
        SYNC:          'wa-sync',
    PRIVATE_WHATSAPP_SYNC: 'private-whatsapp-sync',
    NOTIFICATIONS:   'wa-notifications',
    LINK_IMPORTS:   'wa-link-imports',
    LINK_DISCOVERY: 'wa-link-discovery',
    LINK_OUTBOX: 'wa-link-outbox',
    TELEGRAM_JOINS: 'telegram-join-automation',
    TELEGRAM_DISCOVERY: 'telegram-link-discovery',
    TELEGRAM_OUTBOX: 'telegram-automation-outbox',
    GEMINI_ANALYSIS: 'gemini-analysis',
};

// ── Default Job Options ───────────────────────────────────────────────────────
const DEFAULT_JOB_OPTIONS = {
    attempts: 3,
    backoff:  { type: 'exponential', delay: 3_000 },
    removeOnComplete: { count: 200, age: 86_400 },  // 24h
    removeOnFail:     { count: 500, age: 604_800 }, // 7 days
};

class QueueManager {
    constructor() {
        // Queues — لإضافة المهام
        this._queues  = {};
        // Workers — لتنفيذ المهام
        this._workers = {};
        // QueueEvents — لمراقبة الأحداث (اختياري)
        this._events  = {};

        this._isRunning = false;

        // Handlers مُسجَّلة من الخارج (يُضيفها JobScheduler أو Bootstrap)
        this._handlers = {};
    }

    // ══════════════════════════════════════════════════════════════════════════
    // التهيئة
    // ══════════════════════════════════════════════════════════════════════════

    /**
     * تسجيل handler لنوع مهمة معين
     * يجب استدعاؤه قبل start()
     *
     * @param {string}   queueName - اسم الـ Queue (من QUEUES)
     * @param {string}   jobType   - نوع المهمة (مثل 'send_private_message')
     * @param {Function} handler   - async (job) => void
     */
    registerHandler(queueName, jobType, handler) {
        if (!this._handlers[queueName]) this._handlers[queueName] = {};
        this._handlers[queueName][jobType] = handler;
        console.log(`[QueueManager] Handler registered: ${queueName}::${jobType}`);
    }

    /**
     * بدء تشغيل جميع القوائم والـ Workers
     */
    async start() {
        if (this._isRunning) return;

        // إنشاء Queues
        for (const name of Object.values(QUEUES)) {
            this._queues[name] = new Queue(name, {
                connection:         getBullMQConnection(),
                defaultJobOptions:  DEFAULT_JOB_OPTIONS,
            });
        }

        // إنشاء Workers بإعدادات مناسبة لكل Queue
        this._workers[QUEUES.CAMPAIGNS] = new Worker(
            QUEUES.CAMPAIGNS,
            (job) => this._dispatch(QUEUES.CAMPAIGNS, job),
            {
                connection:  getBullMQConnection(),
                concurrency: parseInt(process.env.CAMPAIGN_CONCURRENCY || '3', 10),
                limiter:     { max: 5, duration: 1_000 }, // 5 رسائل/ثانية حداً أقصى
            }
        );

        this._workers[QUEUES.SYNC] = new Worker(
            QUEUES.SYNC,
            (job) => this._dispatch(QUEUES.SYNC, job),
            {
                connection: getBullMQConnection(),
                concurrency: parseInt(process.env.SYNC_CONCURRENCY || '5', 10),
            }
        );

        this._workers[QUEUES.PRIVATE_WHATSAPP_SYNC] = new Worker(
            QUEUES.PRIVATE_WHATSAPP_SYNC,
            (job) => this._dispatch(QUEUES.PRIVATE_WHATSAPP_SYNC, job),
            {
                connection: getBullMQConnection(),
                concurrency: Math.max(1, Math.min(4, parseInt(process.env.PRIVATE_WHATSAPP_SYNC_CONCURRENCY || '2', 10))),
                limiter: { max: Math.max(1, Math.min(4, parseInt(process.env.PRIVATE_WHATSAPP_SYNC_CONCURRENCY || '2', 10))), duration: 1000 },
            }
        );

        this._workers[QUEUES.NOTIFICATIONS] = new Worker(
            QUEUES.NOTIFICATIONS,
            (job) => this._dispatch(QUEUES.NOTIFICATIONS, job),
            {
                connection:  getBullMQConnection(),
                concurrency: 10,
            }
        );

        // Link imports run independently across accounts. The service-level
        // advisory/account locks still serialize duplicate jobs for the same
        // account, while this worker concurrency prevents Account A from
        // occupying the only execution slot for Accounts B and C.
        const linkImportConcurrency = Math.max(1, Math.min(10, parseInt(process.env.LINK_IMPORT_CONCURRENCY || '3', 10)));
        this._workers[QUEUES.LINK_IMPORTS] = new Worker(
            QUEUES.LINK_IMPORTS,
            (job) => this._dispatch(QUEUES.LINK_IMPORTS, job),
            {
                connection:     getBullMQConnection(),
                concurrency: linkImportConcurrency,
                limiter:     { max: linkImportConcurrency, duration: 1000 },
            }
        );

        // Discovery is a separate durable job from link-join operations. It may
        // inspect many persisted messages, so it must not run inside the HTTP
        // request or block the dashboard response.
        this._workers[QUEUES.LINK_DISCOVERY] = new Worker(
            QUEUES.LINK_DISCOVERY,
            (job) => this._dispatch(QUEUES.LINK_DISCOVERY, job),
            {
                connection: getBullMQConnection(),
                concurrency: 1,
            }
        );

        this._workers[QUEUES.LINK_OUTBOX] = new Worker(
            QUEUES.LINK_OUTBOX,
            (job) => this._dispatch(QUEUES.LINK_OUTBOX, job),
            {
                connection: getBullMQConnection(),
                concurrency: 1,
            }
        );

        // Telegram join operations are isolated from search and WhatsApp queues.
        // A single worker keeps account pacing deterministic; the service-level
        // idempotency key prevents duplicate account × link execution.
        this._workers[QUEUES.TELEGRAM_JOINS] = new Worker(
            QUEUES.TELEGRAM_JOINS,
            (job) => this._dispatch(QUEUES.TELEGRAM_JOINS, job),
            {
                connection: getBullMQConnection(),
                concurrency: 1,
                limiter: { max: 1, duration: 1000 },
            }
        );

        this._workers[QUEUES.TELEGRAM_DISCOVERY] = new Worker(
            QUEUES.TELEGRAM_DISCOVERY,
            (job) => this._dispatch(QUEUES.TELEGRAM_DISCOVERY, job),
            { connection: getBullMQConnection(), concurrency: 1 }
        );

        this._workers[QUEUES.TELEGRAM_OUTBOX] = new Worker(
            QUEUES.TELEGRAM_OUTBOX,
            (job) => this._dispatch(QUEUES.TELEGRAM_OUTBOX, job),
            { connection: getBullMQConnection(), concurrency: 1 }
        );

        this._workers[QUEUES.GEMINI_ANALYSIS] = new Worker(
            QUEUES.GEMINI_ANALYSIS,
            (job) => this._dispatch(QUEUES.GEMINI_ANALYSIS, job),
            {
                connection: getBullMQConnection(),
                concurrency: Math.max(1, Math.min(10, Number(process.env.GEMINI_CONCURRENCY || 2))),
                limiter: { max: Math.max(1, Math.min(30, Number(process.env.GEMINI_RPM || 20))), duration: 60_000 },
            }
        );

        // تسجيل أحداث Workers
        for (const [name, worker] of Object.entries(this._workers)) {
            worker.on('completed', (job, result) =>
                console.log(JSON.stringify({ event: 'worker_completed', queue: name, jobId: job.id, jobName: job.name, operationId: job.data?.operationId || null, accountId: job.data?.accountId || null, outcome: result?.outcome || 'handler_completed', joinStatus: result?.joinStatus || null, reason: result?.reason || null, at: new Date().toISOString() }))
            );
            worker.on('failed', (job, err) =>
                console.error(`[QueueManager:${name}] ❌ Job ${job?.id} (${job?.name}) failed: ${err.message}`)
            );
            worker.on('error', (err) =>
                console.error(`[QueueManager:${name}] Worker error: ${err.message}`)
            );
        }

        this._isRunning = true;
        console.log('[QueueManager] ✅ All queues and workers started.');
        console.log(`[QueueManager] Queues: ${Object.values(QUEUES).join(', ')}`);
    }

    /**
     * إيقاف جميع Workers والـ Queues بشكل آمن
     */
    async stop() {
        if (!this._isRunning) return;
        this._isRunning = false;

        // إيقاف Workers أولاً (ينتظر اكتمال المهام الجارية)
        for (const [name, worker] of Object.entries(this._workers)) {
            try {
                await worker.close();
                console.log(`[QueueManager] Worker ${name} stopped.`);
            } catch (err) {
                console.warn(`[QueueManager] Worker ${name} close error: ${err.message}`);
            }
        }

        // ثم إغلاق Queues
        for (const [name, queue] of Object.entries(this._queues)) {
            try {
                await queue.close();
                console.log(`[QueueManager] Queue ${name} closed.`);
            } catch (err) {
                console.warn(`[QueueManager] Queue ${name} close error: ${err.message}`);
            }
        }
    }

    // ══════════════════════════════════════════════════════════════════════════
    // Dispatcher الداخلي
    // ══════════════════════════════════════════════════════════════════════════

    async _dispatch(queueName, job) {
        const handler = this._handlers[queueName]?.[job.name];

        if (!handler) {
            const error = new Error(`[QueueManager] No handler for ${queueName}::${job.name}`);
            console.error(error.message);
            throw error;
        }

        await handler(job);
    }

    // ══════════════════════════════════════════════════════════════════════════
    // Campaigns Queue API
    // ══════════════════════════════════════════════════════════════════════════

    /**
     * إضافة رسالة حملة عامة (Broadcast)
     * يستبدل setTimeout في CampaignService
     *
     * @param {string} accountId
     * @param {string} campaignId
     * @param {object} payload    - { targetId, targetType, adLibraryId, messageIndex }
     * @param {number} delayMs    - تأخير بالمللي ثانية (بدلاً من setTimeout)
     */
    async enqueueCampaignMessage(accountId, campaignId, payload, delayMs = 0) {
        const queue = this._getQueue(QUEUES.CAMPAIGNS);
        return queue.add('send_campaign_message', {
            accountId,
            campaignId,
            ...payload,
        }, {
            delay:    delayMs,
            priority: 5,
            jobId:    `campaign:${campaignId}:${payload.targetId}:${Date.now()}`,
        });
    }

    /**
     * إضافة رسالة حملة خاصة (Private Campaign)
     * يستبدل setTimeout في PrivateCampaignService
     *
     * @param {string} accountId
     * @param {string} campaignId
     * @param {object} payload    - { phone, message, mediaUrl, mediaType, ... }
     * @param {number} delayMs    - تأخير بالمللي ثانية
     */
    async enqueuePrivateCampaignMessage(accountId, campaignId, payload, delayMs = 0) {
        const queue = this._getQueue(QUEUES.CAMPAIGNS);
        return queue.add('send_private_message', {
            accountId,
            campaignId,
            ...payload,
        }, {
            delay:    delayMs,
            priority: 5,
            jobId:    `private:${campaignId}:${payload.phone}:${Date.now()}`,
            attempts: 1,  // [FIX-2] إرسال مرة واحدة فقط — إلغاء إعادة المحاولة كلياً
        });
    }

    /**
     * إلغاء جميع مهام حملة معينة (عند إيقاف/حذف الحملة)
     * @param {string} campaignId
     */
    async cancelAccountLinkImportJobs(accountId) {
        const queue = this._getQueue(QUEUES.LINK_IMPORTS);
        try {
            const jobs = await queue.getJobs(['waiting', 'delayed', 'prioritized']);
            const toCancel = jobs.filter(job => String(job.data?.accountId || '') === String(accountId));
            for (const job of toCancel) await job.remove();
            console.log(JSON.stringify({ event: 'queue_jobs_cancelled', scope: 'account', accountId, queue: QUEUES.LINK_IMPORTS, count: toCancel.length, at: new Date().toISOString() }));
            return toCancel.length;
        } catch (err) {
            console.error(`[QueueManager] cancelAccountLinkImportJobs error: ${err.message}`);
            return 0;
        }
    }

    async cancelUserLinkImportJobs(userId) {
        const queue = this._getQueue(QUEUES.LINK_IMPORTS);
        try {
            const jobs = await queue.getJobs(['waiting', 'delayed', 'prioritized']);
            const toCancel = jobs.filter(job => String(job.data?.userId || '') === String(userId));
            for (const job of toCancel) await job.remove();
            console.log(JSON.stringify({ event: 'queue_jobs_cancelled', scope: 'user', userId, queue: QUEUES.LINK_IMPORTS, count: toCancel.length, at: new Date().toISOString() }));
            return toCancel.length;
        } catch (err) {
            console.error(`[QueueManager] cancelUserLinkImportJobs error: ${err.message}`);
            return 0;
        }
    }

    async cancelCampaignJobs(campaignId) {
        const queue = this._getQueue(QUEUES.CAMPAIGNS);
        try {
            // إلغاء المهام المؤجلة فقط — الجارية لا يمكن إلغاؤها
            const delayed = await queue.getDelayed();
            const toCancel = delayed.filter(j =>
                j.data.campaignId === campaignId
            );

            for (const job of toCancel) {
                await job.remove();
            }

            console.log(`[QueueManager] Cancelled ${toCancel.length} delayed jobs for campaign ${campaignId}`);
            return toCancel.length;
        } catch (err) {
            console.error(`[QueueManager] cancelCampaignJobs error: ${err.message}`);
            return 0;
        }
    }

    // ══════════════════════════════════════════════════════════════════════════
    // Sync Queue API
    // ══════════════════════════════════════════════════════════════════════════

    /**
     * إضافة مهمة مزامنة مجموعات
     * @param {string} accountId
     * @param {object} options   - { priority, delay }
     */
    async enqueueGroupSync(accountId, options = {}) {
        const queue = this._getQueue(QUEUES.SYNC);
        return queue.add('sync_groups', { accountId }, {
            delay:    options.delay    || 0,
            priority: options.priority || 10,
            jobId:    `sync:groups:${accountId}:${Date.now()}`,
            // منع تكرار المهمة خلال 30 ثانية لنفس الحساب
            deduplication: { id: `sync:groups:${accountId}`, ttl: 30_000 },
        });
    }

    /**
     * إضافة مهمة مزامنة جهات الاتصال
     */
    async enqueueContactSync(accountId, options = {}) {
        const queue = this._getQueue(QUEUES.SYNC);
        return queue.add('sync_contacts', { accountId }, {
            delay:    options.delay    || 0,
            priority: options.priority || 15,
            jobId:    `sync:contacts:${accountId}:${Date.now()}`,
        });
    }

    async enqueuePrivateWhatsAppSync(data, options = {}) {
        const queue = this._getQueue(QUEUES.PRIVATE_WHATSAPP_SYNC);
        const syncAccountId = String(data.syncAccountId || '');
        if (!syncAccountId) throw new Error('syncAccountId is required');
        const jobId = options.jobId || `private-wa-sync-${syncAccountId}`;
        try {
            return await queue.add('sync_private_whatsapp_account', { syncAccountId }, {
                delay: options.delay || 0,
                attempts: options.attempts || 3,
                backoff: options.backoff || { type: 'exponential', delay: 5000 },
                priority: options.priority || 10,
                jobId,
                removeOnComplete: { count: 500, age: 86400 },
                removeOnFail: { count: 500, age: 604800 },
            });
        } catch (error) {
            if (error?.code === 'EJOBEXISTS' || /already exists|duplicated/i.test(error?.message || '')) {
                const existing = await queue.getJob(jobId);
                if (existing) {
                    const state = await existing.getState().catch(() => null);
                    if (state !== 'failed') return existing;
                    await existing.remove().catch(() => {});
                    return await queue.add('sync_private_whatsapp_account', { syncAccountId }, {
                        delay: options.delay || 0,
                        attempts: options.attempts || 3,
                        backoff: options.backoff || { type: 'exponential', delay: 5000 },
                        priority: options.priority || 10,
                        jobId,
                        removeOnComplete: { count: 500, age: 86400 },
                        removeOnFail: { count: 500, age: 604800 },
                    });
                }
            }
            throw error;
        }
    }

    // ══════════════════════════════════════════════════════════════════════════
    // Notifications Queue API
    // ══════════════════════════════════════════════════════════════════════════

    /**
     * إرسال إشعار داخلي للـ frontend عبر Queue
     * @param {object} notification - { type, title, message, userId? }
     */
    async enqueueNotification(notification) {
        const queue = this._getQueue(QUEUES.NOTIFICATIONS);
        return queue.add('send_notification', notification, {
            priority: 1, // أولوية عالية للإشعارات
        });
    }

    async enqueueLinkImportOperation(data, options = {}) {
        const queue = this._getQueue(QUEUES.LINK_IMPORTS);
        const jobId = options.jobId || `link-import-op-${data.operationId}`;
        const payload = {
            delay: options.delay || 0,
            attempts: options.attempts || 1,
            backoff: options.backoff || { type: 'exponential', delay: 15000 },
            priority: options.priority || 5,
            jobId,
            removeOnComplete: options.removeOnComplete ?? { count: 500, age: 86400 },
            removeOnFail: options.removeOnFail ?? { count: 500, age: 604800 },
        };
        try {
            const job = await queue.add('process_link_import_operation', data, payload);
            metrics.recordQueueJobCreated(QUEUES.LINK_IMPORTS);
            return job;
        } catch (error) {
            if (error?.code === 'EJOBEXISTS' || /already exists|duplicated/i.test(error?.message || '')) {
                metrics.recordQueueJobDuplicateBlocked(QUEUES.LINK_IMPORTS);
                const existing = await queue.getJob(jobId);
                if (existing) {
                    try {
                        const state = await existing.getState();
                        if (typeof existing.changeDelay === 'function' && ['delayed','waiting','prioritized'].includes(state)) await existing.changeDelay(Math.max(0, Number(options.delay || 0)));
                    } catch (_) {}
                    return existing;
                }
            }
            throw error;
        }
    }

    async enqueueLinkImportCycle(data, options = {}) {
        const queue = this._getQueue(QUEUES.LINK_IMPORTS);
        const jobId = options.jobId || `link-import-cycle-${data.cycleId || data.taskId}-${data.accountId || 'all'}`;
        try {
            const job = await queue.add('advance_link_import_cycle', data, {
                delay: options.delay || 0,
                attempts: options.attempts || 1,
                backoff: options.backoff || { type: 'exponential', delay: 15000 },
                priority: options.priority || 5,
                jobId,
                removeOnComplete: options.removeOnComplete ?? { count: 200, age: 86400 },
                removeOnFail: options.removeOnFail ?? { count: 200, age: 604800 },
            });
            metrics.recordQueueJobCreated(QUEUES.LINK_IMPORTS);
            return job;
        } catch (error) {
            if (error?.code === 'EJOBEXISTS' || /already exists|duplicated/i.test(error?.message || '')) {
                metrics.recordQueueJobDuplicateBlocked(QUEUES.LINK_IMPORTS);
                const existing = await queue.getJob(jobId);
                if (existing) {
                    try {
                        const state = await existing.getState();
                        if (typeof existing.changeDelay === 'function' && ['delayed','waiting','prioritized'].includes(state)) await existing.changeDelay(Math.max(0, Number(options.delay || 0)));
                    } catch (_) {}
                    return existing;
                }
            }
            throw error;
        }
    }

    async enqueueLinkDiscovery(data, options = {}) {
        const queue = this._getQueue(QUEUES.LINK_DISCOVERY);
        return queue.add('scan_whatsapp_links', data, {
            attempts: options.attempts || 1,
            priority: options.priority || 5,
            // BullMQ custom IDs cannot contain ':'. Use a stable, delimiter-safe ID.
            jobId: options.jobId || `link-discovery-${data.discoveryJobId}`,
            removeOnComplete: { count: 200, age: 86400 },
            removeOnFail: { count: 200, age: 604800 },
        });
    }

    async enqueueLinkImportOutbox(data, options = {}) {
        const queue = this._getQueue(QUEUES.LINK_OUTBOX);
        return queue.add('dispatch_link_import_outbox', data, {
            delay: options.delay || 0,
            attempts: 1,
            priority: 1,
            jobId: options.jobId || `link-outbox-${data.outboxId}`,
            removeOnComplete: { count: 500, age: 86400 },
            removeOnFail: { count: 500, age: 604800 },
        });
    }

    async enqueueTelegramJoin(data, options = {}) {
        const queue = this._getQueue(QUEUES.TELEGRAM_JOINS);
        return queue.add('process_telegram_join', data, {
            delay: options.delay || 0,
            attempts: 1,
            priority: options.priority || 5,
            jobId: options.jobId || `telegram-join-${data.operationId}`,
            removeOnComplete: { count: 500, age: 86400 },
            removeOnFail: { count: 500, age: 604800 },
        });
    }

    async enqueueTelegramDiscovery(data, options = {}) {
        const queue = this._getQueue(QUEUES.TELEGRAM_DISCOVERY);
        return queue.add('process_telegram_discovery', data, {
            delay: options.delay || 0,
            attempts: 1,
            priority: options.priority || 5,
            jobId: options.jobId || `telegram-discovery-${data.discoveryJobId}`,
            removeOnComplete: { count: 100, age: 86400 },
            removeOnFail: { count: 100, age: 604800 },
        });
    }

    async enqueueGeminiAnalysis(data, options = {}) {
        const queue = this._getQueue(QUEUES.GEMINI_ANALYSIS);
        const jobId = options.jobId || `gemini-analysis-${data.accountId}-${data.chatId}-${data.messageId}-${data.ruleId}`.replace(/[^a-zA-Z0-9_-]/g, '_');
        return queue.add('analyze_telegram_smart_conversation', data, {
            attempts: options.attempts ?? Math.max(1, Math.min(5, Number(process.env.GEMINI_MAX_RETRIES || 2) + 1)),
            backoff: options.backoff || { type: 'exponential', delay: 3000 },
            priority: options.priority || 5,
            jobId,
            removeOnComplete: { count: 500, age: 86400 },
            removeOnFail: { count: 500, age: 604800 },
        });
    }

    async enqueueTelegramOutbox(data, options = {}) {
        const queue = this._getQueue(QUEUES.TELEGRAM_OUTBOX);
        return queue.add('dispatch_telegram_outbox', data, {
            delay: options.delay || 0,
            attempts: 1,
            priority: options.priority || 1,
            jobId: options.jobId || `telegram-outbox-${data.outboxId}`,
            removeOnComplete: { count: 500, age: 86400 },
            removeOnFail: { count: 500, age: 604800 },
        });
    }

    // ══════════════════════════════════════════════════════════════════════════
    // Stats & Monitoring
    // ══════════════════════════════════════════════════════════════════════════

    /**
     * إحصائيات جميع الـ Queues — يُستخدم في /health endpoint
     */
    async getStats() {
        const stats = {};
        for (const [name, queue] of Object.entries(this._queues)) {
            try {
                const counts = await queue.getJobCounts(
                    'waiting', 'active', 'delayed', 'failed', 'completed'
                );
                stats[name] = counts;
            } catch (err) {
                stats[name] = { error: err.message };
            }
        }
        return stats;
    }

    /**
     * إحصائيات حملة معينة — عدد المهام المؤجلة/الجارية/المكتملة/الفاشلة
     */
    async getCampaignStats(campaignId) {
        const queue = this._getQueue(QUEUES.CAMPAIGNS);
        try {
            const [waiting, active, delayed, failed, completed] = await Promise.all([
                queue.getWaiting(),
                queue.getActive(),
                queue.getDelayed(),
                queue.getFailed(),
                queue.getCompleted(),
            ]);

            const filter = (jobs) => jobs.filter(j => j.data.campaignId === campaignId).length;

            return {
                waiting:   filter(waiting),
                active:    filter(active),
                delayed:   filter(delayed),
                failed:    filter(failed),
                completed: filter(completed),
            };
        } catch (err) {
            console.error(`[QueueManager] getCampaignStats error: ${err.message}`);
            return null;
        }
    }

    // ══════════════════════════════════════════════════════════════════════════
    // Helpers
    // ══════════════════════════════════════════════════════════════════════════

    _getQueue(name) {
        const queue = this._queues[name];
        if (!queue) {
            throw new Error(`[QueueManager] Queue "${name}" not found. Did you call start()?`);
        }
        return queue;
    }

    /** الوصول المباشر لـ Queue بالاسم (للاستخدامات المتقدمة) */
    getQueue(name) {
        return this._getQueue(name);
    }

    /** أسماء الـ Queues المتاحة */
    static get QUEUES() {
        return QUEUES;
    }
}

// Singleton
module.exports = new QueueManager();
