const DatabaseManager = require('../../database/DatabaseManager');
const crypto = require('crypto');
const JobScheduler = require('../../scheduler/JobScheduler');
const WhatsAppManager = require('../../bot/WhatsAppManager');
const { queryAll: pgQueryAll } = require('../../lib/postgres');

class CampaignService {

    async preflightCheck(accountId, { targetType, targetIds = [], excludeAdmins = true, excludeDuplicates = true }) {
        let totalRaw = 0;
        let finalTargets = new Set();
        let excluded = {
            admin: 0,
            duplicate: 0,
            invalid: 0
        };

        if (targetType === 'group_members') {
            for (const groupId of targetIds) {
                try {
                    const membersInfo = await WhatsAppManager.getGroupMembers(accountId, groupId);
                    totalRaw += membersInfo.total;

                    const sendableByJid = membersInfo.sendable_by_jid || {};
                    const addResolvedTarget = (jid) => {
                        // getGroupMembers may return a LID as the source identifier and
                        // a verified phone JID in sendable_by_jid. Persist the latter so
                        // the worker never schedules an unverified/non-routable target.
                        const resolvedJid = sendableByJid[jid] || jid;
                        if (!resolvedJid) {
                            excluded.invalid++;
                            return;
                        }
                        if (finalTargets.has(resolvedJid)) {
                            if (excludeDuplicates) excluded.duplicate++;
                            return;
                        }
                        finalTargets.add(resolvedJid);
                    };

                    membersInfo.target_jids.forEach(addResolvedTarget);

                    if (excludeAdmins) {
                        excluded.admin += membersInfo.admins.length;
                    } else {
                        membersInfo.admins.forEach(addResolvedTarget);
                    }
                } catch (e) {
                    console.error('Preflight: Failed to get group', groupId, e);
                    excluded.invalid++;
                }
            }
        } else if (targetType === 'lists') {
            const accountDB = await DatabaseManager.getAccountDB(accountId);
            for (const listId of targetIds) {
                const contacts = await accountDB.all(`SELECT * FROM contacts WHERE list_id = $1`, [listId]);
                totalRaw += contacts.length;
                contacts.forEach(c => {
                    if (!c.is_active || c.opted_out) {
                        excluded.invalid++;
                        return;
                    }
                    if (excludeAdmins && c.is_admin) {
                        excluded.admin++;
                        return;
                    }
                    if (finalTargets.has(c.jid) && excludeDuplicates) {
                        excluded.duplicate++;
                    } else {
                        finalTargets.add(c.jid);
                    }
                });
            }
        }

        return {
            totalRaw,
            totalFinal: finalTargets.size,
            excludedCount: totalRaw - finalTargets.size,
            excludedDetails: excluded,
            finalJids: Array.from(finalTargets)
        };
    }

    async createCampaign(accountId, { name, adLibraryId, targetType = 'group_members', targetIds = [], batchSize, intervalSeconds, dailyLimit, scheduledAt, excludeAdmins = true, excludeDuplicates = true }) {
        const accountDB = await DatabaseManager.getAccountDB(accountId);
        const campaignId = crypto.randomUUID();

        // 1. Preflight to get final, verified JIDs
        const preflight = await this.preflightCheck(accountId, { targetType, targetIds, excludeAdmins, excludeDuplicates });
        if (preflight.finalJids.length === 0) {
            throw new Error('لم يتم العثور على أهداف قابلة للإرسال بعد تطبيق قواعد الاستبعاد');
        }

        // 2. Insert Campaign
        await accountDB.run(
            `INSERT INTO campaigns (id, name, ad_library_id, status, target_type, batch_size, interval_seconds, daily_limit, scheduled_at) 
             VALUES ($1, $2, $3, 'draft', $4, $5, $6, $7, $8)`,
            [campaignId, name, adLibraryId, targetType || 'group_members', batchSize || 50, intervalSeconds || 10, dailyLimit || 1000, scheduledAt || new Date().toISOString()]
        );

        // 3. Insert Campaign Targets in batches
        const insertStmt = `INSERT INTO campaign_targets (id, campaign_id, target_jid) VALUES ($1, $2, $3)`;
        for (const jid of preflight.finalJids) {
            await accountDB.run(insertStmt, [crypto.randomUUID(), campaignId, jid]);
        }

        // 4. Record exclusions if needed (simplified for now)
        await this.logEvent(accountDB, campaignId, 'info', `Campaign created. Raw targets: ${preflight.totalRaw}, Excluded: ${preflight.excludedCount}, Final: ${preflight.totalFinal}.`);
        
        return campaignId;
    }

    async startCampaign(accountId, campaignId) {
        const accountDB = await DatabaseManager.getAccountDB(accountId);
        const WhatsAppManager = require('../../bot/WhatsAppManager');

        const campaign = await accountDB.get(`SELECT * FROM campaigns WHERE id = $1`, [campaignId]);
        if (!campaign) throw new Error('الحملة غير موجودة');
        if (campaign.status === 'completed') return { success: false, error: 'الحملة مكتملة بالفعل' };
        if (campaign.status === 'running') return { success: true, queued: 0, alreadyRunning: true };
        if (!JobScheduler.isRunning) throw new Error('خدمة جدولة الحملات غير جاهزة حالياً، حاول بعد لحظات');

        if (!WhatsAppManager.isReady(accountId)) {
            const ready = await WhatsAppManager.waitUntilReady(accountId, 15_000);
            if (!ready) throw new Error('الحساب غير جاهز للإرسال عبر واتساب');
        }

        const targets = await accountDB.all(
            `SELECT * FROM campaign_targets WHERE campaign_id = $1 AND status = 'pending' ORDER BY created_at ASC`,
            [campaignId]
        );
        if (targets.length === 0) {
            await accountDB.run(
                `UPDATE campaigns SET status = 'completed', total_targets = 0, sent_count = 0, failed_count = 0, finished_at = NOW(), updated_at = NOW() WHERE id = $1`,
                [campaignId]
            );
            return { success: false, error: 'لا توجد أهداف معلقة قابلة للإرسال' };
        }

        const ad = campaign.ad_library_id
            ? await accountDB.get(`SELECT * FROM ad_library WHERE id = $1`, [campaign.ad_library_id])
            : null;
        const baseTime = campaign.scheduled_at ? new Date(campaign.scheduled_at).getTime() : Date.now();
        const intervalMs = Math.max(0, Number(campaign.interval_seconds) || 10) * 1000;
        const dailyLimit = Math.max(1, Number(campaign.daily_limit) || 1000);
        const dayMs = 24 * 60 * 60 * 1000;
        const baseTimestamp = Math.max(Date.now(), Number.isFinite(baseTime) ? baseTime : Date.now());
        let intraDayDelayMs = 0;
        const scheduledJobIds = [];

        await accountDB.run(
            `UPDATE campaigns SET status = 'running', started_at = COALESCE(started_at, NOW()), finished_at = NULL, total_targets = $1, sent_count = 0, failed_count = 0, updated_at = NOW() WHERE id = $2`,
            [targets.length, campaignId]
        );
        await accountDB.run(
            `UPDATE campaign_targets SET status = 'queued' WHERE campaign_id = $1 AND status = 'pending'`,
            [campaignId]
        );

        try {
            for (let index = 0; index < targets.length; index++) {
                const indexInDay = index % dailyLimit;
                const dayIndex = Math.floor(index / dailyLimit);
                if (indexInDay === 0) {
                    intraDayDelayMs = 0;
                } else {
                    const jitterSpan = intervalMs * 0.4;
                    intraDayDelayMs += intervalMs + (Math.random() * jitterSpan) - (jitterSpan / 2);
                }
                const executeAt = new Date(baseTimestamp + (dayIndex * dayMs) + Math.max(0, Math.round(intraDayDelayMs)));
                const jobId = await JobScheduler.scheduleTask(
                    accountId,
                    'send_campaign_message',
                    {
                        campaignId,
                        targetId: targets[index].id,
                        to: targets[index].target_jid,
                        adId: ad ? ad.id : null,
                        fallbackContent: ad?.content || 'رسالة الحملة',
                    },
                    executeAt,
                    10,
                    { jobId: `campaign-${campaignId}-${targets[index].id}` }
                );
                scheduledJobIds.push(jobId);
            }
        } catch (scheduleError) {
            await JobScheduler.pauseCampaignJobs(campaignId);
            await accountDB.run(`UPDATE campaign_targets SET status = 'pending' WHERE campaign_id = $1 AND status = 'queued'`, [campaignId]);
            await accountDB.run(`UPDATE campaigns SET status = 'failed', updated_at = NOW() WHERE id = $1`, [campaignId]);
            await this.logEvent(accountDB, campaignId, 'error', `Campaign scheduling failed after ${scheduledJobIds.length}/${targets.length} jobs: ${scheduleError.message}`);
            throw scheduleError;
        }

        await this.logEvent(accountDB, campaignId, 'info', `Campaign started. Queued ${targets.length} messages with ${campaign.interval_seconds || 10}s interval, daily limit ${dailyLimit} (randomized).`);
        return { success: true, queued: targets.length };
    }

    async pauseCampaign(accountId, campaignId) {
        const accountDB = await DatabaseManager.getAccountDB(accountId);
        
        await accountDB.run(`UPDATE campaigns SET status = 'paused', updated_at = NOW() WHERE id = $1`, [campaignId]);

        // Return jobs that were not already executing to pending so a later
        // resume can schedule them exactly once.
        await accountDB.run(`UPDATE campaign_targets SET status = 'pending' WHERE campaign_id = $1 AND status = 'queued'`, [campaignId]);

        // [البند 3] إلغاء فعلي للمهام المعلّقة من BullMQ بدل الاعتماد فقط على
        // أن الـ Worker "سيتخطاها" لاحقاً عند سحبها — هذا يوفر موارد ويمنع
        // أي احتمال تسرّب مهام قديمة بعد إعادة تشغيل الحملة لاحقاً بنفس المعرف.
        const cancelled = await JobScheduler.pauseCampaignJobs(campaignId);
        await this.logEvent(accountDB, campaignId, 'info',
            `Campaign paused. ${cancelled || 0} pending job(s) cancelled from queue.`);
        return { success: true, cancelled: cancelled || 0 };
    }

    async getStats(accountId, campaignId) {
        const accountDB = await DatabaseManager.getAccountDB(accountId);
        
        const total = await accountDB.get(`SELECT COUNT(*) as count FROM campaign_targets WHERE campaign_id = $1`, [campaignId]);
        const sent = await accountDB.get(`SELECT COUNT(*) as count FROM campaign_targets WHERE campaign_id = $1 AND status = 'sent'`, [campaignId]);
        const failed = await accountDB.get(`SELECT COUNT(*) as count FROM campaign_targets WHERE campaign_id = $1 AND status = 'failed'`, [campaignId]);
        const logs = await accountDB.all(`SELECT * FROM campaign_logs WHERE campaign_id = $1 ORDER BY created_at DESC LIMIT 50`, [campaignId]);
        const exclusions = await accountDB.all(`SELECT reason, COUNT(*) as count FROM campaign_exclusions WHERE campaign_id = $1 GROUP BY reason`, [campaignId]);

        return {
            total: parseInt(total?.count || 0, 10),
            sent: parseInt(sent?.count || 0, 10),
            failed: parseInt(failed?.count || 0, 10),
            pending: parseInt(total?.count || 0, 10) - parseInt(sent?.count || 0, 10) - parseInt(failed?.count || 0, 10),
            logs,
            exclusions
        };
    }

    async logEvent(accountDB, campaignId, level, message) {
        const logId = crypto.randomUUID();
        await accountDB.run(
            `INSERT INTO campaign_logs (id, campaign_id, level, message) VALUES ($1, $2, $3, $4)`,
            [logId, campaignId, level, message]
        );
    }
}

module.exports = new CampaignService();
