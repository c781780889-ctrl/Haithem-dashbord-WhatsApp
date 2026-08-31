'use strict';
const express  = require('express');
const router   = express.Router();
const auth     = require('./middleware/auth');
const role     = require('./middleware/roleCheck');
const subscriptionCheck = require('./middleware/subscriptionCheck');
const accountLimitCheck = require('./middleware/accountLimitCheck');

// ── [FIX-15] Per-Route Rate Limiters ─────────────────────────────────────────
const {
    loginLimiter,
    refreshLimiter,
    listAccountsLimiter,
    sendMessageLimiter,
    adminLimiter,
    campaignSendLimiter,
} = require('../lib/RateLimiter');

// ── [FIX-16] Input Validation ──────────────────────────────────────────────
const { validate, schemas } = require('./middleware/validate');

// ── [FIX-14] CSRF Token Endpoint ──────────────────────────────────────────
const { csrfTokenRoute } = require('./middleware/csrf');

// ══════════════════════════════════════════════════════
//  CSRF Token
// ══════════════════════════════════════════════════════
router.get('/auth/csrf-token', csrfTokenRoute);

// ══════════════════════════════════════════════════════
//  AUTH
// ══════════════════════════════════════════════════════
const AuthController = require('./controllers/AuthController');
router.post('/auth/login',           loginLimiter,   validate(schemas.login),          AuthController.login.bind(AuthController));
router.post('/auth/refresh',         refreshLimiter, validate(schemas.refresh),         AuthController.refresh.bind(AuthController));
router.get('/auth/verify',   auth,                                                      AuthController.verify.bind(AuthController));
router.post('/auth/logout',  auth,                                                      AuthController.logout.bind(AuthController));
router.post('/auth/change-password', auth, validate(schemas.changePassword),            AuthController.changePassword.bind(AuthController));

router.post('/auth/mfa/setup',  auth, AuthController.setupMFA.bind(AuthController));
router.post('/auth/mfa/verify', auth, AuthController.verifyMFA.bind(AuthController));
router.delete('/auth/mfa',      auth, AuthController.disableMFA.bind(AuthController));

// ══════════════════════════════════════════════════════
//  SUBSCRIPTION MANAGEMENT
// ══════════════════════════════════════════════════════
const SubscriptionController = require('./controllers/SubscriptionController');

// Admin — إدارة المشتركين
router.post  ('/admin/subscriptions',             auth, role('admin'), SubscriptionController.createSubscriber.bind(SubscriptionController));
router.get   ('/admin/subscriptions',             auth, role('admin'), SubscriptionController.listSubscribers.bind(SubscriptionController));
router.get   ('/admin/subscriptions/:id',         auth, role('admin'), SubscriptionController.getSubscriber.bind(SubscriptionController));
router.patch ('/admin/subscriptions/:id',         auth, role('admin'), SubscriptionController.updateSubscriber.bind(SubscriptionController));
router.post  ('/admin/subscriptions/:id/extend',  auth, role('admin'), SubscriptionController.extendSubscription.bind(SubscriptionController));
router.patch ('/admin/subscriptions/:id/status',  auth, role('admin'), SubscriptionController.setSubscriptionStatus.bind(SubscriptionController));
router.delete('/admin/subscriptions/:id',         auth, role('admin'), SubscriptionController.deleteSubscriber.bind(SubscriptionController));

// User — بيانات اشتراكي
router.get('/subscription/me', auth, SubscriptionController.mySubscription.bind(SubscriptionController));

// Admin — Subscriber Monitoring (sessions)
router.get('/admin/subscriber-monitoring/:id/sessions', auth, role('admin'), SubscriptionController.getSubscriberSessions.bind(SubscriptionController));

// ══════════════════════════════════════════════════════
//  ADMIN — Stats
// ══════════════════════════════════════════════════════
const AdminController = require('./controllers/AdminController');
router.get('/admin/stats',         auth, role('admin'), AdminController.stats.bind(AdminController));
router.get('/admin/activity-logs', auth, role('admin'), AdminController.activityLogs.bind(AdminController));

// ── Admin: حذف الحسابات الوهمية (user_id=null) ───────────────────────────────
const { queryAll, query } = require('../lib/postgres');
const WhatsAppManagerAdmin = require('../bot/WhatsAppManager');
router.delete('/admin/accounts/cleanup-orphans', auth, role('admin'), async (req, res) => {
    try {
        const orphans = await queryAll(
            `SELECT id FROM accounts WHERE user_id IS NULL OR user_id NOT IN (SELECT id FROM users)`
        );
        const ids = orphans.map(r => r.id);
        if (ids.length === 0) return res.json({ success: true, deleted: 0, message: 'لا توجد حسابات وهمية' });
        for (const id of ids) {
            try { await WhatsAppManagerAdmin.fullDeleteAccount(id); } catch (_) {}
            await query(`DELETE FROM session_data WHERE account_id = $1`, [id]).catch(() => {});
            await query(`DELETE FROM accounts WHERE id = $1`, [id]).catch(() => {});
        }
        return res.json({ success: true, deleted: ids.length, ids, message: `تم حذف ${ids.length} حساب وهمي` });
    } catch (err) {
        return res.status(500).json({ success: false, error: err.message });
    }
});

// ── QR Debug: حالة QR لحساب بعينه ────────────────────────────────────────────
router.get('/admin/accounts/:id/qr-debug', auth, role('admin'), async (req, res) => {
    try {
        const { id } = req.params;
        const status = WhatsAppManagerAdmin.getQrStatus(id);
        const isConn = WhatsAppManagerAdmin.isConnecting(id);
        const hasSess = !!WhatsAppManagerAdmin.getSession(id);
        res.json({ success: true, accountId: id, qrStatus: status, isConnecting: isConn, hasSession: hasSess });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// ══════════════════════════════════════════════════════
//  ACCOUNTS
// ══════════════════════════════════════════════════════
const PrivateWhatsAppController = require('./controllers/PrivateWhatsAppController');

// ══════════════════════════════════════════════════════
// PRIVATE WHATSAPP — central contacts + durable sync
// ══════════════════════════════════════════════════════
router.get('/private-whatsapp/dashboard', auth, PrivateWhatsAppController.dashboard.bind(PrivateWhatsAppController));
router.post('/private-whatsapp/sync', auth, campaignSendLimiter, PrivateWhatsAppController.createSync.bind(PrivateWhatsAppController));
router.get('/private-whatsapp/sync/:id', auth, PrivateWhatsAppController.syncStatus.bind(PrivateWhatsAppController));
router.get('/private-whatsapp/contacts', auth, PrivateWhatsAppController.contacts.bind(PrivateWhatsAppController));
router.patch('/private-whatsapp/contacts/:id/consent', auth, PrivateWhatsAppController.updateConsent.bind(PrivateWhatsAppController));
router.get('/private-whatsapp/logs', auth, PrivateWhatsAppController.logs.bind(PrivateWhatsAppController));
router.get('/private-whatsapp/settings', auth, PrivateWhatsAppController.settings.bind(PrivateWhatsAppController));
router.patch('/private-whatsapp/settings', auth, PrivateWhatsAppController.updateSettings.bind(PrivateWhatsAppController));
router.get('/private-whatsapp/publishing/accounts', auth, PrivateWhatsAppController.publishingAccounts.bind(PrivateWhatsAppController));

const AccountController = require('./controllers/AccountController');
const { requireAccountOwnership, requireTelegramAccountOwnership } = require('./middleware/accountOwnership');

router.post('/accounts',                   auth, subscriptionCheck, accountLimitCheck, AccountController.createAccount.bind(AccountController));
router.get('/accounts',                    auth, subscriptionCheck, listAccountsLimiter, AccountController.listAccounts.bind(AccountController));
// Static route must be registered before the dynamic account ownership guard.
router.get('/accounts/summary',            auth, subscriptionCheck, AccountController.getSummary.bind(AccountController));

// Tenant boundary: every /accounts/:accountId/* endpoint must verify ownership
// before any controller can open the per-account schema or execute an action.
router.use('/accounts/:accountId', auth, requireAccountOwnership);
router.get('/accounts/:id',                auth, subscriptionCheck, AccountController.getAccountDetails.bind(AccountController));
router.get('/accounts/:id/stats',          auth, subscriptionCheck, AccountController.getAccountStats.bind(AccountController));
router.get('/accounts/:id/logs',           auth, subscriptionCheck, AccountController.getLogs.bind(AccountController));
router.post('/accounts/:id/connect',       auth, subscriptionCheck, AccountController.connectAccount.bind(AccountController));
router.get('/accounts/:id/qr-status',      auth, subscriptionCheck, AccountController.getQrStatus.bind(AccountController));
router.post('/accounts/:id/connect-pairing', auth, subscriptionCheck, AccountController.connectWithPairing.bind(AccountController));
router.post('/accounts/:id/reset',         auth, subscriptionCheck, AccountController.resetSession.bind(AccountController));
router.post('/accounts/:id/disconnect',    auth, subscriptionCheck, AccountController.disconnectAccount.bind(AccountController));
router.delete('/accounts/:id',             auth, subscriptionCheck, AccountController.deleteAccount.bind(AccountController));
router.patch('/accounts/:id/role',         auth, subscriptionCheck, AccountController.updateRole.bind(AccountController));
router.post('/accounts/:id/start',         auth, subscriptionCheck, AccountController.startTasks.bind(AccountController));
router.post('/accounts/:id/stop',          auth, subscriptionCheck, AccountController.stopTasks.bind(AccountController));
router.post('/accounts/:id/restart',       auth, subscriptionCheck, AccountController.restartTasks.bind(AccountController));
router.post('/accounts/:id/test',          auth, subscriptionCheck, AccountController.testConnection.bind(AccountController));

// ── Business API Settings ─────────────────────────────────────────────────────
const BusinessAPIController = require('./controllers/BusinessAPIController');
router.get ('/accounts/:id/business-api',       auth, BusinessAPIController.getSettings.bind(BusinessAPIController));
router.post('/accounts/:id/business-api',       auth, BusinessAPIController.saveSettings.bind(BusinessAPIController));
router.post('/accounts/:id/business-api/test',  auth, BusinessAPIController.testConnection.bind(BusinessAPIController));
router.post('/accounts/:id/business-api/send',  auth, BusinessAPIController.sendMessage.bind(BusinessAPIController));

// ── WhatsApp Webhook (بدون auth — Meta يرسل مباشرة) ─────────────────────────
router.get ('/webhook/whatsapp/:accountId', BusinessAPIController.webhookVerify.bind(BusinessAPIController));
router.post('/webhook/whatsapp/:accountId', BusinessAPIController.webhookReceive.bind(BusinessAPIController));



const GroupController = require('./controllers/GroupController');

// ── [GROUPS-LIVE] نظرة شاملة على كل المجموعات من كل الحسابات المتصلة ────────
// ⚠️ مسارات ثابتة بدون :accountId — يجب أن تبقى منفصلة عن مسارات
//    /accounts/:accountId/groups أدناه (لا تعارض بينها لأن البادئة مختلفة).
router.get('/groups/live',       auth, GroupController.getLiveOverview.bind(GroupController));
router.post('/groups/sync-all',  auth, GroupController.syncAllAccounts.bind(GroupController));

router.get('/accounts/:accountId/groups',                        auth, GroupController.getGroups.bind(GroupController));
router.get('/accounts/:accountId/groups/categories',             auth, GroupController.getGroupsByCategory.bind(GroupController));
router.post('/accounts/:accountId/groups/sync',                  auth, GroupController.syncGroups.bind(GroupController));
router.get('/accounts/:accountId/groups/sync-settings',          auth, GroupController.getSyncSettings.bind(GroupController));
router.put('/accounts/:accountId/groups/sync-settings',          auth, GroupController.updateSyncSettings.bind(GroupController));
router.get('/accounts/:accountId/groups/:groupId/members',       auth, GroupController.getGroupMembers.bind(GroupController));

// ══════════════════════════════════════════════════════
//  الجزء الخامس — نشر لأعضاء / تصدير / استثناءات
// ══════════════════════════════════════════════════════
router.post('/accounts/:accountId/groups/members/preview',       auth, GroupController.getMembersForPublish.bind(GroupController));
router.post('/accounts/:accountId/groups/members/publish', sendMessageLimiter,       auth, GroupController.publishToMembers.bind(GroupController));
router.post('/accounts/:accountId/groups/members/export-multi',  auth, GroupController.exportMultipleGroupsMembers.bind(GroupController));
router.get('/accounts/:accountId/groups/:groupId/members/export',auth, GroupController.exportMembers.bind(GroupController));
router.get('/accounts/:accountId/groups/saved-members',          auth, GroupController.getSavedMembers.bind(GroupController));
router.get('/accounts/:accountId/groups/exclusions',             auth, GroupController.getExclusions.bind(GroupController));
router.post('/accounts/:accountId/groups/exclusions',            auth, GroupController.addExclusions.bind(GroupController));
router.delete('/accounts/:accountId/groups/exclusions',          auth, GroupController.clearExclusions.bind(GroupController));
router.delete('/accounts/:accountId/groups/exclusions/:exclusionId', auth, GroupController.deleteExclusion.bind(GroupController));

// ══════════════════════════════════════════════════════
//  CAMPAIGNS
// ══════════════════════════════════════════════════════
const CampaignController = require('./controllers/CampaignController');
router.post('/accounts/:accountId/campaigns',                   auth, campaignSendLimiter, CampaignController.createCampaign.bind(CampaignController));
router.post('/accounts/:accountId/campaigns/preflight',         auth, campaignSendLimiter, CampaignController.preflightCheck.bind(CampaignController));
router.post('/accounts/:accountId/campaigns/:campaignId/start', auth, campaignSendLimiter, CampaignController.startCampaign.bind(CampaignController));
router.post('/accounts/:accountId/campaigns/:campaignId/pause', auth, campaignSendLimiter, CampaignController.pauseCampaign.bind(CampaignController));
router.delete('/accounts/:accountId/campaigns/:campaignId',   auth, CampaignController.deleteCampaign.bind(CampaignController));
router.get('/accounts/:accountId/campaigns/:campaignId/stats',  auth, CampaignController.getStats.bind(CampaignController));
router.get('/accounts/:accountId/campaigns',                    auth, CampaignController.listCampaigns.bind(CampaignController));

// ══════════════════════════════════════════════════════
//  BROADCAST — FIX: use actual method names
// ══════════════════════════════════════════════════════
const BroadcastController = require('./controllers/BroadcastController');
router.get('/accounts/:accountId/broadcast/schedules',            auth, BroadcastController.getAll.bind(BroadcastController));
router.post('/accounts/:accountId/broadcast/schedules',           auth, BroadcastController.create.bind(BroadcastController));
router.put('/accounts/:accountId/broadcast/schedules/:id',        auth, async (req, res) => res.status(501).json({ success: false, error: 'Not implemented' }));
router.delete('/accounts/:accountId/broadcast/schedules/:id',     auth, BroadcastController.delete.bind(BroadcastController));
router.post('/accounts/:accountId/broadcast/schedules/:id/pause', auth, BroadcastController.pause.bind(BroadcastController));
router.post('/accounts/:accountId/broadcast/schedules/:id/start', auth, BroadcastController.start.bind(BroadcastController));
router.post('/accounts/:accountId/broadcast/direct',              auth, BroadcastController.directPublish.bind(BroadcastController));
router.get('/accounts/:accountId/broadcast/log',                  auth, BroadcastController.getDirectPublishLog.bind(BroadcastController));


// ── Schedule Monitor ──────────────────────────────────────────────────────────
const ScheduleMonitorController = require('./controllers/ScheduleMonitorController');
router.get('/accounts/:accountId/broadcast/monitor',              auth, ScheduleMonitorController.getMonitor.bind(ScheduleMonitorController));
router.post('/accounts/:accountId/broadcast/publish-now',         auth, ScheduleMonitorController.publishNow.bind(ScheduleMonitorController));

// ══════════════════════════════════════════════════════
//  AD LIBRARY — FIX: use actual method names
// ══════════════════════════════════════════════════════
const AdLibraryController = require('./controllers/AdLibraryController');
router.get('/accounts/:accountId/ads',              auth, AdLibraryController.getAll.bind(AdLibraryController));
router.post('/accounts/:accountId/ads',             auth, AdLibraryController.create.bind(AdLibraryController));
router.put('/accounts/:accountId/ads/:id',          auth, AdLibraryController.update.bind(AdLibraryController));
router.delete('/accounts/:accountId/ads/:id',       auth, AdLibraryController.delete.bind(AdLibraryController));
router.patch('/accounts/:accountId/ads/:id/toggle', auth, async (req, res) => {
    // Toggle is_active by flipping current value
    try {
        const { accountId, id } = req.params;
        const DatabaseManager = require('../../database/DatabaseManager');
        const accountDB = await DatabaseManager.getAccountDB(accountId);
        const ad = await accountDB.get(`SELECT is_active FROM ad_library WHERE id = $1`, [id]);
        if (!ad) return res.status(404).json({ success: false, error: 'الإعلان غير موجود' });
        await accountDB.run(`UPDATE ad_library SET is_active = $1, updated_at = NOW() WHERE id = $2`, [ad.is_active ? 0 : 1, id]);
        res.json({ success: true, is_active: !ad.is_active });
    } catch (err) {
        res.status(500).json({ success: false, error: 'Internal Server Error' });
    }
});

// ══════════════════════════════════════════════════════
//  SCHEDULE — FIX: use actual method names
// ══════════════════════════════════════════════════════
const ScheduleController = require('./controllers/ScheduleController');
router.get('/accounts/:accountId/schedules',              auth, ScheduleController.getAll.bind(ScheduleController));
router.post('/accounts/:accountId/schedules',             auth, ScheduleController.createSchedule.bind(ScheduleController));
router.put('/accounts/:accountId/schedules/:id',          auth, async (req, res) => res.status(501).json({ success: false, error: 'Not implemented' }));
router.delete('/accounts/:accountId/schedules/:id',       auth, ScheduleController.deleteSchedule.bind(ScheduleController));
router.patch('/accounts/:accountId/schedules/:id/status', auth, async (req, res) => {
    const { status } = req.body;
    if (status === 'active') return ScheduleController.startSchedule(req, res);
    return ScheduleController.pauseSchedule(req, res);
});


// ══════════════════════════════════════════════════════
//  DIAGNOSTICS — نظام التشخيص الاحترافي
// ══════════════════════════════════════════════════════
const DiagnosticController = require('./controllers/DiagnosticController');
router.get ('/accounts/:id/diagnostics',         auth, DiagnosticController.getLastDiagnostic.bind(DiagnosticController));
router.get ('/accounts/:id/diagnostics/history', auth, DiagnosticController.getDiagnosticHistory.bind(DiagnosticController));
router.post('/accounts/:id/diagnostics/scan',    auth, DiagnosticController.runFullScan.bind(DiagnosticController));
router.get ('/admin/diagnostics',                auth, role('admin'), DiagnosticController.getAllDiagnostics.bind(DiagnosticController));
router.get ('/admin/diagnostics/stats',          auth, role('admin'), DiagnosticController.getDiagnosticStats.bind(DiagnosticController));

// ── Phase 2: Runtime Analysis ─────────────────────────────────────────────
const RuntimeController = require('./controllers/RuntimeController');
router.get ('/accounts/:id/runtime/report',                             auth, RuntimeController.getFullReport.bind(RuntimeController));
router.get ('/accounts/:id/runtime/attempts',                           auth, RuntimeController.getRecentAttempts.bind(RuntimeController));
router.get ('/accounts/:id/runtime/attempts/:attemptId/timeline',       auth, RuntimeController.getAttemptTimeline.bind(RuntimeController));
router.get ('/accounts/:id/runtime/errors',                             auth, RuntimeController.getErrorPatterns.bind(RuntimeController));
router.get ('/accounts/:id/runtime/stats',                              auth, RuntimeController.getConnectionStats.bind(RuntimeController));
router.get ('/admin/runtime/stats',                                     auth, role('admin'), RuntimeController.getSystemStats.bind(RuntimeController));

// ── Phase 3: Connection Cycle Analysis ───────────────────────────────────────
const CycleController = require('./controllers/ConnectionCycleController');
router.get ('/accounts/:id/cycle/latest',                               auth, CycleController.getLatestCycle.bind(CycleController));
router.get ('/accounts/:id/cycle/history',                              auth, CycleController.getRecentCycles.bind(CycleController));
router.get ('/accounts/:id/cycle/stats',                                auth, CycleController.getCycleStats.bind(CycleController));
router.get ('/accounts/:id/cycle/anomalies',                            auth, CycleController.getAnomalies.bind(CycleController));
router.get ('/accounts/:id/cycle/attempts/:attemptId',                  auth, CycleController.getCycleByAttempt.bind(CycleController));
router.get ('/accounts/:id/cycle/attempts/:attemptId/report',           auth, CycleController.getCycleReport.bind(CycleController));
router.get ('/admin/cycle/stats',                                       auth, role('admin'), CycleController.getSystemStats.bind(CycleController));

// ── Phase 4: Database Analysis ────────────────────────────────────────────────
const DatabaseAnalyzerController = require('./controllers/DatabaseAnalyzerController');
const PostgresStorageController = require('./controllers/PostgresStorageController');
router.get ('/accounts/:id/db/health',          auth,        DatabaseAnalyzerController.getAccountDbHealth.bind(DatabaseAnalyzerController));
router.get ('/accounts/:id/db/check',           auth,        DatabaseAnalyzerController.quickAccountCheck.bind(DatabaseAnalyzerController));
router.get ('/admin/db/report',                 auth, role('admin'),   DatabaseAnalyzerController.getFullReport.bind(DatabaseAnalyzerController));
router.get ('/admin/db/contradictions',         auth, role('admin'),   DatabaseAnalyzerController.getContradictions.bind(DatabaseAnalyzerController));
router.get ('/admin/db/bloat',                  auth, role('admin'),   DatabaseAnalyzerController.getBloatReport.bind(DatabaseAnalyzerController));
router.get ('/admin/db/performance',            auth, role('admin'),   DatabaseAnalyzerController.getPerformanceReport.bind(DatabaseAnalyzerController));
router.get ('/admin/db/stats',                  auth, role('admin'),   DatabaseAnalyzerController.getStats.bind(DatabaseAnalyzerController));
router.get ('/admin/postgres-storage/status',     auth, role('admin'),   PostgresStorageController.status.bind(PostgresStorageController));
router.post('/admin/postgres-storage/check',      auth, role('admin'),   PostgresStorageController.check.bind(PostgresStorageController));
router.get ('/admin/postgres-storage/audit',      auth, role('admin'),   PostgresStorageController.audit.bind(PostgresStorageController));

// ── Phase 5: Redis Analysis ───────────────────────────────────────────────────
const RedisAnalyzerController = require('./controllers/RedisAnalyzerController');
router.get ('/accounts/:id/redis/rate-keys',    auth,        RedisAnalyzerController.getAccountRateKeys.bind(RedisAnalyzerController));
router.get ('/admin/redis/report',              auth, role('admin'),   RedisAnalyzerController.getFullReport.bind(RedisAnalyzerController));
router.get ('/admin/redis/connection',          auth, role('admin'),   RedisAnalyzerController.getConnectionInfo.bind(RedisAnalyzerController));
router.get ('/admin/redis/rate-keys',           auth, role('admin'),   RedisAnalyzerController.getAllRateKeys.bind(RedisAnalyzerController));
router.get ('/admin/redis/jwt-blacklist',       auth, role('admin'),   RedisAnalyzerController.getJWTBlacklist.bind(RedisAnalyzerController));
router.get ('/admin/redis/bullmq',              auth, role('admin'),   RedisAnalyzerController.getBullMQStatus.bind(RedisAnalyzerController));
router.get ('/admin/redis/no-ttl',              auth, role('admin'),   RedisAnalyzerController.getNoTTLKeys.bind(RedisAnalyzerController));
router.get ('/admin/redis/memory',              auth, role('admin'),   RedisAnalyzerController.getMemoryDistribution.bind(RedisAnalyzerController));

// ── Phase 6: Session Deep Analysis ───────────────────────────────────────────
const SessionAnalyzerController = require('./controllers/SessionAnalyzerController');
router.get ('/accounts/:id/session/report',        auth,      SessionAnalyzerController.getAccountReport.bind(SessionAnalyzerController));
router.get ('/accounts/:id/session/credentials',   auth,      SessionAnalyzerController.getCredentials.bind(SessionAnalyzerController));
router.get ('/accounts/:id/session/signal-keys',   auth,      SessionAnalyzerController.getSignalKeys.bind(SessionAnalyzerController));
router.get ('/accounts/:id/session/stats',         auth,      SessionAnalyzerController.getAccountStats.bind(SessionAnalyzerController));
router.get ('/admin/session/report',               auth, role('admin'),  SessionAnalyzerController.getSystemReport.bind(SessionAnalyzerController));
router.get ('/admin/session/stats',                auth, role('admin'),  SessionAnalyzerController.getSystemStats.bind(SessionAnalyzerController));
router.get ('/admin/session/stale',                auth, role('admin'),  SessionAnalyzerController.getStaleAccounts.bind(SessionAnalyzerController));

// ── المرحلة السابعة — QR Code Analysis ───────────────────────────────────
const QRAnalyzerController = require('./controllers/QRAnalyzerController');

// Per-Account
router.get ('/accounts/:id/qr/report',   auth,      QRAnalyzerController.getAccountReport.bind(QRAnalyzerController));
router.get ('/accounts/:id/qr/stats',    auth,      QRAnalyzerController.getAccountStats.bind(QRAnalyzerController));
router.get ('/accounts/:id/qr/history',  auth,      QRAnalyzerController.getAccountHistory.bind(QRAnalyzerController));
router.get ('/accounts/:id/qr/latency',  auth,      QRAnalyzerController.getLatency.bind(QRAnalyzerController));

// Admin
router.get ('/admin/qr/report',          auth, role('admin'),  QRAnalyzerController.getSystemReport.bind(QRAnalyzerController));
router.get ('/admin/qr/stats',           auth, role('admin'),  QRAnalyzerController.getSystemStats.bind(QRAnalyzerController));
router.get ('/admin/qr/slow',            auth, role('admin'),  QRAnalyzerController.getSlowAccounts.bind(QRAnalyzerController));

// ── المرحلة الثامنة — Pairing Code Analysis ──────────────────────────────
const PairingCodeAnalyzerController = require('./controllers/PairingCodeAnalyzerController');

// Per-Account
router.get ('/accounts/:id/pairing/report',   auth,      PairingCodeAnalyzerController.getAccountReport.bind(PairingCodeAnalyzerController));
router.get ('/accounts/:id/pairing/stats',    auth,      PairingCodeAnalyzerController.getAccountStats.bind(PairingCodeAnalyzerController));
router.get ('/accounts/:id/pairing/history',  auth,      PairingCodeAnalyzerController.getAccountHistory.bind(PairingCodeAnalyzerController));
router.get ('/accounts/:id/pairing/latency',  auth,      PairingCodeAnalyzerController.getLatency.bind(PairingCodeAnalyzerController));

// Admin
router.get ('/admin/pairing/report',          auth, role('admin'),  PairingCodeAnalyzerController.getSystemReport.bind(PairingCodeAnalyzerController));
router.get ('/admin/pairing/stats',           auth, role('admin'),  PairingCodeAnalyzerController.getSystemStats.bind(PairingCodeAnalyzerController));
router.get ('/admin/pairing/problematic',     auth, role('admin'),  PairingCodeAnalyzerController.getProblematicAccounts.bind(PairingCodeAnalyzerController));

// ── المرحلة التاسعة — Baileys Deep Analysis ──────────────────────────────
const BaileysAnalyzerController = require('./controllers/BaileysAnalyzerController');

// Per-Account
router.get ('/accounts/:id/baileys/report',           auth,      BaileysAnalyzerController.getAccountReport.bind(BaileysAnalyzerController));
router.get ('/accounts/:id/baileys/stats',            auth,      BaileysAnalyzerController.getAccountStats.bind(BaileysAnalyzerController));
router.get ('/accounts/:id/baileys/history',          auth,      BaileysAnalyzerController.getAccountHistory.bind(BaileysAnalyzerController));
router.get ('/accounts/:id/baileys/events',           auth,      BaileysAnalyzerController.getEventBreakdown.bind(BaileysAnalyzerController));
router.get ('/accounts/:id/baileys/messages/errors',  auth,      BaileysAnalyzerController.getMessageErrors.bind(BaileysAnalyzerController));

// Admin
router.get ('/admin/baileys/report',                  auth, role('admin'),  BaileysAnalyzerController.getSystemReport.bind(BaileysAnalyzerController));
router.get ('/admin/baileys/stats',                   auth, role('admin'),  BaileysAnalyzerController.getSystemStats.bind(BaileysAnalyzerController));
router.get ('/admin/baileys/problematic',             auth, role('admin'),  BaileysAnalyzerController.getProblematicAccounts.bind(BaileysAnalyzerController));

// ── المرحلة العاشرة — Infrastructure Analysis ─────────────────────────────
const InfrastructureController = require('./controllers/InfrastructureController');

router.get ('/admin/infra/report',           auth, role('admin'),  InfrastructureController.getSystemReport.bind(InfrastructureController));
router.get ('/admin/infra/stats',            auth, role('admin'),  InfrastructureController.getQuickStats.bind(InfrastructureController));
router.get ('/admin/infra/postgres',         auth, role('admin'),  InfrastructureController.getPostgresHealth.bind(InfrastructureController));
router.get ('/admin/infra/postgres/tables',  auth, role('admin'),  InfrastructureController.getPostgresTableStats.bind(InfrastructureController));
router.get ('/admin/infra/redis',            auth, role('admin'),  InfrastructureController.getRedisHealth.bind(InfrastructureController));
router.get ('/admin/infra/redis/keys',       auth, role('admin'),  InfrastructureController.getRedisKeyDistribution.bind(InfrastructureController));
router.get ('/admin/infra/bullmq',           auth, role('admin'),  InfrastructureController.getBullMQStats.bind(InfrastructureController));
router.get ('/admin/infra/process',          auth, role('admin'),  InfrastructureController.getProcessInfo.bind(InfrastructureController));


// ══════════════════════════════════════════════════════
//  KEYWORD MONITORING
// ══════════════════════════════════════════════════════
const KWController = require('./controllers/KeywordMonitoringController');

// الكلمات المفتاحية
router.get   ('/keywords',              auth, KWController.listKeywords.bind(KWController));
router.post  ('/keywords',              auth, KWController.addKeyword.bind(KWController));
router.patch ('/keywords/:id',          auth, KWController.updateKeyword.bind(KWController));
router.delete('/keywords/:id',          auth, KWController.deleteKeyword.bind(KWController));
router.get   ('/keywords/export',       auth, KWController.exportKeywords.bind(KWController));
router.post  ('/keywords/import',       auth, KWController.importKeywords.bind(KWController));

// التنبيهات
router.get   ('/keyword-alerts',        auth, KWController.listAlerts.bind(KWController));
router.patch ('/keyword-alerts/:id',    auth, KWController.updateAlertStatus.bind(KWController));
router.delete('/keyword-alerts/:id',    auth, KWController.deleteAlert.bind(KWController));
router.post  ('/keyword-alerts/:id/note', auth, KWController.addAlertNote.bind(KWController));

// الإحصائيات والإعدادات والسجل
router.get   ('/keywords/stats',        auth, KWController.getStats.bind(KWController));
router.get   ('/keywords/settings',     auth, KWController.getSettings.bind(KWController));
router.post  ('/keywords/settings',     auth, KWController.saveSettings.bind(KWController));
router.get   ('/keywords/activity-log', auth, KWController.getActivityLog.bind(KWController));
router.get   ('/keywords/notifications', auth, KWController.getNotifications.bind(KWController));
router.patch ('/keywords/notifications/:id/read', auth, KWController.markNotificationRead.bind(KWController));
router.get   ('/keywords/health', auth, KWController.getHealth.bind(KWController));
router.get   ('/keywords/accounts', auth, KWController.getAccounts.bind(KWController));
router.patch ('/keyword-alerts/:id/flag', auth, KWController.setFlag.bind(KWController));
router.post  ('/keyword-alerts/:id/reply', auth, KWController.sendReply.bind(KWController));

// ══════════════════════════════════════════════════════
//  AI AUTOMATION CENTER
// ══════════════════════════════════════════════════════
const AIAutomationController = require('./controllers/AIAutomationController');
router.get('/ai-center/dashboard', auth, AIAutomationController.dashboard.bind(AIAutomationController));
router.get('/ai-center/tools', auth, AIAutomationController.tools.bind(AIAutomationController));
router.get('/ai-center/agents', auth, AIAutomationController.agents.bind(AIAutomationController));
router.post('/ai-center/agents', auth, AIAutomationController.createAgent.bind(AIAutomationController));
router.patch('/ai-center/agents/:id', auth, AIAutomationController.toggleAgent.bind(AIAutomationController));
router.get('/ai-center/workflows', auth, AIAutomationController.workflows.bind(AIAutomationController));
router.post('/ai-center/workflows', auth, AIAutomationController.createWorkflow.bind(AIAutomationController));
router.patch('/ai-center/workflows/:id', auth, AIAutomationController.updateWorkflow.bind(AIAutomationController));
router.patch('/ai-center/workflows/:id/status', auth, AIAutomationController.toggleWorkflow.bind(AIAutomationController));
router.get('/ai-center/tasks', auth, AIAutomationController.tasks.bind(AIAutomationController));
router.post('/ai-center/tasks', auth, AIAutomationController.createTask.bind(AIAutomationController));
router.patch('/ai-center/tasks/:id', auth, AIAutomationController.controlTask.bind(AIAutomationController));
router.get('/ai-center/approvals', auth, AIAutomationController.approvals.bind(AIAutomationController));
router.patch('/ai-center/approvals/:id', auth, AIAutomationController.decideApproval.bind(AIAutomationController));
router.get('/ai-center/alerts', auth, AIAutomationController.alerts.bind(AIAutomationController));
router.patch('/ai-center/alerts/:id/resolve', auth, AIAutomationController.resolveAlert.bind(AIAutomationController));
router.post('/ai-center/events', auth, AIAutomationController.event.bind(AIAutomationController));

// ══════════════════════════════════════════════════════
//  TELEGRAM SYSTEM
// ══════════════════════════════════════════════════════
const TelegramController = require("./controllers/TelegramController");
const TelegramKeywordController = require("./controllers/TelegramKeywordController");
const TelegramSmartConversationController = require("./controllers/TelegramSmartConversationController");
const TelegramAuthController = require("./controllers/TelegramAuthController");
const TelegramJoinAutomationController = require("./controllers/TelegramJoinAutomationController");

// ── حسابات تيليجرام (تتطلب مصادقة) ────────────────
// ⚠️ المسارات الثابتة أولاً (workers/stats) قبل /:id
router.post  ("/telegram/accounts",                    auth, TelegramController.addAccount.bind(TelegramController));
router.post  ("/telegram/auth/request-code",             auth, TelegramAuthController.requestCode.bind(TelegramAuthController));
router.post  ("/telegram/auth/:id/verify-code",           auth, TelegramAuthController.verifyCode.bind(TelegramAuthController));
router.post  ("/telegram/auth/:id/verify-2fa",            auth, TelegramAuthController.verify2fa.bind(TelegramAuthController));
router.get   ("/telegram/auth/:id/status",                auth, TelegramAuthController.status.bind(TelegramAuthController));
router.delete("/telegram/auth/:id",                       auth, TelegramAuthController.cancel.bind(TelegramAuthController));
router.get   ("/telegram/accounts",                    auth, TelegramController.listAccounts.bind(TelegramController));
router.get   ("/telegram/accounts/workers",            auth, TelegramController.getWorkersStatus.bind(TelegramController));
router.get   ("/telegram/accounts/stats",              auth, TelegramController.getStats.bind(TelegramController));
// Static Telegram routes are above; protect every dynamic account operation below.
router.use('/telegram/accounts/:id', auth, requireTelegramAccountOwnership);
router.get   ("/telegram/accounts/:id",                auth, TelegramController.getAccount.bind(TelegramController));
router.put   ("/telegram/accounts/:id",                auth, TelegramController.updateAccount.bind(TelegramController));
router.delete("/telegram/accounts/:id",                auth, TelegramController.deleteAccount.bind(TelegramController));
router.post  ("/telegram/accounts/:id/start",          auth, TelegramController.startWorker.bind(TelegramController));
router.post  ("/telegram/accounts/:id/stop",          auth, TelegramController.stopWorker.bind(TelegramController));

// ── كلمات مفتاحية تيليجرام ───────────────────────────
router.get   ("/telegram-smart-conversations/dashboard", auth, TelegramSmartConversationController.dashboard);
router.get   ("/telegram-smart-conversations/results", auth, TelegramSmartConversationController.results);
router.post  ("/telegram-smart-conversations/rules", auth, TelegramSmartConversationController.createRule);
router.put   ("/telegram-smart-conversations/rules/:id", auth, TelegramSmartConversationController.updateRule);
router.patch ("/telegram-smart-conversations/rules/:id/status", auth, TelegramSmartConversationController.toggleRule);
router.delete("/telegram-smart-conversations/rules/:id", auth, TelegramSmartConversationController.deleteRule);
router.patch ("/telegram-smart-conversations/results/:id", auth, TelegramSmartConversationController.updateResult);
router.delete("/telegram-smart-conversations/results/:id", auth, TelegramSmartConversationController.deleteResult);
router.post  ("/telegram-smart-conversations/results/:id/ignore", auth, TelegramSmartConversationController.ignoreMessage);
router.post  ("/telegram-smart-conversations/results/:id/open", auth, TelegramSmartConversationController.openMessage);
router.post  ("/telegram-smart-conversations/results/:id/delete-message", auth, TelegramSmartConversationController.deleteMessage);
router.post  ("/telegram-smart-conversations/results/:id/open-private", auth, TelegramSmartConversationController.openPrivateChat);
router.post  ("/telegram-smart-conversations/results/:id/block-user", auth, TelegramSmartConversationController.blockUser);
router.post  ("/telegram-smart-conversations/blocked-users/:telegramUserId/unblock", auth, TelegramSmartConversationController.unblockUser);
router.post  ("/telegram-smart-conversations/results/:id/block-group", auth, TelegramSmartConversationController.blockGroup);
router.post  ("/telegram-smart-conversations/blocked-groups/:groupId/unblock", auth, TelegramSmartConversationController.unblockGroup);
router.post  ("/telegram-smart-conversations/test", auth, TelegramSmartConversationController.testRule);
router.get   ("/telegram-smart-conversations/ai/status", auth, TelegramSmartConversationController.geminiStatus);
router.get   ("/telegram-smart-conversations/ai/health", auth, TelegramSmartConversationController.geminiHealth);
router.post  ("/telegram-smart-conversations/ai/test", auth, TelegramSmartConversationController.testGemini);
router.patch ("/telegram-smart-conversations/settings", auth, TelegramSmartConversationController.updateSettings);
router.get   ("/telegram-smart-conversations/notifications", auth, TelegramSmartConversationController.notifications);
router.patch ("/telegram-smart-conversations/notifications/read-all", auth, TelegramSmartConversationController.markAllNotificationsRead);
router.patch ("/telegram-smart-conversations/notifications/:id/read", auth, TelegramSmartConversationController.markNotificationRead);
router.get   ("/telegram-keywords/dashboard",          auth, TelegramKeywordController.dashboard.bind(TelegramKeywordController));
router.patch ("/telegram-keywords/chats/pin",            auth, TelegramKeywordController.toggleChatPin.bind(TelegramKeywordController));
router.get   ("/telegram-keywords/accounts",           auth, TelegramKeywordController.accounts.bind(TelegramKeywordController));

// ── أتمتة الانضمام إلى روابط Telegram (Telegram-native) ─────────────────────
router.get   ("/telegram/join-automation-v2/dashboard", auth, TelegramJoinAutomationController.dashboard.bind(TelegramJoinAutomationController));
router.get   ("/telegram/join-automation-v2/health", auth, TelegramJoinAutomationController.health.bind(TelegramJoinAutomationController));
router.get   ("/telegram/join-automation-v2/global-status", auth, TelegramJoinAutomationController.globalStatus.bind(TelegramJoinAutomationController));
router.post  ("/telegram/join-automation-v2/global-status", auth, TelegramJoinAutomationController.globalStatus.bind(TelegramJoinAutomationController));
router.get   ("/telegram/join-automation-v2/global-dashboard", auth, role('admin'), TelegramJoinAutomationController.globalDashboard.bind(TelegramJoinAutomationController));
router.get   ("/telegram/join-automation-v2/settings", auth, TelegramJoinAutomationController.settings.bind(TelegramJoinAutomationController));
router.patch ("/telegram/join-automation-v2/settings", auth, TelegramJoinAutomationController.updateSettings.bind(TelegramJoinAutomationController));
router.get   ("/telegram/join-automation-v2/links", auth, TelegramJoinAutomationController.links.bind(TelegramJoinAutomationController));
router.get   ("/telegram/join-automation-v2/report", auth, TelegramJoinAutomationController.report.bind(TelegramJoinAutomationController));
router.post  ("/telegram/join-automation-v2/search", auth, TelegramJoinAutomationController.search.bind(TelegramJoinAutomationController));
router.post  ("/telegram/join-automation-v2/links/preview", auth, TelegramJoinAutomationController.previewLinks.bind(TelegramJoinAutomationController));
router.post  ("/telegram/join-automation-v2/links/import", auth, TelegramJoinAutomationController.importLinks.bind(TelegramJoinAutomationController));
router.get   ("/telegram/join-automation-v2/export", auth, TelegramJoinAutomationController.exportData.bind(TelegramJoinAutomationController));
router.get   ("/telegram/join-automation-v2/notifications", auth, TelegramJoinAutomationController.notifications.bind(TelegramJoinAutomationController));
router.patch ("/telegram/join-automation-v2/notifications/:notificationId/read", auth, TelegramJoinAutomationController.markNotificationRead.bind(TelegramJoinAutomationController));
router.patch ("/telegram/join-automation-v2/accounts/:accountId/role", auth, TelegramJoinAutomationController.setAccountRole.bind(TelegramJoinAutomationController));
router.post  ("/telegram/join-automation-v2/jobs", auth, TelegramJoinAutomationController.createJob.bind(TelegramJoinAutomationController));
router.get   ("/telegram/join-automation-v2/jobs/:jobId", auth, TelegramJoinAutomationController.job.bind(TelegramJoinAutomationController));
router.patch ("/telegram/join-automation-v2/jobs/:jobId", auth, TelegramJoinAutomationController.controlJob.bind(TelegramJoinAutomationController));
router.delete("/telegram/join-automation-v2/links", auth, TelegramJoinAutomationController.archiveAllLinks.bind(TelegramJoinAutomationController));
router.patch ("/telegram/join-automation-v2/links/:linkId/archive", auth, TelegramJoinAutomationController.archiveLink.bind(TelegramJoinAutomationController));
router.get   ("/telegram-keywords/workers",            auth, TelegramKeywordController.worker.bind(TelegramKeywordController));
router.post  ("/telegram-keywords",                    auth, TelegramKeywordController.create.bind(TelegramKeywordController));
router.put   ("/telegram-keywords/:id",                auth, TelegramKeywordController.update.bind(TelegramKeywordController));
router.delete("/telegram-keywords/:id",                auth, TelegramKeywordController.remove.bind(TelegramKeywordController));
router.post  ("/telegram-keywords/results/:id/open",   auth, TelegramKeywordController.openDirectChat.bind(TelegramKeywordController));
router.post  ("/telegram-keywords/results/:id/reply",  auth, TelegramKeywordController.reply.bind(TelegramKeywordController));
router.post  ("/telegram-keywords/results/:id/ignore", auth, TelegramKeywordController.ignore.bind(TelegramKeywordController));
router.post  ("/telegram-keywords/results/:id/block-user", auth, TelegramKeywordController.blockUser.bind(TelegramKeywordController));
router.get   ("/telegram-keywords/blocked-users", auth, TelegramKeywordController.blockedUsers.bind(TelegramKeywordController));
router.patch ("/telegram-keywords/blocked-users/:id/unblock", auth, TelegramKeywordController.unblockUser.bind(TelegramKeywordController));

// ── روابط واتساب المكتشفة (تتطلب مصادقة) ───────────
// ⚠️ المسارات الثابتة (export / bulk-delete) قبل /:id
router.get   ("/telegram/join-automation/dashboard", auth, TelegramController.getJoinAutomationDashboard.bind(TelegramController));
router.get   ("/telegram/join-automation/links/selection", auth, TelegramController.getJoinAutomationLinkIds.bind(TelegramController));
router.get   ("/telegram/join-automation/settings", auth, TelegramController.getJoinAutomationSettings.bind(TelegramController));
router.get   ("/telegram/join-automation/health", auth, TelegramController.getJoinAutomationHealth.bind(TelegramController));
router.put   ("/telegram/join-automation/settings", auth, TelegramController.updateJoinAutomationSettings.bind(TelegramController));
router.post  ("/telegram/join-automation/accounts/:accountId/revalidate", auth, TelegramController.revalidateJoinAutomationAccount.bind(TelegramController));
router.get   ("/telegram/join-automation/report", auth, TelegramController.getJoinAutomationReport.bind(TelegramController));
router.post  ("/telegram/join-automation/search/start", auth, TelegramController.startJoinAutomationSearch.bind(TelegramController));
router.post  ("/telegram/join-automation/search/stop", auth, TelegramController.stopJoinAutomationSearch.bind(TelegramController));
router.post  ("/telegram/join-automation/links/deduplicate", auth, TelegramController.deduplicateJoinAutomationLinks.bind(TelegramController));
router.get   ("/telegram/join-automation/links/:id/details", auth, TelegramController.getJoinAutomationLinkDetails.bind(TelegramController));
router.patch ("/telegram/join-automation/links/:id/archive", auth, TelegramController.archiveJoinAutomationLink.bind(TelegramController));
router.get   ("/telegram/join-automation/logs/export", auth, TelegramController.exportJoinAutomationLog.bind(TelegramController));
router.post  ("/telegram/join-automation/links/:id/revalidate", auth, TelegramController.revalidateJoinAutomationLink.bind(TelegramController));
router.get   ("/telegram/links",                       auth, TelegramController.listLinks.bind(TelegramController));
router.get   ("/telegram/links/export",                auth, TelegramController.exportLinks.bind(TelegramController));
router.post  ("/telegram/links/bulk-delete",           auth, TelegramController.bulkDeleteLinks.bind(TelegramController));
router.post  ("/telegram/links/bulk-copy",             auth, TelegramController.bulkCopyLinks.bind(TelegramController));
router.patch ("/telegram/links/:id",                   auth, TelegramController.updateLinkStatus.bind(TelegramController));
router.delete("/telegram/links/:id",                auth, TelegramController.deleteLink.bind(TelegramController));
router.get   ("/telegram/link-import/links",             auth, TelegramController.listImportedLinks.bind(TelegramController));
router.get   ("/telegram/link-import/sources",           auth, TelegramController.listImportSources.bind(TelegramController));
router.post  ("/telegram/link-import/preview",           auth, TelegramController.previewLinkFile.bind(TelegramController));
router.post  ("/telegram/link-import/file",              auth, TelegramController.importLinkFile.bind(TelegramController));
router.post  ("/telegram/link-import/save",              auth, TelegramController.saveLinkFile.bind(TelegramController));
router.post  ("/telegram/link-import/word",              auth, TelegramController.importWordLinks.bind(TelegramController));
router.post  ("/telegram/link-import/tasks",             auth, TelegramController.createImportTask.bind(TelegramController));
router.get   ("/telegram/link-import/tasks/:taskId",     auth, TelegramController.getImportDashboard.bind(TelegramController));
router.patch ("/telegram/link-import/tasks/:taskId",     auth, TelegramController.controlImportTask.bind(TelegramController));
router.post  ("/telegram/link-import/operations/:operationId/retry", auth, TelegramController.retryImportOperation.bind(TelegramController));
router.get   ("/telegram/link-import/export",            auth, TelegramController.exportImportedLinks.bind(TelegramController));

// ── WhatsApp Join Automation namespace ──────────────────────────────────────
// مسارات واضحة للقسم المستعاد؛ المسارات القديمة أعلاه تبقى للتوافق الخلفي.
router.get   ("/whatsapp/join-automation/dashboard", auth, TelegramController.getJoinAutomationDashboard.bind(TelegramController));
router.get   ("/whatsapp/join-automation/audit", auth, TelegramController.listWhatsAppAuditLogs.bind(TelegramController));
router.get   ("/whatsapp/join-automation/audit/stats", auth, TelegramController.getWhatsAppAuditStats.bind(TelegramController));
router.get   ("/whatsapp/join-automation/audit/export", auth, TelegramController.exportWhatsAppAuditLogs.bind(TelegramController));
router.get   ("/whatsapp/join-automation/audit/:id", auth, TelegramController.getWhatsAppAuditLog.bind(TelegramController));
router.get   ("/whatsapp/join-automation/links/selection", auth, TelegramController.getJoinAutomationLinkIds.bind(TelegramController));
router.get   ("/whatsapp/links/export", auth, TelegramController.exportLinks.bind(TelegramController));
router.get   ("/whatsapp/join-automation/settings", auth, TelegramController.getJoinAutomationSettings.bind(TelegramController));
router.get   ("/whatsapp/join-automation/health", auth, TelegramController.getJoinAutomationHealth.bind(TelegramController));
router.put   ("/whatsapp/join-automation/settings", auth, TelegramController.updateJoinAutomationSettings.bind(TelegramController));
router.post  ("/whatsapp/join-automation/accounts/:accountId/revalidate", auth, TelegramController.revalidateJoinAutomationAccount.bind(TelegramController));
router.post  ("/whatsapp/join-automation/accounts/:accountId/stop", auth, TelegramController.stopJoinAutomationAccount.bind(TelegramController));
router.post  ("/whatsapp/join-automation/emergency-stop", auth, TelegramController.emergencyStopJoinAutomation.bind(TelegramController));
router.get   ("/whatsapp/join-automation/report", auth, TelegramController.getJoinAutomationReport.bind(TelegramController));
router.post  ("/whatsapp/join-automation/search/start", auth, TelegramController.startJoinAutomationSearch.bind(TelegramController));
router.post  ("/whatsapp/join-automation/search/stop", auth, TelegramController.stopJoinAutomationSearch.bind(TelegramController));
router.post  ("/whatsapp/join-automation/links/deduplicate", auth, TelegramController.deduplicateJoinAutomationLinks.bind(TelegramController));
router.get   ("/whatsapp/join-automation/links/:id/details", auth, TelegramController.getJoinAutomationLinkDetails.bind(TelegramController));
router.patch ("/whatsapp/join-automation/links/:id/archive", auth, TelegramController.archiveJoinAutomationLink.bind(TelegramController));
router.get   ("/whatsapp/join-automation/logs/export", auth, TelegramController.exportJoinAutomationLog.bind(TelegramController));
router.post  ("/whatsapp/join-automation/links/:id/revalidate", auth, TelegramController.revalidateJoinAutomationLink.bind(TelegramController));
router.get   ("/whatsapp/link-import/links", auth, TelegramController.listImportedLinks.bind(TelegramController));
router.get   ("/whatsapp/link-import/sources", auth, TelegramController.listImportSources.bind(TelegramController));
router.post  ("/whatsapp/link-import/preview", auth, TelegramController.previewLinkFile.bind(TelegramController));
router.post  ("/whatsapp/link-import/file", auth, TelegramController.importLinkFile.bind(TelegramController));
router.post  ("/whatsapp/link-import/save", auth, TelegramController.saveLinkFile.bind(TelegramController));
router.post  ("/whatsapp/link-import/word", auth, TelegramController.importWordLinks.bind(TelegramController));
router.post  ("/whatsapp/link-import/tasks", auth, TelegramController.createImportTask.bind(TelegramController));
router.get   ("/whatsapp/link-import/tasks/:taskId", auth, TelegramController.getImportDashboard.bind(TelegramController));
router.patch ("/whatsapp/link-import/tasks/:taskId", auth, TelegramController.controlImportTask.bind(TelegramController));
router.post  ("/whatsapp/link-import/operations/:operationId/retry", auth, TelegramController.retryImportOperation.bind(TelegramController));
router.get   ("/whatsapp/link-import/export", auth, TelegramController.exportImportedLinks.bind(TelegramController));

// ── استقبال رسائل خارجية (بدون مصادقة JWT — تأمين بـ secret) ──────────────
// يُستخدم من سكريبت Python (telethon/pyrogram) أو أي Telegram bot
// POST /api/telegram/ingest/:accountId
// Body: { messages: [{text, group_name}], secret } أو { text, group_name, secret }
router.post("/telegram/ingest/:accountId", TelegramController.receiveIngest.bind(TelegramController));

// ── Telegram Bot API Webhook (بدون مصادقة — يُرسَل من Telegram) ─────────────
// يجب تفعيله عبر: https://api.telegram.org/bot{TOKEN}/setWebhook?url=.../api/telegram/webhook/:accountId
router.post("/telegram/webhook/:accountId", TelegramController.receiveBotWebhook.bind(TelegramController));

module.exports = router;


