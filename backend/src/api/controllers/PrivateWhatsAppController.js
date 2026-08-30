const PrivateWhatsAppService = require('../services/PrivateWhatsAppService');
const { queryAll } = require('../../lib/postgres');

const ADMIN_ROLES = new Set(['super_admin', 'superadmin', 'admin', 'owner']);

function currentUserId(req) {
    return req.user?.id || req.user?.userId || null;
}

function isAdmin(req) {
    return ADMIN_ROLES.has(req.user?.role);
}

function requireUser(req, res) {
    const userId = currentUserId(req);
    if (!userId) {
        res.status(401).json({ success: false, error: 'غير مصرح.' });
        return null;
    }
    return String(userId);
}

function isUuid(value) {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value || ''));
}

function handleError(res, error) {
    const status = Number(error?.statusCode) || 500;
    if (status >= 500) console.error('[PrivateWhatsAppController]', error);
    return res.status(status).json({ success: false, error: status >= 500 ? 'حدث خطأ داخلي في قسم خاص واتس اب.' : error.message });
}

const PrivateWhatsAppController = {
    async dashboard(req, res) {
        const userId = requireUser(req, res);
        if (!userId) return;
        try {
            const dashboard = await PrivateWhatsAppService.getDashboard(userId, { admin: isAdmin(req) });
            return res.json({ success: true, dashboard });
        } catch (error) {
            return handleError(res, error);
        }
    },

    async createSync(req, res) {
        const userId = requireUser(req, res);
        if (!userId) return;
        try {
            const body = req.body && typeof req.body === 'object' ? req.body : {};
            const accountIds = Array.isArray(body.accountIds) ? body.accountIds.slice(0, 100) : [];
            if (accountIds.some(id => !isUuid(id))) {
                return res.status(422).json({ success: false, error: 'توجد معرفات حسابات غير صالحة.' });
            }
            const defaultCountryCode = String(body.defaultCountryCode || '').replace(/[^0-9]/g, '');
            if (defaultCountryCode.length > 3) {
                return res.status(422).json({ success: false, error: 'رمز الدولة الافتراضي غير صالح.' });
            }
            const requestId = req.get('Idempotency-Key') || body.requestId || null;
            const result = await PrivateWhatsAppService.createSyncJob({
                userId,
                actorId: userId,
                admin: isAdmin(req),
                accountIds,
                requestId,
                defaultCountryCode,
            });
            return res.status(result.duplicate ? 200 : 202).json({ success: true, ...result });
        } catch (error) {
            return handleError(res, error);
        }
    },

    async syncStatus(req, res) {
        const userId = requireUser(req, res);
        if (!userId) return;
        if (!isUuid(req.params.id)) return res.status(400).json({ success: false, error: 'معرف المزامنة غير صالح.' });
        try {
            const job = await PrivateWhatsAppService.getSyncJob(userId, req.params.id);
            if (!job) return res.status(404).json({ success: false, error: 'مهمة المزامنة غير موجودة.' });
            return res.json({ success: true, job });
        } catch (error) {
            return handleError(res, error);
        }
    },

    async contacts(req, res) {
        const userId = requireUser(req, res);
        if (!userId) return;
        try {
            const result = await PrivateWhatsAppService.listContacts(userId, {
                page: req.query.page,
                limit: req.query.limit,
                search: req.query.search,
                status: req.query.status,
                consentStatus: req.query.consentStatus,
            });
            return res.json({ success: true, ...result });
        } catch (error) {
            return handleError(res, error);
        }
    },

    async updateConsent(req, res) {
        const userId = requireUser(req, res);
        if (!userId) return;
        if (!isUuid(req.params.id)) return res.status(400).json({ success: false, error: 'معرف جهة الاتصال غير صالح.' });
        try {
            const consentStatus = String(req.body?.consentStatus || '').toUpperCase();
            const contact = await PrivateWhatsAppService.updateConsent(userId, req.params.id, consentStatus);
            return res.json({ success: true, contact });
        } catch (error) {
            return handleError(res, error);
        }
    },

    async logs(req, res) {
        const userId = requireUser(req, res);
        if (!userId) return;
        try {
            const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 50));
            const logs = await queryAll(`
                SELECT * FROM private_whatsapp_audit_logs
                WHERE user_id = $1
                ORDER BY created_at DESC
                LIMIT $2
            `, [userId, limit]);
            return res.json({ success: true, logs });
        } catch (error) {
            return handleError(res, error);
        }
    },

    async settings(req, res) {
        const userId = requireUser(req, res);
        if (!userId) return;
        try {
            const settings = await PrivateWhatsAppService.getSettings(userId);
            return res.json({ success: true, settings });
        } catch (error) {
            return handleError(res, error);
        }
    },

    async updateSettings(req, res) {
        const userId = requireUser(req, res);
        if (!userId) return;
        try {
            const settings = await PrivateWhatsAppService.updateSettings(userId, userId, {
                defaultCountryCode: req.body?.defaultCountryCode,
                syncEnabled: req.body?.syncEnabled,
            });
            return res.json({ success: true, settings });
        } catch (error) {
            return handleError(res, error);
        }
    },

    async publishingAccounts(req, res) {
        const userId = requireUser(req, res);
        if (!userId) return;
        try {
            const accounts = await PrivateWhatsAppService.getPublishingAccounts(userId);
            return res.json({ success: true, accounts, configured: accounts.length > 0 });
        } catch (error) {
            return handleError(res, error);
        }
    },
};

module.exports = PrivateWhatsAppController;
