'use strict';
/**
 * TelegramController — يدعم Bot Token + Real Long Polling
 */

const TelegramService = require('../services/TelegramService');
const LinkImportService = require('../services/LinkImportService');
const LinkDiscoveryService = require('../services/LinkDiscoveryService');
const AutomationHealthService = require('../services/AutomationHealthService');
const WhatsAppManager = require('../../bot/WhatsAppManager');
const QueueManager = require('../../lib/QueueManager');
const { metrics } = require('../middleware/MetricsMiddleware');
const { queryAll, queryOne, query, withTransaction } = require('../../lib/postgres');
const { v4: uuidv4 } = require('uuid');
const SocketBridge = require('../../core/SocketBridge');
const ADMIN_ROLES = new Set(['super_admin', 'superadmin', 'admin', 'owner']);
const READ_ONLY_ROLES = new Set(['viewer', 'view_only']);
const isAdminUser = req => ADMIN_ROLES.has(req.user?.role);
const canOperate = req => !READ_ONLY_ROLES.has(String(req.user?.role || '').toLowerCase());
const currentUserId = req => req.user?.id || req.user?.userId || null;
const parseJSONValue = (value, fallback = []) => {
    if (Array.isArray(value) || (value && typeof value === 'object')) return value;
    try { return value ? JSON.parse(value) : fallback; } catch { return fallback; }
};

const TelegramController = {

    // ── إضافة حساب تيليجرام ──────────────────────────────────────────────────
    async addAccount(req, res) {
        return res.status(410).json({ success: false, error: 'استخدم تسجيل الدخول عبر رقم الهاتف وطلب كود Telegram من الواجهة الجديدة' });
        /* legacy flow intentionally disabled
        try {
            const { name, phone_number, api_id, api_hash, session_string, bot_token, notes } = req.body;
            const userId = req.user.id;

            if (!name) {
                return res.status(400).json({ success: false, error: 'اسم الحساب مطلوب' });
            }

            if (!session_string || !api_id || !api_hash) {
                return res.status(400).json({
                    success: false,
                    error: 'api_id و api_hash و session_string مطلوبة. احصل عليها من my.telegram.org وشغّل gen_session.js'
                });
            }

            const id = uuidv4();
            await query(
                `INSERT INTO telegram_accounts
                 (id, user_id, name, phone_number, api_id, api_hash, session_string, bot_token, notes, status)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'disconnected')`,
                [id, userId, name, phone_number || null, api_id || null, api_hash || null,
                 session_string || null, bot_token || null, notes || null]
            );

            const account = await queryOne(`SELECT * FROM telegram_accounts WHERE id = $1`, [id]);

            // تشغيل الـ worker مباشرة
            TelegramService.startWorker(account).catch(err => {
                console.error('[TelegramController] startWorker error:', err.message);
            });

            return res.json({ success: true, account });
        } catch (err) {
            console.error('[TelegramController.addAccount]', err.message);
            return res.status(500).json({ success: false, error: err.message });
        }
        */
    },

    // ── قائمة الحسابات ────────────────────────────────────────────────────────
    async listAccounts(req, res) {
        try {
            const userId  = req.user.id;
            const isAdmin = ['super_admin', 'admin'].includes(req.user.role);

            const accounts = isAdmin
                ? await queryAll(`SELECT * FROM telegram_accounts ORDER BY created_at DESC`)
                : await queryAll(
                    `SELECT * FROM telegram_accounts WHERE user_id = $1 ORDER BY created_at DESC`,
                    [userId]
                  );

            // إخفاء bot_token الكامل من الاستجابة (أمان)
            const safe = accounts.map(a => {
                const { session_string, session_encrypted, api_hash, bot_token, ...publicAccount } = a;
                return { ...publicAccount, bot_token: bot_token ? `${bot_token.slice(0, 10)}...` : null };
            });

            return res.json({ success: true, accounts: safe });
        } catch (err) {
            return res.status(500).json({ success: false, error: err.message });
        }
    },

    // ── تفاصيل حساب واحد ─────────────────────────────────────────────────────
    async getAccount(req, res) {
        try {
            const { id } = req.params;
            const account = await queryOne(`SELECT * FROM telegram_accounts WHERE id = $1`, [id]);
            if (!account) return res.status(404).json({ success: false, error: 'الحساب غير موجود' });
            if (!isAdminUser(req) && account.user_id !== currentUserId(req)) return res.status(403).json({ success: false, error: 'غير مصرح بالوصول إلى هذا الحساب' });
            const { session_string, session_encrypted, api_hash, bot_token, ...publicAccount } = account;
            publicAccount.bot_token = bot_token ? `${bot_token.slice(0, 10)}...` : null;
            return res.json({ success: true, account: publicAccount });
        } catch (err) {
            return res.status(500).json({ success: false, error: err.message });
        }
    },

    // ── تعديل حساب ───────────────────────────────────────────────────────────
    async updateAccount(req, res) {
        try {
            const { id } = req.params;
            const { name, phone_number, api_id, api_hash, session_string, bot_token, notes } = req.body;

            const account = await queryOne(`SELECT * FROM telegram_accounts WHERE id = $1`, [id]);
            if (account && !isAdminUser(req) && account.user_id !== currentUserId(req)) return res.status(403).json({ success: false, error: 'غير مصرح بتعديل هذا الحساب' });
            if (!account) return res.status(404).json({ success: false, error: 'الحساب غير موجود' });

            await query(
                `UPDATE telegram_accounts SET
                 name=$1, phone_number=$2, api_id=$3, api_hash=$4,
                 session_string=$5, bot_token=$6, notes=$7, updated_at=NOW()
                 WHERE id=$8`,
                [
                    name           || account.name,
                    phone_number   !== undefined ? phone_number   : account.phone_number,
                    api_id         !== undefined ? api_id         : account.api_id,
                    api_hash       !== undefined ? api_hash       : account.api_hash,
                    session_string !== undefined ? session_string : account.session_string,
                    bot_token      !== undefined ? bot_token      : account.bot_token,
                    notes          !== undefined ? notes          : account.notes,
                    id,
                ]
            );

            // إعادة تشغيل الـ worker إذا تغيّر الـ bot_token
            const tokenChanged = session_string && session_string !== account.session_string;
            if (tokenChanged) {
                TelegramService.stopWorker(id);
                const updated = await queryOne(`SELECT * FROM telegram_accounts WHERE id = $1`, [id]);
                TelegramService.startWorker(updated).catch(err => {
                    console.error('[TelegramController] startWorker error (update):', err.message);
                });
            }

            const updated = await queryOne(`SELECT * FROM telegram_accounts WHERE id = $1`, [id]);
            updated.bot_token = updated.bot_token ? `${updated.bot_token.slice(0, 10)}...` : null;
            return res.json({ success: true, account: updated });
        } catch (err) {
            return res.status(500).json({ success: false, error: err.message });
        }
    },

    // ── حذف حساب ─────────────────────────────────────────────────────────────
    async deleteAccount(req, res) {
        try {
            const { id } = req.params;
            const account = await queryOne(`SELECT * FROM telegram_accounts WHERE id = $1`, [id]);
            if (!account) return res.status(404).json({ success: false, error: 'الحساب غير موجود' });
            if (!isAdminUser(req) && account.user_id !== currentUserId(req)) return res.status(403).json({ success: false, error: 'غير مصرح بحذف هذا الحساب' });

            // يجب إيقاف العامل قبل حذف السجل، وانتظار الإيقاف حتى لا يحاول
            // تحديث حساب تم حذفه أثناء إغلاق اتصال Telegram.
            await TelegramService.stopWorker(id);

            // العلاقات التالية تستخدم RESTRICT عمداً للحفاظ على السجل التاريخي:
            // - العمليات المرتبطة بالحساب لا معنى لها بعد حذف الحساب، لذلك تُحذف.
            // - الرابط المكتشف قد يكون مستخدماً من حسابات أخرى، لذلك نفصل مصدره
            //   بدلاً من حذف الرابط أو كسر سجل الأتمتة.
            await withTransaction(async client => {
                await client.query(
                    `UPDATE telegram_automation_links
                     SET source_account_id = NULL, updated_at = NOW()
                     WHERE source_account_id = $1`,
                    [id]
                );
                await client.query(
                    `DELETE FROM telegram_join_operations WHERE account_id = $1`,
                    [id]
                );
                await client.query(
                    `DELETE FROM telegram_accounts WHERE id = $1`,
                    [id]
                );
            });

            return res.json({ success: true, message: 'تم حذف الحساب' });
        } catch (err) {
            return res.status(500).json({ success: false, error: err.message });
        }
    },

    // ── تشغيل worker ─────────────────────────────────────────────────────────
    async startWorker(req, res) {
        try {
            const { id } = req.params;
            const account = await queryOne(`SELECT * FROM telegram_accounts WHERE id = $1`, [id]);
            if (!account) return res.status(404).json({ success: false, error: 'الحساب غير موجود' });
            if (!isAdminUser(req) && account.user_id !== currentUserId(req)) return res.status(403).json({ success: false, error: 'غير مصرح بتشغيل هذا الحساب' });
            const configuredApiId = account.api_id || process.env.TELEGRAM_API_ID || process.env.TELEGRAM_APP_ID || process.env.TELEGRAM_APIID;
            const configuredApiHash = account.api_hash || process.env.TELEGRAM_API_HASH || process.env.TELEGRAM_APP_HASH || process.env.TELEGRAM_APIHASH;
            if (!(account.session_encrypted || account.session_string) || !configuredApiId || !configuredApiHash) {
                return res.status(400).json({ success: false, error: 'إعدادات Telegram API غير مهيأة في الخادم. اضبط TELEGRAM_API_ID و TELEGRAM_API_HASH في Railway.' });
            }

            await TelegramService.startWorker(account);
            return res.json({ success: true, message: 'تم تشغيل المراقبة الحقيقية' });
        } catch (err) {
            return res.status(500).json({ success: false, error: err.message });
        }
    },

    // ── إيقاف worker ─────────────────────────────────────────────────────────
    async stopWorker(req, res) {
        try {
            const { id } = req.params;
            if (!isAdminUser(req)) {
                const owned = await queryOne(`SELECT id FROM telegram_accounts WHERE id=$1 AND user_id=$2`, [id, currentUserId(req)]);
                if (!owned) return res.status(403).json({ success: false, error: 'غير مصرح بإيقاف هذا الحساب' });
            }
            TelegramService.stopWorker(id);
            return res.json({ success: true, message: 'تم إيقاف المراقبة' });
        } catch (err) {
            return res.status(500).json({ success: false, error: err.message });
        }
    },

    // ── استقبال رسائل من سكريبت Python (telethon/pyrogram) ─────────────────
    async receiveIngest(req, res) {
        try {
            const { accountId } = req.params;
            const { messages = [], secret, text, group_name } = req.body;

            const expectedSecret = process.env.TELEGRAM_INGEST_SECRET;
            if (expectedSecret && secret !== expectedSecret) {
                return res.status(401).json({ success: false, error: 'Unauthorized' });
            }

            const account = await queryOne(
                `SELECT id, name FROM telegram_accounts WHERE id = $1`, [accountId]
            );
            if (!account) {
                return res.status(404).json({ success: false, error: 'الحساب غير موجود' });
            }

            let totalLinks = 0;
            const items = messages.length > 0
                ? messages
                : (text ? [{ text, group_name: group_name || '' }] : []);

            for (const item of items) {
                if (!item.text) continue;
                const result = await TelegramService.processIncomingMessage(
                    accountId,
                    account.name,
                    item.group_name || item.channel || '',
                    item.text
                );
                totalLinks += result?.linksSaved || 0;
            }

            return res.json({ success: true, linksAdded: totalLinks });
        } catch (err) {
            console.error('[TelegramController.receiveIngest]', err.message);
            return res.status(500).json({ success: false, error: err.message });
        }
    },

    // ── استقبال تحديثات Telegram Bot API (webhook) ──────────────────────────
    async receiveBotWebhook(req, res) {
        res.json({ ok: true });
        try {
            const { accountId } = req.params;
            const update = req.body;
            if (!update) return;
            await TelegramService.processBotUpdate(accountId, update);
        } catch (err) {
            console.error('[TelegramController.receiveBotWebhook]', err.message);
        }
    },

    // ── روابط واتساب المكتشفة ────────────────────────────────────────────────
    async listLinks(req, res) {
        try {
            const { page = 1, limit = 50, status, copied, account_id, date_from, date_to, search } = req.query;
            const offset = (parseInt(page) - 1) * parseInt(limit);

            const conditions = [];
            const params     = [];
            let pIdx = 1;

            conditions.push(`wl.deleted = false`);
            if (!isAdminUser(req)) {
                const ownershipParam = `$${pIdx++}`;
                conditions.push(`(wl.import_user_id = ${ownershipParam} OR EXISTS (SELECT 1 FROM telegram_accounts ta_scope WHERE ta_scope.id = wl.source_account_id AND ta_scope.user_id = ${ownershipParam}))`);
                params.push(currentUserId(req));
            }

            if (status)     { conditions.push(`wl.status = $${pIdx++}`);             params.push(status); }
            if (copied === 'true')  { conditions.push(`wl.copied = true`); }
            if (copied === 'false') { conditions.push(`wl.copied = false`); }
            if (account_id) { conditions.push(`wl.source_account_id = $${pIdx++}`);  params.push(account_id); }
            if (date_from)  { conditions.push(`wl.discovered_at >= $${pIdx++}`);     params.push(date_from); }
            if (date_to)    { conditions.push(`wl.discovered_at <= $${pIdx++}`);     params.push(date_to); }
            if (search)     { conditions.push(`wl.whatsapp_link ILIKE $${pIdx++}`);  params.push(`%${search}%`); }

            const where = `WHERE ${conditions.join(' AND ')}`;

            const total = await queryOne(
                `SELECT COUNT(*) as cnt FROM whatsapp_links wl ${where}`,
                params
            );

            const links = await queryAll(
                `SELECT wl.*, ta.name as account_name, ta.phone_number as account_phone
                 FROM whatsapp_links wl
                 LEFT JOIN telegram_accounts ta ON ta.id = wl.source_account_id
                 ${where}
                 ORDER BY wl.discovered_at DESC
                 LIMIT $${pIdx++} OFFSET $${pIdx++}`,
                [...params, parseInt(limit), offset]
            );

            return res.json({
                success: true,
                links,
                total:   parseInt(total?.cnt || 0),
                page:    parseInt(page),
                limit:   parseInt(limit),
            });
        } catch (err) {
            return res.status(500).json({ success: false, error: err.message });
        }
    },

    // ── تحديث حالة رابط ──────────────────────────────────────────────────────
    async updateLinkStatus(req, res) {
        try {
            const { id } = req.params;
            const { status, joined, copied, notes } = req.body;

            const sets   = [];
            const params = [];
            let idx = 1;

            if (status !== undefined) { sets.push(`status=$${idx++}`);  params.push(status); }
            if (joined !== undefined) { sets.push(`joined=$${idx++}`);  params.push(joined); }
            if (copied !== undefined) { sets.push(`copied=$${idx++}`);  params.push(copied); }
            if (notes  !== undefined) { sets.push(`notes=$${idx++}`);   params.push(notes); }

            if (!sets.length) {
                return res.status(400).json({ success: false, error: 'لا توجد بيانات للتحديث' });
            }

            if (!isAdminUser(req)) {
                params.push(currentUserId(req));
                sets.push(`updated_at=NOW()`);
                const ownerParam = params.length;
                params.push(id);
                await query(`UPDATE whatsapp_links SET ${sets.join(',')} WHERE id=$${params.length} AND EXISTS (SELECT 1 FROM telegram_accounts ta_scope WHERE ta_scope.id=whatsapp_links.source_account_id AND ta_scope.user_id=$${ownerParam})`, params);
            } else {
                params.push(id);
                await query(`UPDATE whatsapp_links SET ${sets.join(',')} WHERE id=$${params.length}`, params);
            }

            return res.json({ success: true });
        } catch (err) {
            return res.status(500).json({ success: false, error: err.message });
        }
    },

    // ── نسخ جماعي مع تسجيل النسخ ومنع ظهوره في النتائج الجديدة ─────────────
    async bulkCopyLinks(req, res) {
        try {
            const { ids, copyAll = false } = req.body || {};
            const conditions = ['deleted = false', 'copied = false'];
            const params = [];
            if (!isAdminUser(req)) {
                params.push(currentUserId(req));
                conditions.push(`EXISTS (SELECT 1 FROM telegram_accounts ta_scope WHERE ta_scope.id=whatsapp_links.source_account_id AND ta_scope.user_id=$${params.length})`);
            }
            if (!copyAll) {
                if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ success: false, error: 'يرجى تحديد روابط للنسخ' });
                params.push(ids);
                conditions.push(`id = ANY($${params.length}::uuid[])`);
            }
            const rows = await queryAll(`SELECT id, whatsapp_link FROM whatsapp_links WHERE ${conditions.join(' AND ')} ORDER BY discovered_at DESC`, params);
            if (!rows.length) return res.json({ success: true, count: 0, links: [], message: 'لا توجد روابط جديدة غير منسوخة' });
            const copiedIds = rows.map(row => row.id);
            await query(`UPDATE whatsapp_links SET copied=true, copied_at=NOW(), updated_at=NOW() WHERE id = ANY($1::uuid[])`, [copiedIds]);
            return res.json({ success: true, count: rows.length, links: rows.map(row => row.whatsapp_link) });
        } catch (err) {
            return res.status(500).json({ success: false, error: err.message });
        }
    },

    // ── حذف رابط (soft delete) ───────────────────────────────────────────────
    async deleteLink(req, res) {
        try {
            const { id } = req.params;
            if (isAdminUser(req)) {
                await query(`UPDATE whatsapp_links SET deleted=true, status='deleted' WHERE id=$1`, [id]);
            } else {
                await query(`UPDATE whatsapp_links SET deleted=true, status='deleted' WHERE id=$1 AND EXISTS (SELECT 1 FROM telegram_accounts ta_scope WHERE ta_scope.id=whatsapp_links.source_account_id AND ta_scope.user_id=$2)`, [id, currentUserId(req)]);
            }
            return res.json({ success: true });
        } catch (err) {
            return res.status(500).json({ success: false, error: err.message });
        }
    },

    // ── حذف متعدد ────────────────────────────────────────────────────────────
    async bulkDeleteLinks(req, res) {
        try {
            const { ids, deleteJoined } = req.body;

            if (deleteJoined) {
                if (isAdminUser(req)) {
                    await query(`UPDATE whatsapp_links SET deleted=true, status='deleted' WHERE joined=true`);
                } else {
                    await query(`UPDATE whatsapp_links SET deleted=true, status='deleted' WHERE joined=true AND EXISTS (SELECT 1 FROM telegram_accounts ta_scope WHERE ta_scope.id=whatsapp_links.source_account_id AND ta_scope.user_id=$1)`, [currentUserId(req)]);
                }
                return res.json({ success: true });
            }
            if (ids && Array.isArray(ids) && ids.length) {
                if (isAdminUser(req)) {
                    await query(`UPDATE whatsapp_links SET deleted=true, status='deleted' WHERE id = ANY($1::uuid[])`, [ids]);
                } else {
                    await query(`UPDATE whatsapp_links SET deleted=true, status='deleted' WHERE id = ANY($1::uuid[]) AND EXISTS (SELECT 1 FROM telegram_accounts ta_scope WHERE ta_scope.id=whatsapp_links.source_account_id AND ta_scope.user_id=$2)`, [ids, currentUserId(req)]);
                }
                return res.json({ success: true });
            }
            return res.status(400).json({ success: false, error: 'يرجى تحديد روابط للحذف' });
        } catch (err) {
            return res.status(500).json({ success: false, error: err.message });
        }
    },

    // ── تصدير CSV ────────────────────────────────────────────────────────────
    async exportLinks(req, res) {
        try {
            const { status, account_id } = req.query;
            const conditions = ['deleted = false'];
            const params = [];
            let pIdx = 1;
            if (!isAdminUser(req)) {
                const ownershipParam = `$${pIdx++}`;
                conditions.push(`(import_user_id = ${ownershipParam} OR EXISTS (SELECT 1 FROM telegram_accounts ta_scope WHERE ta_scope.id = source_account_id AND ta_scope.user_id = ${ownershipParam}))`);
                params.push(currentUserId(req));
            }

            if (status)     { conditions.push(`status = $${pIdx++}`);            params.push(status); }
            if (account_id) { conditions.push(`source_account_id = $${pIdx++}`); params.push(account_id); }

            const links = await queryAll(
                `SELECT whatsapp_link, source_account_name, source_group,
                        discovered_at, status, duplicate_count, joined
                 FROM whatsapp_links
                 WHERE ${conditions.join(' AND ')}
                 ORDER BY discovered_at DESC`,
                params
            );

            const header = 'رابط واتساب,الحساب المصدر,المجموعة/القناة,تاريخ الاكتشاف,الحالة,عدد التكرار,تم الانضمام';
            const rows   = links.map(l =>
                `"${l.whatsapp_link}","${l.source_account_name || ''}","${l.source_group || ''}",` +
                `"${l.discovered_at}","${l.status}","${l.duplicate_count}","${l.joined ? 'نعم' : 'لا'}"`
            );
            const csv = '\uFEFF' + [header, ...rows].join('\n');

            res.setHeader('Content-Type', 'text/csv; charset=utf-8');
            res.setHeader('Content-Disposition', 'attachment; filename=whatsapp_links.csv');
            return res.send(csv);
        } catch (err) {
            return res.status(500).json({ success: false, error: err.message });
        }
    },

    // ── إحصائيات ─────────────────────────────────────────────────────────────
    async getStats(req, res) {
        try {
            const admin = isAdminUser(req);
            const uid = currentUserId(req);
            const accountScope = admin ? '' : ' AND user_id=$1';
            const linkScope = admin ? '' : ' AND EXISTS (SELECT 1 FROM telegram_accounts ta_scope WHERE ta_scope.id=whatsapp_links.source_account_id AND ta_scope.user_id=$1)';
            const scopeParams = admin ? [] : [uid];
            const totalAccounts     = await queryOne(`SELECT COUNT(*) as cnt FROM telegram_accounts WHERE TRUE${accountScope}`, scopeParams);
            const connectedAccounts = await queryOne(`SELECT COUNT(*) as cnt FROM telegram_accounts WHERE status='connected'${accountScope}`, scopeParams);
            const totalLinks        = await queryOne(`SELECT COUNT(*) as cnt FROM whatsapp_links WHERE deleted=false${linkScope}`, scopeParams);
            const newLinks          = await queryOne(`SELECT COUNT(*) as cnt FROM whatsapp_links WHERE deleted=false AND discovered_at >= NOW() - INTERVAL '24 hours'${linkScope}`, scopeParams);
            const joinedLinks       = await queryOne(`SELECT COUNT(*) as cnt FROM whatsapp_links WHERE joined=true AND deleted=false${linkScope}`, scopeParams);
            const deletedLinks      = await queryOne(`SELECT COUNT(*) as cnt FROM whatsapp_links WHERE deleted=true${linkScope}`, scopeParams);
            const duplicateLinks    = await queryOne(`SELECT COALESCE(SUM(duplicate_count),0) as cnt FROM whatsapp_links WHERE duplicate_count > 0${linkScope}`, scopeParams);
            const copiedLinks       = await queryOne(`SELECT COUNT(*) as cnt FROM whatsapp_links WHERE copied=true AND deleted=false${linkScope}`, scopeParams);

            const perAccount = await queryAll(
                `SELECT ta.id, ta.name, ta.phone_number, ta.bot_username, COUNT(wl.id) as links_count
                 FROM telegram_accounts ta
                 LEFT JOIN whatsapp_links wl ON wl.source_account_id = ta.id AND wl.deleted=false
                 WHERE ($1::uuid IS NULL OR ta.user_id=$1)
                 GROUP BY ta.id, ta.name, ta.phone_number, ta.bot_username
                 ORDER BY links_count DESC`,
                [admin ? null : uid]
            );

            // حالة الـ workers النشطة
            const workers = TelegramService.getAllWorkersStatus();

            return res.json({
                success: true,
                stats: {
                    totalAccounts:        parseInt(totalAccounts?.cnt    || 0),
                    connectedAccounts:    parseInt(connectedAccounts?.cnt || 0),
                    disconnectedAccounts: parseInt(totalAccounts?.cnt    || 0) - parseInt(connectedAccounts?.cnt || 0),
                    totalLinks:           parseInt(totalLinks?.cnt       || 0),
                    newLinks:             parseInt(newLinks?.cnt         || 0),
                    joinedLinks:          parseInt(joinedLinks?.cnt      || 0),
                    deletedLinks:         parseInt(deletedLinks?.cnt     || 0),
                    duplicateLinks:       parseInt(duplicateLinks?.cnt   || 0),
                    copiedLinks:          parseInt(copiedLinks?.cnt      || 0),
                    perAccount,
                    activeWorkers:        workers.length,
                },
            });
        } catch (err) {
            return res.status(500).json({ success: false, error: err.message });
        }
    },

    // ── لوحة أتمتة الانضمام ───────────────────────────────────────────────────
    async getJoinAutomationLinkIds(req, res) {
        try {
            const userId = currentUserId(req);
            const admin = isAdminUser(req);
            const params = admin ? [] : [userId];
            const conditions = ['wl.deleted=false', "COALESCE(wl.processing_status,wl.status,'new') NOT IN ('invalid','unavailable')"];
            let index = admin ? 1 : 2;
            if (!admin) {
                conditions.push(`(wl.import_user_id=$${index} OR EXISTS (SELECT 1 FROM link_import_links imported_scope WHERE imported_scope.discovered_link_id=wl.id AND imported_scope.user_id=$${index}) OR EXISTS (SELECT 1 FROM accounts a_scope WHERE a_scope.id=wl.source_account_id AND a_scope.user_id=$${index}))`);
                index += 1;
            }
            const search = String(req.query?.search || '').trim();
            if (search) { conditions.push(`(wl.whatsapp_link ILIKE $${index} OR COALESCE(wl.source_group,'') ILIKE $${index} OR COALESCE(wl.source_account_name,'') ILIKE $${index})`); params.push(`%${search}%`); index += 1; }
            const status = String(req.query?.status || '').trim();
            if (status && status !== 'all') { conditions.push(`(wl.processing_status=$${index} OR wl.status=$${index})`); params.push(status); index += 1; }
            const source = String(req.query?.source || '').trim();
            if (source && source !== 'all') { conditions.push(`wl.source_group=$${index}`); params.push(source); index += 1; }
            const accountIds = String(req.query?.accountIds || '').split(',').map(value => value.trim()).filter(Boolean);
            if (accountIds.length) { conditions.push(`wl.source_account_id=ANY($${index}::uuid[])`); params.push(accountIds); index += 1; }
            const dateFrom = String(req.query?.dateFrom || '').trim();
            if (dateFrom) { conditions.push(`wl.discovered_at >= $${index}`); params.push(dateFrom); index += 1; }
            const dateTo = String(req.query?.dateTo || '').trim();
            if (dateTo) { conditions.push(`wl.discovered_at <= $${index}`); params.push(dateTo); index += 1; }
            if (String(req.query?.showCompleted || '').toLowerCase() !== 'true') conditions.push("COALESCE(wl.processing_status,wl.status,'new') NOT IN ('completed','joined','success')");
            const rows = await queryAll(`SELECT wl.id FROM whatsapp_links wl WHERE ${conditions.join(' AND ')} ORDER BY wl.discovered_at DESC`, params);
            return res.json({ success: true, ids: rows.map(row => String(row.id)), total: rows.length });
        } catch (error) { return res.status(500).json({ success: false, error: error.message }); }
    },
    async getJoinAutomationDashboard(req, res) {
        try {
            const userId = currentUserId(req);
            const admin = isAdminUser(req);
            await LinkImportService.syncImportedLinksToDashboard(userId).catch(error => console.warn(`[JoinAutomation] import link sync skipped: ${error.message}`));
            const accountWhere = admin ? '' : 'WHERE a.user_id=$1';
            const accountParams = admin ? [] : [userId];
            const linkScope = admin ? '' : ' AND (wl.import_user_id=$1 OR EXISTS (SELECT 1 FROM link_import_links imported_scope WHERE imported_scope.discovered_link_id=wl.id AND imported_scope.user_id=$1) OR EXISTS (SELECT 1 FROM accounts a_scope WHERE a_scope.id=wl.source_account_id AND a_scope.user_id=$1))';
            const linkParams = admin ? [] : [userId];
            const requestedPage = Math.max(1, Math.floor(Number(req.query?.page || 1)));
            const pageSize = Math.min(500, Math.max(25, Math.floor(Number(req.query?.pageSize || 100))));
            const offset = (requestedPage - 1) * pageSize;
            const sortColumns = { discovered_at: 'wl.discovered_at', last_verified_at: 'wl.last_verified_at', status: 'wl.processing_status', last_seen: 'wl.last_seen' };
            const sortColumn = sortColumns[String(req.query?.sortBy || 'discovered_at')] || sortColumns.discovered_at;
            const sortDirection = String(req.query?.sortDirection || 'desc').toLowerCase() === 'asc' ? 'ASC' : 'DESC';
            const linksListParams = admin ? [pageSize, offset] : [userId, pageSize, offset];
            const limitParam = admin ? '$1' : '$2'; const offsetParam = admin ? '$2' : '$3';
            const [links, total, valid, processing, completed, failed, deferred, sources, joinAccounts, latestTask, latestDiscoveryJob, nextOperation, cycleStates] = await Promise.all([
                queryAll(`SELECT wl.*, a.name account_name, a.phone_number account_phone FROM whatsapp_links wl LEFT JOIN accounts a ON a.id=wl.source_account_id WHERE wl.deleted=false${linkScope} ORDER BY ${sortColumn} ${sortDirection} NULLS LAST LIMIT ${limitParam} OFFSET ${offsetParam}`, linksListParams),
                queryOne(`SELECT COUNT(*) cnt FROM whatsapp_links wl WHERE wl.deleted=false${linkScope}`, linkParams),
                queryOne(`SELECT COUNT(*) cnt FROM whatsapp_links wl WHERE wl.deleted=false AND wl.status NOT IN ('invalid','unavailable')${linkScope}`, linkParams),
                queryOne(`SELECT COUNT(*) cnt FROM whatsapp_links wl WHERE wl.deleted=false AND wl.processing_status IN ('queued','processing')${linkScope}`, linkParams),
                queryOne(`SELECT COUNT(*) cnt FROM whatsapp_links wl WHERE wl.deleted=false AND (wl.joined=true OR wl.processing_status='completed')${linkScope}`, linkParams),
                queryOne(`SELECT COUNT(*) cnt FROM whatsapp_links wl WHERE wl.deleted=false AND (wl.status='failed' OR wl.processing_status IN ('failed','review'))${linkScope}`, linkParams),
                queryOne(`SELECT COUNT(*) cnt FROM whatsapp_links wl WHERE wl.deleted=false AND wl.processing_status IN ('deferred','pending')${linkScope}`, linkParams),
                queryAll(`SELECT a.id,a.name,a.phone_number,a.status,a.health_status,a.task_status,a.last_activity_at,a.updated_at,
                                 COUNT(wl.id)::int AS links_collected,
                                 COUNT(DISTINCT NULLIF(wl.source_group,''))::int AS channels_monitored
                            FROM accounts a
                            LEFT JOIN whatsapp_links wl ON wl.source_account_id=a.id AND wl.deleted=false
                            ${accountWhere}
                           GROUP BY a.id,a.name,a.phone_number,a.status,a.health_status,a.task_status,a.last_activity_at,a.updated_at,a.created_at
                           ORDER BY a.created_at DESC`, accountParams),
                queryAll(`SELECT a.id,a.name,a.phone_number,a.status,a.health_status,a.task_status,a.last_activity_at,a.updated_at,COALESCE(g.circuit_state,'CLOSED') AS circuit_breaker_state,g.reason_code AS protection_reason_code,g.reason AS protection_reason,g.consecutive_503,g.deferred_count,g.lock_collision_count,g.recovery_count,g.retry_count FROM accounts a LEFT JOIN link_import_account_guards g ON g.account_id=a.id ${accountWhere} ORDER BY a.created_at DESC`, accountParams),
                queryOne(`SELECT id,status,total_operations,completed_operations,created_at,updated_at FROM link_import_tasks WHERE user_id=$1 ORDER BY created_at DESC LIMIT 1`, [userId]),
                queryOne(`SELECT id,queue_job_id,status,source_account_ids,messages_scanned,found_count,error,started_at,completed_at,created_at,updated_at FROM join_automation_discovery_jobs WHERE user_id=$1 ORDER BY created_at DESC LIMIT 1`, [userId]),
                queryOne(`SELECT next_operation_at FROM whatsapp_links wl WHERE wl.deleted=false${linkScope} AND wl.next_operation_at IS NOT NULL ORDER BY wl.next_operation_at ASC LIMIT 1`, linkParams),
                queryAll(`SELECT DISTINCT ON (c.account_id) c.*,a.name account_name,a.phone_number account_phone,t.cycle_limit,t.cycle_duration_minutes,t.auto_resume,t.status task_status,COALESCE(g.circuit_state,'CLOSED') AS circuit_breaker_state,g.reason_code AS protection_reason_code,g.reason AS protection_reason,g.consecutive_503,g.deferred_count,g.lock_collision_count,g.recovery_count,g.retry_count,(SELECT MIN(o.next_run_at) FROM link_import_operations o WHERE o.cycle_id=c.id AND o.status IN ('pending','retry','paused')) AS next_run_at,(SELECT COUNT(*)::int FROM link_import_operations o WHERE o.account_id=c.account_id AND o.status='processing') AS active_jobs,(SELECT COUNT(*)::int FROM link_import_operations o WHERE o.account_id=c.account_id AND o.status IN ('pending','processing','retry','paused')) AS active_or_future_jobs FROM link_import_cycles c JOIN link_import_tasks t ON t.id=c.task_id JOIN accounts a ON a.id=c.account_id LEFT JOIN link_import_account_guards g ON g.account_id=c.account_id WHERE t.user_id=$1 AND c.status IN ('RUNNING','RESTING') ORDER BY c.account_id,c.updated_at DESC`, [userId]),
            ]);
            cycleStates.forEach(cycle => { metrics.setActiveJobs(cycle.account_id, cycle.active_jobs || 0); metrics.setFutureJobs(cycle.account_id, cycle.active_or_future_jobs || 0); });
            const connectedIds = new Set(WhatsAppManager.getConnectedAccountIds().map(String));
            const workers = sources.filter(source => connectedIds.has(String(source.id))).map(source => ({
                accountId: source.id,
                accountName: source.name,
                status: WhatsAppManager.isReady(source.id) ? 'connected' : 'connecting',
                linksFound: Number(source.links_collected || 0),
            }));
            const health = await AutomationHealthService.getHealth({ userId, isAdmin: admin });
            const systemStatus = workers.some(worker => worker.status === 'error') ? 'needs_intervention' : workers.some(worker => ['connecting','connected'].includes(worker.status)) ? 'running' : 'stopped';
            const normalizeLink = link => ({ ...link, source_history: parseJSONValue(link.source_history), discovered_by_account_ids: parseJSONValue(link.discovered_by_account_ids), next_operation: link.next_operation_at || null });
            return res.json({ success: true, links: links.map(normalizeLink), sources: sources.map(source => ({ ...source, worker: workers.find(worker => String(worker.accountId) === String(source.id)) || null })), joinAccounts: joinAccounts.map(account => ({ ...account, is_ready: WhatsAppManager.isReady(account.id) })), workers, health, latestTask, latestDiscoveryJob, cycleStates, nextOperationAt: nextOperation?.next_operation_at || null, pagination: { page: requestedPage, pageSize, total: Number(total?.cnt || 0), totalPages: Math.max(1, Math.ceil(Number(total?.cnt || 0) / pageSize)), sortBy: Object.keys(sortColumns).find(key => sortColumns[key] === sortColumn) || 'discovered_at', sortDirection: sortDirection.toLowerCase() }, systemStatus, stats: { total: Number(total?.cnt || 0), valid: Number(valid?.cnt || 0), processing: Number(processing?.cnt || 0), completed: Number(completed?.cnt || 0), failed: Number(failed?.cnt || 0), deferred: Number(deferred?.cnt || 0), activeWorkers: workers.filter(worker => ['connecting','connected'].includes(worker.status)).length } });
        } catch (error) { return res.status(500).json({ success: false, error: error.message }); }
    },
    async getJoinAutomationHealth(req, res) {
        try { return res.json({ success: true, health: await AutomationHealthService.getHealth({ userId: currentUserId(req), isAdmin: isAdminUser(req) }) }); }
        catch (error) { return res.status(500).json({ success: false, error: error.message }); }
    },
    async revalidateJoinAutomationAccount(req, res) {
        try {
            if (!canOperate(req)) return res.status(403).json({ success: false, error: 'صلاحية المشاهدة فقط لا تسمح بإعادة تفعيل الحساب' });
            const userId = currentUserId(req);
            const account = await queryOne(`SELECT id,name,status,health_status,task_status FROM accounts WHERE id=$1 AND ($2::boolean OR user_id=$3)`, [req.params.accountId, isAdminUser(req), userId]);
            if (!account) return res.status(404).json({ success: false, error: 'الحساب غير موجود أو لا تملك صلاحية الوصول إليه' });
            if (account.status === 'banned') {
                return res.status(409).json({ success: false, error: 'الحساب محظور. اتبع مراجعة WhatsApp الرسمية يدويًا أولًا؛ لا يسمح النظام بإعادة تنشيطه آليًا.' });
            }
            if (account.status !== 'connected' || !WhatsAppManager.isReady(account.id)) {
                return res.status(409).json({ success: false, error: 'لا يمكن إعادة تفعيل الحساب قبل اتصال جلسة WhatsApp وجاهزيتها فعليًا' });
            }
            await query(`UPDATE accounts SET health_status='unknown',task_status='idle',updated_at=NOW() WHERE id=$1`, [account.id]);
            await query(`UPDATE link_import_account_guards SET circuit_state='CLOSED',reason_code=NULL,reason=NULL,opened_at=NULL,consecutive_503=0,updated_at=NOW() WHERE account_id=$1`, [account.id]).catch(() => {});
            return res.json({ success: true, account: { ...account, health_status: 'unknown', task_status: 'idle' }, message: 'تمت إعادة الفحص يدويًا فقط بعد جاهزية الجلسة. سيبقى الحساب تحت المراقبة أثناء أول عملية.' });
        } catch (error) { return res.status(400).json({ success: false, error: error.message }); }
    },
    async emergencyStopJoinAutomation(req, res) {
        try {
            if (!canOperate(req)) return res.status(403).json({ success: false, error: 'صلاحية المشاهدة فقط لا تسمح بالإيقاف الطارئ' });
            const userId = currentUserId(req);
            await query(`INSERT INTO join_automation_settings (user_id,automation_enabled,updated_at) VALUES ($1,FALSE,NOW()) ON CONFLICT (user_id) DO UPDATE SET automation_enabled=FALSE,updated_at=NOW()`, [userId]);
            const cancelledJobs = await QueueManager.cancelUserLinkImportJobs(userId);
            const affected = await query(`UPDATE link_import_operations SET status='paused',next_run_at=NULL,updated_at=NOW() WHERE user_id=$1 AND status IN ('pending','retry','processing','paused')`, [userId]);
            await query(`UPDATE link_import_outbox SET status='CANCELLED',processed_at=COALESCE(processed_at,NOW()),lease_expires_at=NULL,last_error='Emergency Stop',updated_at=NOW() WHERE user_id=$1 AND status IN ('PENDING','PROCESSING')`, [userId]);
            await query(`UPDATE link_import_tasks SET status='paused',updated_at=NOW() WHERE user_id=$1 AND status='pending'`, [userId]);
            await query(`INSERT INTO link_import_events(user_id,event_type,payload) VALUES($1,'emergency_stop',$2::jsonb)`, [userId, JSON.stringify({ cancelledJobs, openOperations: Number(affected?.rowCount || 0), reason: 'manual_emergency_stop' })]).catch(() => {});
            return res.json({ success: true, automationEnabled: false, cancelledJobs, pausedOperations: Number(affected?.rowCount || 0), message: 'تم إيقاف أتمتة الانضمام بالكامل. لم يتم حذف السجل التاريخي.' });
        } catch (error) { return res.status(400).json({ success: false, error: error.message }); }
    },
    async stopJoinAutomationAccount(req, res) {
        try {
            if (!canOperate(req)) return res.status(403).json({ success: false, error: 'صلاحية المشاهدة فقط لا تسمح بإيقاف الحساب' });
            const userId = currentUserId(req);
            const account = await queryOne(`SELECT id,name,status FROM accounts WHERE id=$1 AND ($2::boolean OR user_id=$3)`, [req.params.accountId, isAdminUser(req), userId]);
            if (!account) return res.status(404).json({ success: false, error: 'الحساب غير موجود أو لا تملك صلاحية الوصول إليه' });
            await query(`UPDATE accounts SET task_status='stopped',updated_at=NOW() WHERE id=$1`, [account.id]);
            await query(`INSERT INTO link_import_account_guards(account_id,circuit_state,reason_code,reason,opened_at,last_signal_at,updated_at) VALUES($1,'OPEN','MANUAL_ACCOUNT_STOP','تم إيقاف الحساب يدويًا',NOW(),NOW(),NOW()) ON CONFLICT(account_id) DO UPDATE SET circuit_state='OPEN',reason_code='MANUAL_ACCOUNT_STOP',reason='تم إيقاف الحساب يدويًا',opened_at=COALESCE(link_import_account_guards.opened_at,NOW()),last_signal_at=NOW(),updated_at=NOW()`, [account.id]).catch(() => {});
            const stopped = await LinkImportService.stopAccountOperations(account.id, 'تم إيقاف الحساب يدويًا من أتمتة الانضمام');
            await query(`INSERT INTO link_import_events(user_id,event_type,account_id,payload) VALUES($1,'account_manual_stop',$2,$3::jsonb)`, [userId, account.id, JSON.stringify({ stoppedOperations: stopped })]).catch(() => {});
            return res.json({ success: true, accountId: account.id, stoppedOperations: stopped, message: 'تم إيقاف الحساب وإلغاء أعمال الانضمام المستقبلية.' });
        } catch (error) { return res.status(400).json({ success: false, error: error.message }); }
    },
    async getJoinAutomationSettings(req, res) {
        try {
            const userId = currentUserId(req);
            const row = await queryOne(`SELECT * FROM join_automation_settings WHERE user_id=$1`, [userId]);
            const defaults = { automation_enabled: true, min_delay_seconds: 60, max_delay_seconds: 180, max_concurrent_jobs: 1, retry_count: 2, retry_backoff_seconds: 15, queue_priority: 5, daily_operation_limit: 10, daily_limit_protection_enabled: false, cycle_limit: 30, cycle_duration_minutes: 60, auto_resume: true, account_settings: {} };
            return res.json({ success: true, settings: { ...defaults, ...(row || {}), account_settings: parseJSONValue(row?.account_settings, {}) } });
        } catch (error) { return res.status(500).json({ success: false, error: error.message }); }
    },
    async updateJoinAutomationSettings(req, res) {
        try {
            if (!canOperate(req)) return res.status(403).json({ success: false, error: 'صلاحية المشاهدة فقط لا تسمح بتعديل الإعدادات' });
            const userId = currentUserId(req);
            const body = req.body || {};
            const minDelaySeconds = Math.max(0, Math.floor(Number(body.minDelaySeconds ?? body.min_delay_seconds ?? 60)));
            const maxDelaySeconds = Math.max(minDelaySeconds, Math.floor(Number(body.maxDelaySeconds ?? body.max_delay_seconds ?? 180)));
            const maxConcurrentJobs = Math.min(10, Math.max(1, Math.floor(Number(body.maxConcurrentJobs ?? body.max_concurrent_jobs ?? 1))));
            const retryCount = Math.min(5, Math.max(0, Math.floor(Number(body.retryCount ?? body.retry_count ?? 2))));
            const retryBackoffSeconds = Math.min(3600, Math.max(1, Math.floor(Number(body.retryBackoffSeconds ?? body.retry_backoff_seconds ?? 15))));
            const queuePriority = Math.min(10, Math.max(1, Math.floor(Number(body.queuePriority ?? body.queue_priority ?? 5))));
            const dailyOperationLimit = Math.min(5000, Math.max(1, Math.floor(Number(body.dailyOperationLimit ?? body.daily_operation_limit ?? 10))));
            const dailyLimitProtectionEnabled = Boolean(body.dailyLimitProtectionEnabled ?? body.daily_limit_protection_enabled ?? false);
            const cycleLimit = 30;
            const cycleDurationMinutes = 60;
            const autoResume = body.autoResume ?? body.auto_resume ?? true;
            const automationEnabled = body.automationEnabled ?? body.automation_enabled ?? true;
            const accountSettings = body.accountSettings && typeof body.accountSettings === 'object' ? body.accountSettings : {};
            const accountIds = Object.keys(accountSettings).filter(id => /^[0-9a-f-]{36}$/i.test(id));
            if (accountIds.length) {
                const permitted = await queryAll(`SELECT id FROM accounts WHERE id=ANY($1::uuid[]) AND ($2::boolean OR user_id=$3)`, [accountIds, isAdminUser(req), userId]);
                if (permitted.length !== accountIds.length) return res.status(403).json({ success: false, error: 'يوجد إعداد لحساب غير مملوك للمستخدم الحالي' });
            }
            await query(`INSERT INTO join_automation_settings (user_id,automation_enabled,min_delay_seconds,max_delay_seconds,max_concurrent_jobs,retry_count,retry_backoff_seconds,queue_priority,daily_operation_limit,daily_limit_protection_enabled,cycle_limit,cycle_duration_minutes,auto_resume,account_settings,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb,NOW()) ON CONFLICT (user_id) DO UPDATE SET automation_enabled=EXCLUDED.automation_enabled,min_delay_seconds=EXCLUDED.min_delay_seconds,max_delay_seconds=EXCLUDED.max_delay_seconds,max_concurrent_jobs=EXCLUDED.max_concurrent_jobs,retry_count=EXCLUDED.retry_count,retry_backoff_seconds=EXCLUDED.retry_backoff_seconds,queue_priority=EXCLUDED.queue_priority,daily_operation_limit=EXCLUDED.daily_operation_limit,daily_limit_protection_enabled=EXCLUDED.daily_limit_protection_enabled,cycle_limit=EXCLUDED.cycle_limit,cycle_duration_minutes=EXCLUDED.cycle_duration_minutes,auto_resume=EXCLUDED.auto_resume,account_settings=EXCLUDED.account_settings,updated_at=NOW()`, [userId, Boolean(automationEnabled), minDelaySeconds, maxDelaySeconds, maxConcurrentJobs, retryCount, retryBackoffSeconds, queuePriority, dailyOperationLimit, dailyLimitProtectionEnabled, cycleLimit, cycleDurationMinutes, Boolean(autoResume), JSON.stringify(accountSettings)]);
            if (accountIds.length) {
                for (const accountId of accountIds) {
                    const item = accountSettings[accountId] || {};
                    await query(`INSERT INTO join_automation_account_states (user_id,account_id,enabled,max_concurrent_jobs,pause_on_error,health_threshold,last_transition_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6,NOW(),NOW()) ON CONFLICT (user_id,account_id) DO UPDATE SET enabled=EXCLUDED.enabled,max_concurrent_jobs=EXCLUDED.max_concurrent_jobs,pause_on_error=EXCLUDED.pause_on_error,health_threshold=EXCLUDED.health_threshold,last_transition_at=NOW(),updated_at=NOW()`, [userId, accountId, item.enabled !== false, Math.min(3, Math.max(1, Math.floor(Number(item.maxConcurrent || 1)))), item.pauseOnError !== false, Math.min(20, Math.max(1, Math.floor(Number(item.healthThreshold || 3))))]);
                }
            }
            return res.json({ success: true, settings: { automation_enabled: Boolean(automationEnabled), min_delay_seconds: minDelaySeconds, max_delay_seconds: maxDelaySeconds, max_concurrent_jobs: maxConcurrentJobs, retry_count: retryCount, retry_backoff_seconds: retryBackoffSeconds, queue_priority: queuePriority, daily_operation_limit: dailyOperationLimit, daily_limit_protection_enabled: dailyLimitProtectionEnabled, cycle_limit: cycleLimit, cycle_duration_minutes: cycleDurationMinutes, auto_resume: Boolean(autoResume), account_settings: accountSettings } });
        } catch (error) { return res.status(400).json({ success: false, error: error.message }); }
    },
    async getJoinAutomationReport(req, res) {
        try {
            const userId = currentUserId(req);
            const linksScope = isAdminUser(req) ? '' : ' AND (wl.import_user_id=$1 OR EXISTS (SELECT 1 FROM link_import_links imported_scope WHERE imported_scope.discovered_link_id=wl.id AND imported_scope.user_id=$1) OR EXISTS (SELECT 1 FROM accounts a WHERE a.id=wl.source_account_id AND a.user_id=$1))';
            const linkParams = isAdminUser(req) ? [] : [userId];
            const [links, jobs, accounts, daily, hourly] = await Promise.all([
                queryOne(`SELECT COUNT(*) FILTER (WHERE wl.deleted=false) total,COUNT(*) FILTER (WHERE wl.deleted=false AND wl.status NOT IN ('invalid','unavailable')) valid,COUNT(*) FILTER (WHERE wl.deleted=false AND wl.status IN ('invalid','unavailable')) invalid,COALESCE(SUM(CASE WHEN wl.deleted=false THEN wl.duplicate_count ELSE 0 END),0) duplicates FROM whatsapp_links wl WHERE TRUE${linksScope}`, linkParams),
                queryOne(`SELECT COUNT(*) total,COUNT(*) FILTER (WHERE status='success') completed,COUNT(*) FILTER (WHERE status='success') successful,COUNT(*) FILTER (WHERE status IN ('failed','review')) failed,COUNT(*) FILTER (WHERE status IN ('retry','pending','processing','paused')) deferred FROM link_import_operations WHERE user_id=$1`, [userId]),
                queryAll(`SELECT a.id,a.name,a.status,a.health_status,COUNT(o.id) jobs,COUNT(o.id) FILTER (WHERE o.status='success') successful,COUNT(o.id) FILTER (WHERE o.status IN ('failed','review')) failed,MAX(o.last_error) last_error,MIN(CASE WHEN o.status IN ('pending','retry','processing','paused') THEN COALESCE(o.scheduled_at,o.created_at) END) next_operation FROM accounts a LEFT JOIN link_import_operations o ON o.account_id=a.id AND o.user_id=$1 WHERE ${isAdminUser(req) ? 'TRUE' : 'a.user_id=$1'} GROUP BY a.id,a.name,a.status,a.health_status ORDER BY jobs DESC`, [userId]),
                queryAll(`SELECT TO_CHAR(DATE_TRUNC('day',COALESCE(completed_at,created_at)),'YYYY-MM-DD') day,COUNT(*) total,COUNT(*) FILTER (WHERE status='success') successful,COUNT(*) FILTER (WHERE status IN ('failed','review')) failed FROM link_import_operations WHERE user_id=$1 GROUP BY 1 ORDER BY 1 DESC LIMIT 31`, [userId]),
                queryAll(`SELECT EXTRACT(HOUR FROM COALESCE(completed_at,created_at))::int hour,COUNT(*) total,COUNT(*) FILTER (WHERE status='success') successful FROM link_import_operations WHERE user_id=$1 GROUP BY 1 ORDER BY 1`, [userId]),
            ]);
            const totalJobs = Number(jobs?.total || 0); const successful = Number(jobs?.successful || 0); const failed = Number(jobs?.failed || 0);
            return res.json({ success: true, generatedAt: new Date().toISOString(), summary: { links: { total: Number(links?.total || 0), valid: Number(links?.valid || 0), invalid: Number(links?.invalid || 0), duplicates: Number(links?.duplicates || 0) }, jobs: { total: totalJobs, completed: Number(jobs?.completed || 0), successful, failed, deferred: Number(jobs?.deferred || 0), successRate: totalJobs ? Math.round(successful / totalJobs * 100) : 0, errorRate: totalJobs ? Math.round(failed / totalJobs * 100) : 0 } }, accounts, daily, hourly });
        } catch (error) { return res.status(500).json({ success: false, error: error.message }); }
    },
    async startJoinAutomationSearch(req, res) {
        try {
            if (!canOperate(req)) return res.status(403).json({ success: false, error: 'صلاحية المشاهدة فقط لا تسمح ببدء البحث' });
            const userId = currentUserId(req);
            const requestedIds = [...new Set((req.body?.sourceAccountIds || req.body?.accountIds || []).map(String).filter(Boolean))];
            if (!requestedIds.length) return res.status(400).json({ success: false, error: 'حدد حساب واتساب واحدًا على الأقل للبحث' });
            const requestId = String(req.get('Idempotency-Key') || req.body?.requestId || '').trim().slice(0, 255) || null;
            if (requestId) {
                const existing = await queryOne(`SELECT id,queue_job_id,status FROM join_automation_discovery_jobs WHERE user_id=$1 AND request_id=$2`, [userId, requestId]);
                if (existing) return res.status(200).json({ success: true, discoveryJobId: existing.id, jobId: existing.queue_job_id, status: existing.status, idempotent: true, message: 'الطلب مكرر؛ تمت إعادة نفس مهمة البحث بأمان' });
            }
            const discoveryJob = await queryOne(`INSERT INTO join_automation_discovery_jobs (user_id,source_account_ids,status,request_id) VALUES ($1,$2::jsonb,'queued',$3) RETURNING id`, [userId, JSON.stringify(requestedIds), requestId]);
            try {
                const queueJob = await QueueManager.enqueueLinkDiscovery({
                    discoveryJobId: discoveryJob.id,
                    userId,
                    sourceAccountIds: requestedIds,
                    isAdmin: isAdminUser(req),
                });
                await query(`UPDATE join_automation_discovery_jobs SET queue_job_id=$1,updated_at=NOW() WHERE id=$2`, [String(queueJob.id), discoveryJob.id]);
                return res.status(202).json({
                    success: true,
                    discoveryJobId: discoveryJob.id,
                    jobId: String(queueJob.id),
                    status: 'queued',
                    message: 'تم وضع البحث الحقيقي في الطابور وسيتم تحديث حالته في لوحة التحكم',
                });
            } catch (error) {
                await query(`UPDATE join_automation_discovery_jobs SET status='failed',error=$1,completed_at=NOW(),updated_at=NOW() WHERE id=$2`, [error.message, discoveryJob.id]).catch(() => {});
                throw error;
            }
        } catch (error) { return res.status(400).json({ success: false, error: error.message }); }
    },
    async stopJoinAutomationSearch(req, res) {
        try {
            if (!canOperate(req)) return res.status(403).json({ success: false, error: 'صلاحية المشاهدة فقط لا تسمح بإيقاف البحث' });
            const userId = currentUserId(req);
            const requestedIds = [...new Set((req.body?.sourceAccountIds || []).map(String).filter(Boolean))];
            const result = await LinkDiscoveryService.stop({ userId, sourceAccountIds: requestedIds, isAdmin: isAdminUser(req) });
            return res.json({ success: true, ...result });
        } catch (error) { return res.status(400).json({ success: false, error: error.message }); }
    },
    async revalidateJoinAutomationLink(req, res) {
        try {
            if (!canOperate(req)) return res.status(403).json({ success: false, error: 'صلاحية المشاهدة فقط لا تسمح بإعادة التحقق' });
            const userId = currentUserId(req);
            const link = await queryOne(`SELECT wl.* FROM whatsapp_links wl WHERE wl.id=$1 AND wl.deleted=false AND (${isAdminUser(req) ? 'TRUE' : '(wl.import_user_id=$2 OR EXISTS (SELECT 1 FROM accounts a WHERE a.id=wl.source_account_id AND a.user_id=$2))'})`, isAdminUser(req) ? [req.params.id] : [req.params.id, userId]);
            if (!link) return res.status(404).json({ success: false, error: 'الرابط غير موجود' });
            const parsed = require('../services/LinkUrlProcessingService').parseSupportedUrl(link.whatsapp_link);
            const status = parsed.ok ? (link.joined ? 'joined' : 'new') : 'invalid';
            const processingStatus = parsed.ok ? (link.joined ? 'completed' : 'new') : 'invalid';
            await query(`UPDATE whatsapp_links SET status=$1,processing_status=$2,last_verified_at=NOW(),updated_at=NOW() WHERE id=$3`, [status, processingStatus, link.id]);
            SocketBridge.emit('join_automation:link_revalidated', { userId, linkId: link.id, status });
            return res.json({ success: true, linkId: link.id, status, valid: parsed.ok });
        } catch (error) { return res.status(400).json({ success: false, error: error.message }); }
    },
    async getJoinAutomationLinkDetails(req, res) {
        try {
            const userId = currentUserId(req);
            const link = await queryOne(`SELECT wl.*,a.name account_name,a.phone_number account_phone,lil.url original_url,lil.canonical_url normalized_url,lil.invite_code FROM whatsapp_links wl LEFT JOIN accounts a ON a.id=wl.source_account_id LEFT JOIN link_import_links lil ON lil.discovered_link_id=wl.id WHERE wl.id=$1 AND (${isAdminUser(req) ? 'TRUE' : '(wl.import_user_id=$2 OR EXISTS (SELECT 1 FROM accounts a_scope WHERE a_scope.id=wl.source_account_id AND a_scope.user_id=$2))'})`, isAdminUser(req) ? [req.params.id] : [req.params.id, userId]);
            if (!link) return res.status(404).json({ success: false, error: 'الرابط غير موجود' });
            const operationScope = isAdminUser(req) ? '' : ' AND o.user_id=$2';
            const operations = await queryAll(`SELECT o.*,t.status task_status,t.created_at task_created_at,l.canonical_url url FROM link_import_operations o JOIN link_import_tasks t ON t.id=o.task_id JOIN link_import_links l ON l.id=o.link_id WHERE l.discovered_link_id=$1${operationScope} ORDER BY o.created_at DESC`, isAdminUser(req) ? [link.id] : [link.id, userId]);
            const operationIds = operations.map(item => item.id);
            const events = operationIds.length ? await queryAll(`SELECT * FROM link_import_events WHERE link_id=$1 OR operation_id=ANY($2::uuid[]) ORDER BY created_at DESC LIMIT 200`, [link.id, operationIds]) : await queryAll(`SELECT * FROM link_import_events WHERE link_id=$1 ORDER BY created_at DESC LIMIT 200`, [link.id]);
            return res.json({ success: true, link: { ...link, source_history: parseJSONValue(link.source_history), discovered_by_account_ids: parseJSONValue(link.discovered_by_account_ids) }, operations, events });
        } catch (error) { return res.status(500).json({ success: false, error: error.message }); }
    },
    async archiveJoinAutomationLink(req, res) {
        try {
            if (!canOperate(req)) return res.status(403).json({ success: false, error: 'صلاحية المشاهدة فقط لا تسمح بأرشفة الرابط' });
            const userId = currentUserId(req);
            const link = await queryOne(`SELECT wl.id FROM whatsapp_links wl WHERE wl.id=$1 AND (${isAdminUser(req) ? 'TRUE' : '(wl.import_user_id=$2 OR EXISTS (SELECT 1 FROM accounts a WHERE a.id=wl.source_account_id AND a.user_id=$2))'})`, isAdminUser(req) ? [req.params.id] : [req.params.id, userId]);
            if (!link) return res.status(404).json({ success: false, error: 'الرابط غير موجود' });
            await query(`UPDATE whatsapp_links SET deleted=true,status='archived',processing_status='archived',next_operation_at=NULL,notes=COALESCE(notes,'') || CASE WHEN COALESCE(notes,'')='' THEN 'تمت الأرشفة يدويًا' ELSE E'\\nتمت الأرشفة يدويًا' END,updated_at=NOW() WHERE id=$1`, [link.id]);
            await LinkImportService.recordAudit({ actorId: userId, action: 'LINK_ARCHIVE', entityType: 'whatsapp_link', entityId: link.id, after: { archived: true }, ip: req.ip, userAgent: req.get('user-agent') });
            SocketBridge.emit('join_automation:link_archived', { userId, linkId: link.id });
            return res.json({ success: true, linkId: link.id, archived: true });
        } catch (error) { return res.status(400).json({ success: false, error: error.message }); }
    },
    async deduplicateJoinAutomationLinks(req, res) {
        try {
            if (!canOperate(req)) return res.status(403).json({ success: false, error: 'صلاحية المشاهدة فقط لا تسمح بإزالة التكرارات' });
            const userId = currentUserId(req);
            const scope = isAdminUser(req) ? '' : 'WHERE EXISTS (SELECT 1 FROM accounts a WHERE a.id=wl.source_account_id AND a.user_id=$1)';
            const groups = await queryAll(`SELECT wl.whatsapp_link,array_agg(wl.id::text ORDER BY wl.discovered_at ASC) ids FROM whatsapp_links wl ${scope} GROUP BY wl.whatsapp_link HAVING COUNT(*)>1`, isAdminUser(req) ? [] : [userId]);
            let removed = 0;
            for (const group of groups) {
                const ids = group.ids || [];
                const duplicates = ids.slice(1);
                if (!duplicates.length) continue;
                await query(`UPDATE whatsapp_links SET duplicate_count=duplicate_count+$1,updated_at=NOW() WHERE id=$2`, [duplicates.length, ids[0]]);
                await query(`UPDATE whatsapp_links SET deleted=true,status='archived',processing_status='archived',next_operation_at=NULL,notes=COALESCE(notes,'') || CASE WHEN COALESCE(notes,'')='' THEN 'أرشفة تلقائية لسجل مكرر' ELSE E'\\nأرشفة تلقائية لسجل مكرر' END,updated_at=NOW() WHERE id=ANY($1::uuid[]) AND deleted=false`, [duplicates]);
                removed += duplicates.length;
            }
            return res.json({ success: true, groups: groups.length, removed });
        } catch (error) { return res.status(400).json({ success: false, error: error.message }); }
    },

    // ── استيراد روابط Word ومهام Account × Link ─────────────────────────────
    async previewLinkFile(req, res) {
        try {
            const preview = await LinkImportService.previewFile({ userId: currentUserId(req), filename: req.body?.filename, contentBase64: req.body?.contentBase64 });
            return res.json({ success: true, preview });
        } catch (error) { return res.status(400).json({ success: false, error: error.message }); }
    },
    async saveLinkFile(req, res) {
        try {
            const requestId = String(req.get('Idempotency-Key') || req.body?.requestId || '').trim() || null;
            const actorId = currentUserId(req);
            const summary = await LinkImportService.saveImport({ userId: actorId, filename: req.body?.filename, contentBase64: req.body?.contentBase64, requestId });
            if (!summary?.idempotent) await LinkImportService.recordAudit({ actorId, action: 'IMPORT', entityType: 'whatsapp_link_import', entityId: summary?.sourceId, after: { filename: summary?.filename, total: summary?.total, newCount: summary?.newCount }, ip: req.ip, userAgent: req.get('user-agent') });
            return res.json({ success: true, summary, idempotent: Boolean(summary?.idempotent) });
        } catch (error) { return res.status(400).json({ success: false, error: error.message }); }
    },
    async importLinkFile(req, res) { return this.saveLinkFile(req, res); },
    async importWordLinks(req, res) { return this.saveLinkFile(req, res); },
    async listImportSources(req, res) {
        try { return res.json({ success: true, sources: await LinkImportService.listImportSources(currentUserId(req), req.query?.limit) }); }
        catch (error) { return res.status(500).json({ success: false, error: error.message }); }
    },
    async listImportedLinks(req, res) {
        try { return res.json({ success: true, links: await LinkImportService.listLinks(currentUserId(req), req.query) }); }
        catch (error) { return res.status(500).json({ success: false, error: error.message }); }
    },
    async createImportTask(req, res) {
        try {
            if (!canOperate(req)) return res.status(403).json({ success: false, error: 'صلاحية المشاهدة فقط لا تسمح بإنشاء مهمة' });
            const requestId = String(req.get('Idempotency-Key') || req.body?.requestId || '').trim() || null;
            const actorId = currentUserId(req);
            const result = await LinkImportService.createTask({ userId: actorId, linkIds: req.body?.linkIds, accountIds: req.body?.accountIds, settings: req.body?.settings, isAdmin: isAdminUser(req), requestId });
            if (!result.idempotent) await LinkImportService.recordAudit({ actorId, action: 'JOB_CREATE', entityType: 'whatsapp_task', entityId: result.task?.id, after: { totalOperations: result.totalOperations, distributionMode: result.distributionMode }, ip: req.ip, userAgent: req.get('user-agent') });
            return res.status(result.idempotent ? 200 : 201).json({ success: true, ...result });
        } catch (error) { return res.status(400).json({ success: false, error: error.message }); }
    },
    async getImportDashboard(req, res) {
        try {
            const dashboard = await LinkImportService.taskDashboard(currentUserId(req), req.params.taskId);
            if (!dashboard) return res.status(404).json({ success: false, error: 'المهمة غير موجودة' });
            return res.json({ success: true, ...dashboard });
        } catch (error) { return res.status(500).json({ success: false, error: error.message }); }
    },
    async controlImportTask(req, res) {
        try {
            if (!canOperate(req)) return res.status(403).json({ success: false, error: 'صلاحية المشاهدة فقط لا تسمح بالتحكم بالمهمة' });
            return res.json({ success: true, task: await LinkImportService.updateTaskStatus(currentUserId(req), req.params.taskId, req.body?.status) }); }
        catch (error) { return res.status(400).json({ success: false, error: error.message }); }
    },
    async retryImportOperation(req, res) {
        try {
            if (!canOperate(req)) return res.status(403).json({ success: false, error: 'صلاحية المشاهدة فقط لا تسمح بإعادة المحاولة' });
            const operation = await queryOne(`SELECT o.id, o.account_id, o.link_id, o.task_id, o.user_id, a.status account_status, a.health_status, a.task_status, COALESCE(g.circuit_state,'CLOSED') circuit_state, g.reason_code, COALESCE(s.automation_enabled,TRUE) automation_enabled FROM link_import_operations o JOIN accounts a ON a.id=o.account_id JOIN link_import_tasks t ON t.id=o.task_id LEFT JOIN link_import_account_guards g ON g.account_id=o.account_id LEFT JOIN join_automation_settings s ON s.user_id=t.user_id WHERE o.id=$1 AND o.user_id=$2`, [req.params.operationId, currentUserId(req)]);
            if (!operation) return res.status(404).json({ success: false, error: 'العملية غير موجودة' });
            if (operation.automation_enabled === false || operation.account_status === 'banned' || operation.circuit_state === 'OPEN' || ['protected','blocked'].includes(operation.health_status) || operation.task_status === 'stopped') return res.status(409).json({ success: false, error: 'لا يمكن إعادة المحاولة لأن حساب WhatsApp محمي أو محظور', code: operation.automation_enabled === false ? 'AUTOMATION_DISABLED' : operation.account_status === 'banned' ? 'ACCOUNT_BANNED' : 'ACCOUNT_PROTECTED', reasonCode: operation.reason_code || null });
            await query(`UPDATE link_import_operations SET status='retry',current_stage='pending',join_status='pending',publish_status='pending',leave_status=CASE WHEN leave_status='skipped' THEN 'skipped' ELSE 'pending' END,last_error=NULL,error_code=NULL,next_retry_at=NULL,completed_at=NULL,join_started_at=NULL,join_completed_at=NULL,publish_started_at=NULL,publish_completed_at=NULL,leave_started_at=NULL,leave_completed_at=NULL,wait_started_at=NULL,wait_completed_at=NULL,lease_expires_at=NULL,heartbeat_at=NULL,updated_at=NOW() WHERE id=$1 AND status IN ('failed','review','skipped')`, [operation.id]);
            await LinkImportService.scheduleNextOperation(operation.task_id, 0, `link-import-manual-retry-${operation.id}`);
            return res.json({ success: true, queued: true });
        } catch (error) { return res.status(400).json({ success: false, error: error.message }); }
    },
    async exportJoinAutomationLog(req, res) {
        try {
            const userId = currentUserId(req);
            let taskId = req.query?.taskId;
            if (!taskId) {
                const latest = await queryOne(`SELECT id FROM link_import_tasks WHERE user_id=$1 ORDER BY created_at DESC LIMIT 1`, [userId]);
                taskId = latest?.id;
            }
            if (!taskId) return res.status(404).json({ success: false, error: 'لا يوجد سجل عمليات بعد' });
            const dashboard = await LinkImportService.taskDashboard(userId, taskId);
            if (!dashboard) return res.status(404).json({ success: false, error: 'المهمة غير موجودة' });
            const header = 'التاريخ,الحساب,الرابط,معرف العملية,المرحلة,الحالة,آخر خطأ,المحاولات,المدة';
            const rows = (dashboard.operations || []).map(item => [item.updated_at || item.completed_at || item.created_at, item.account_name, item.url, item.id, item.current_stage, item.status, item.last_error || '', item.attempt_count || 0, item.completed_at && item.created_at ? Math.max(0, new Date(item.completed_at).getTime() - new Date(item.created_at).getTime()) : ''].map(value => `"${String(value ?? '').replace(/"/g, '""')}"`).join(','));
            const csv = '\\uFEFF' + [header, ...rows].join('\\n');
            res.setHeader('Content-Type', 'text/csv; charset=utf-8');
            res.setHeader('Content-Disposition', 'attachment; filename="join-automation-operation-log.csv"');
            return res.send(csv);
        } catch (error) { return res.status(500).json({ success: false, error: error.message }); }
    },
    async exportImportedLinks(req, res) {
        try {
            const links = await LinkImportService.listLinks(currentUserId(req), req.query);
            const csv = '\uFEFF' + ['الرابط,الحالة,آخر خطأ,تاريخ الإضافة', ...links.map(l => [l.canonical_url, l.last_status || '', l.last_error || '', l.created_at].map(v => `"${String(v).replace(/"/g, '""')}"`).join(','))].join('\\n');
            res.setHeader('Content-Type', 'text/csv; charset=utf-8');
            res.setHeader('Content-Disposition', 'attachment; filename="whatsapp-link-import.csv"');
            return res.send(csv);
        } catch (error) { return res.status(500).json({ success: false, error: error.message }); }
    },

    async listWhatsAppAuditLogs(req, res) {
        try {
            const result = await LinkImportService.listAuditLogs({ userId: currentUserId(req), isAdmin: isAdminUser(req), page: req.query?.page, pageSize: req.query?.pageSize, action: req.query?.action, entityType: req.query?.entityType, from: req.query?.from, to: req.query?.to, search: req.query?.search });
            return res.json({ success: true, ...result });
        } catch (error) { return res.status(500).json({ success: false, error: error.message }); }
    },
    async getWhatsAppAuditStats(req, res) {
        try {
            const result = await LinkImportService.auditStats({ userId: currentUserId(req), isAdmin: isAdminUser(req), action: req.query?.action, entityType: req.query?.entityType, from: req.query?.from, to: req.query?.to, search: req.query?.search });
            return res.json({ success: true, stats: result });
        } catch (error) { return res.status(500).json({ success: false, error: error.message }); }
    },
    async getWhatsAppAuditLog(req, res) {
        try {
            const item = await LinkImportService.getAuditLog(currentUserId(req), req.params.id, isAdminUser(req));
            if (!item) return res.status(404).json({ success: false, error: 'سجل التدقيق غير موجود أو لا تملك صلاحية الوصول إليه' });
            return res.json({ success: true, item });
        } catch (error) { return res.status(500).json({ success: false, error: error.message }); }
    },
    async exportWhatsAppAuditLogs(req, res) {
        try {
            const result = await LinkImportService.listAuditLogs({ userId: currentUserId(req), isAdmin: isAdminUser(req), page: 1, pageSize: 200, action: req.query?.action, entityType: req.query?.entityType, from: req.query?.from, to: req.query?.to, search: req.query?.search });
            const quote = value => `"${String(value ?? '').replace(/"/g, '""')}"`;
            const header = ['التاريخ', 'المستخدم', 'الإجراء', 'نوع الكيان', 'معرف الكيان', 'الحالة السابقة', 'الحالة اللاحقة', 'IP'].join(',');
            const rows = result.items.map(item => [item.created_at, item.actor_username, item.action, item.entity_type, item.entity_id, JSON.stringify(item.before_state), JSON.stringify(item.after_state), item.ip].map(quote).join(','));
            await LinkImportService.recordAudit({ actorId: currentUserId(req), action: 'EXPORT', entityType: 'whatsapp_audit_logs', after: { format: 'csv', count: result.items.length }, ip: req.ip, userAgent: req.get('user-agent') });
            res.setHeader('Content-Type', 'text/csv; charset=utf-8');
            res.setHeader('Content-Disposition', 'attachment; filename="whatsapp-audit-logs.csv"');
            return res.send('\uFEFF' + [header, ...rows].join('\n'));
        } catch (error) { return res.status(500).json({ success: false, error: error.message }); }
    },

    // ── حالة الـ workers ──────────────────────────────────────────────────────
    async getWorkersStatus(req, res) {
        try {
            let workers = TelegramService.getAllWorkersStatus();
            if (!isAdminUser(req)) {
                const owned = await queryAll(`SELECT id FROM telegram_accounts WHERE user_id=$1`, [currentUserId(req)]);
                const ownedIds = new Set(owned.map(row => String(row.id)));
                workers = workers.filter(worker => ownedIds.has(String(worker.accountId || worker.account_id || worker.id)));
            }
            return res.json({ success: true, workers });
        } catch (err) {
            return res.status(500).json({ success: false, error: err.message });
        }
    },
};

module.exports = TelegramController;
