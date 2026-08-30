'use strict';
/**
 * WhatsAppManager — Baileys WhatsApp Session Manager
 * [FIX-SESSION] استبدال useMultiFileAuthState (/tmp) بـ PostgreSQLAuthState
 * لأن /tmp يُمسح عند كل Railway deploy مما يُفقد الجلسة ويستوجب QR جديد.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * إعادة الهيكلة الحالية تضيف:
 *
 *  [البند 1] sendMessageSafe() — نقطة الإرسال المركزية الوحيدة المعتمدة:
 *      كل إرسال في المشروع (Broadcast/Campaign/LivePublish/
 *      GroupJoiner...) يجب أن يمر عبرها. تقوم تلقائياً بمحاكاة سلوك بشري
 *      ثم تنفيذ الإرسال. الدوال القديمة (sendMessage/sendTextMessage/
 *      sendGroupMessage) بقيت كما هي لأي كود لا يزال يستدعيها مباشرة
 *      (توافق عكسي)، لكنها الآن أيضاً تمر داخلياً عبر sendMessageSafe.
 *
 *  [البند 3] حماية الحساب عند forbidden/banned:
 *      يميّز forbidden عن disconnected عادي، ويوقف إعادة الاتصال الآلي،
 *      ثم يكتب status='banned' وhealth_status='protected' وtask_status='stopped'
 *      ويوقف عمليات أتمتة الانضمام والحملات المرتبطة بالحساب.
 *
 *  [البند 9] محاكاة السلوك البشري:
 *      قبل أي رسالة: sendPresenceUpdate('composing') ثم انتظار مدة مرتبطة
 *      بطول النص، ثم الإرسال، ثم sendPresenceUpdate('paused').
 * ─────────────────────────────────────────────────────────────────────────
 */
const { default: makeWASocket, DisconnectReason, fetchLatestBaileysVersion, WAMessageStatus } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const SystemDB = require('../database/SystemDB');
const DatabaseManager = require('../database/DatabaseManager');
const SocketBridge = require('../core/SocketBridge');
const { usePostgreSQLAuthState, deletePostgreSQLAuthState, repairCorruptedSessions } = require('./PostgreSQLAuthState');
const { query, queryOne } = require('../lib/postgres');
const { shouldReconnect: shouldReconnectByPolicy } = require('./AccountProtectionPolicy');
const { metrics } = require('../api/middleware/MetricsMiddleware');

const sessions    = new Map();    // accountId → socket
const qrData      = new Map();    // accountId → { qr, timestamp }
const connecting  = new Set();    // accountId
const reconnectAt = new Map();    // accountId → attempt count (exponential backoff)

// [FIX-LIVE-PUBLISH-READY] sessions.set() يحدث فور إنشاء الـ socket، أي قبل
// اكتمال مصافحة Baileys الفعلية مع واتساب (connection === 'open'). كان هذا
// يسبب فشلاً صامتاً في النشر المباشر: يجتاز الكود فحص "الحساب متصل؟" لأن
// الـ socket موجود في sessions، لكن أول محاولة إرسال فعلية تفشل فوراً لأن
// الاتصال لم يكتمل بعد — فتُسجَّل المجموعة "مكتملة" ضمن خطأ واحد دون أي
// رسائل مُرسلة أو فاشلة فعلياً (تحديداً بعد إعادة تشغيل الخادم على Railway،
// حين تكون كل الحسابات لا تزال في طور إعادة الاتصال).
// هذا الـ Set يتتبع الحسابات التي أكدت فعلياً الوصول لـ connection === 'open'.
const readySessions = new Set();  // accountId

// [PRIVATE-SEND-ACK-TRACKING] تتبّع تأكيد استلام خادم واتساب الفعلي، مُقيَّد
// على الرسائل الخاصة (private) فقط — لا يُطبَّق على المجموعات إطلاقاً، بعد
// أن ثبت سابقاً أن تطبيقه على المجموعات كان يُفشِل إرسالاً جماعياً كان
// يعمل بنجاح فعلياً (على الأرجح لأن حدث messages.update للمجموعات يختلف في
// توقيته/بنيته عن الخاص). نتيجة sock.sendMessage() الناجحة محلياً (key.id
// موجود) لا تعني وصول الرسالة فعلياً لخوادم واتساب — التأكيد الحقيقي الوحيد
// هو حدث messages.update لاحق لنفس key.id بحالة SERVER_ACK أو أعلى.
const _pendingPrivateAcks = new Map(); // messageId → { resolve, reject, timer, jid }
const PRIVATE_ACK_TIMEOUT_MS = 30_000; // مهلة أطول من محاولة سابقة (كانت 12 ثانية وقد تكون قصيرة جداً)

function _waitForPrivateAck(messageId, jid) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            _pendingPrivateAcks.delete(messageId);
            console.warn(`[WAManager][PRIVATE-ACK] TIMEOUT — لم يصل أي تحديث حالة لـ messageId=${messageId} jid=${jid} خلال ${PRIVATE_ACK_TIMEOUT_MS / 1000}ث`);
            reject(Object.assign(
                new Error('لم يصل تأكيد استلام من خادم واتساب خلال المهلة — الرسالة قد تكون لم تُبَث فعلياً'),
                { protectionReason: 'send_unconfirmed' }
            ));
        }, PRIVATE_ACK_TIMEOUT_MS);
        _pendingPrivateAcks.set(messageId, { resolve, reject, timer, jid });
    });
}

function _resolvePrivateAck(messageId, status) {
    const entry = _pendingPrivateAcks.get(messageId);
    if (!entry) return; // ليست رسالة خاصة قيد التتبع (أو مجموعة، أو انتهت مهلتها بالفعل)
    clearTimeout(entry.timer);
    _pendingPrivateAcks.delete(messageId);
    console.log(`[WAManager][PRIVATE-ACK] وصل تحديث حالة — messageId=${messageId} jid=${entry.jid} status=${status}`);
    if (status === WAMessageStatus.ERROR) {
        entry.reject(Object.assign(new Error('خادم واتساب أعاد حالة خطأ (ERROR) لهذه الرسالة'), { protectionReason: 'send_server_error' }));
    } else {
        entry.resolve(status);
    }
}

// [البند 4: Multi-Tenant] لا نخزّن user_id بشكل ثابت — نجلبه عند الحاجة عبر
// _getAccountMeta() مع كاش قصير العمر (60 ثانية) لكل accountId لتفادي ضغط DB
// مفرط دون أن نفترض user_id ثابتاً بمعزل عن قاعدة البيانات (مصدر الحقيقة الوحيد).
const _accountMetaCache = new Map(); // accountId → { userId, createdAt, fetchedAt }
const ACCOUNT_META_TTL_MS = 60_000;

let _io = null;

// 403/forbidden من WhatsApp يُعامل كحالة حماية فورية.
// لا نعيد الاتصال تلقائيًا بعد forbidden؛ يلزم تدخل المستخدم ومراجعة رسمية.

function emit(event, data) {
    try { SocketBridge.emit(event, data); } catch {}
    try { if (_io) _io.emit(event, data); } catch {}
}

class WhatsAppManager {

    setIO(io) { _io = io; }

    getSession(accountId) { return sessions.get(accountId) || null; }

    // [FIX-LIVE-PUBLISH-READY] هل الحساب متصل فعلياً وجاهز للإرسال الآن؟
    // خلافاً لـ getSession() (يتحقق فقط من وجود الـ socket في الذاكرة)، هذه
    // الدالة تتحقق من أن اتصال Baileys وصل فعلياً لحالة 'open' على الأقل مرة.
    isReady(accountId) { return sessions.has(accountId) && readySessions.has(accountId); }

    // [FIX-LIVE-PUBLISH-READY] ينتظر جاهزية الحساب حتى مهلة زمنية محددة بدل
    // الفشل الفوري — يُستخدم فقط في نقاط الإرسال الحرجة (النشر المباشر) حيث
    // يكون الحساب غالباً في طور إعادة الاتصال بعد إعادة تشغيل الخادم.
    async waitUntilReady(accountId, timeoutMs = 20_000, pollMs = 500) {
        const start = Date.now();
        while (Date.now() - start < timeoutMs) {
            if (this.isReady(accountId)) return true;
            if (!sessions.has(accountId) && !connecting.has(accountId)) return false; // لا محاولة اتصال جارية أصلاً
            await new Promise(r => setTimeout(r, pollMs));
        }
        return this.isReady(accountId);
    }
    isConnecting(accountId) { return connecting.has(accountId); }
    getQrStatus(accountId) { return qrData.get(accountId) || null; }

    // ── [GROUPS-LIVE] قائمة الحسابات المتصلة الآن (جلسات Baileys حيّة فعلياً) ──
    getConnectedAccountIds() { return [...sessions.keys()]; }
    isOnline(accountId) { return sessions.has(accountId); }

    // ════════════════════════════════════════════════════════════════════════
    //  [البند 4] جلب userId/created_at للحساب — Multi-Tenant، بدون Singleton مشترك
    // ════════════════════════════════════════════════════════════════════════
    async _getAccountMeta(accountId) {
        const cached = _accountMetaCache.get(accountId);
        if (cached && (Date.now() - cached.fetchedAt) < ACCOUNT_META_TTL_MS) {
            return cached;
        }
        try {
            const row = await SystemDB.get(
                `SELECT user_id, created_at FROM accounts WHERE id = $1`, [accountId]
            );
            const meta = {
                userId:    row?.user_id || null,
                createdAt: row?.created_at || null,
                fetchedAt: Date.now(),
            };
            _accountMetaCache.set(accountId, meta);
            return meta;
        } catch (err) {
            console.error(`[WAManager] _getAccountMeta(${accountId}) error:`, err.message);
            return { userId: null, createdAt: null, fetchedAt: Date.now() };
        }
    }

    _invalidateAccountMeta(accountId) {
        _accountMetaCache.delete(accountId);
    }

    async _assertAccountNotBanned(accountId, { manual = false } = {}) {
        const account = await queryOne(`SELECT status,health_status,task_status FROM accounts WHERE id=$1`, [accountId]).catch(() => null);
        const guard = await queryOne(`SELECT circuit_state,reason_code FROM link_import_account_guards WHERE account_id=$1`, [accountId]).catch(() => null);
        if (account?.status === 'banned') {
            throw new Error('تم إيقاف جلسة الحساب المحظور. استخدم طلب المراجعة الرسمي من داخل WhatsApp أولاً.');
        }
        if (!manual && (guard?.circuit_state === 'OPEN' || (account?.health_status === 'protected' && account?.task_status === 'stopped'))) {
            throw new Error('تم إيقاف جلسة الحساب للحماية. لا يوجد تشغيل أو إعادة اتصال آلي بعد الحظر/فتح Circuit Breaker؛ استخدم المراجعة الرسمية ثم أعد التفعيل يدويًا.');
        }
    }

    async _recordDisconnectSignal(accountId, statusCode) {
        if (statusCode === 403) {
            metrics.recordDisconnect403(accountId);
            metrics.recordBanSignal(accountId, 403);
        }
        if (statusCode !== 503) return null;
        metrics.recordDisconnect503(accountId);
        const guard = await queryOne(`
            INSERT INTO link_import_account_guards(account_id,circuit_state,reason_code,reason,consecutive_503,last_signal_at,updated_at)
            VALUES($1,'CLOSED',NULL,NULL,1,NOW(),NOW())
            ON CONFLICT(account_id) DO UPDATE SET
              consecutive_503=CASE WHEN link_import_account_guards.last_signal_at >= NOW()-INTERVAL '10 minutes' THEN link_import_account_guards.consecutive_503+1 ELSE 1 END,
              circuit_state=CASE WHEN (CASE WHEN link_import_account_guards.last_signal_at >= NOW()-INTERVAL '10 minutes' THEN link_import_account_guards.consecutive_503+1 ELSE 1 END) >= 3 THEN 'OPEN' ELSE link_import_account_guards.circuit_state END,
              reason_code=CASE WHEN (CASE WHEN link_import_account_guards.last_signal_at >= NOW()-INTERVAL '10 minutes' THEN link_import_account_guards.consecutive_503+1 ELSE 1 END) >= 3 THEN 'CONNECTION_503_STORM' ELSE link_import_account_guards.reason_code END,
              reason=CASE WHEN (CASE WHEN link_import_account_guards.last_signal_at >= NOW()-INTERVAL '10 minutes' THEN link_import_account_guards.consecutive_503+1 ELSE 1 END) >= 3 THEN 'تم فتح Circuit Breaker بعد تكرار انقطاع 503' ELSE link_import_account_guards.reason END,
              opened_at=CASE WHEN (CASE WHEN link_import_account_guards.last_signal_at >= NOW()-INTERVAL '10 minutes' THEN link_import_account_guards.consecutive_503+1 ELSE 1 END) >= 3 AND link_import_account_guards.opened_at IS NULL THEN NOW() ELSE link_import_account_guards.opened_at END,
              last_signal_at=NOW(),updated_at=NOW()
            RETURNING *`, [accountId]).catch(() => null);
        if (guard?.circuit_state === 'OPEN') {
            metrics.recordProtection(accountId, 'CONNECTION_503_STORM');
            await this._handleAccountProtected(accountId, 'CONNECTION_503_STORM', guard.reason || 'تكرار انقطاع الاتصال 503').catch(() => {});
        }
        return guard;
    }

    async _handleAccountProtected(accountId, reasonCode, reason) {
        await SystemDB.run(`UPDATE accounts SET health_status='protected',task_status='stopped',updated_at=NOW() WHERE id=$1 AND status <> 'banned'`, [accountId]).catch(() => {});
        await query(`INSERT INTO link_import_account_guards(account_id,circuit_state,reason_code,reason,opened_at,last_signal_at,updated_at) VALUES($1,'OPEN',$2,$3,NOW(),NOW(),NOW()) ON CONFLICT(account_id) DO UPDATE SET circuit_state='OPEN',reason_code=EXCLUDED.reason_code,reason=EXCLUDED.reason,opened_at=COALESCE(link_import_account_guards.opened_at,NOW()),updated_at=NOW()`, [accountId, reasonCode, reason]).catch(() => {});
        emit('account_status', { accountId, status: 'protected', reasonCode, reason });
        const LinkImportService = require('../api/services/LinkImportService');
        await LinkImportService.stopAccountOperations(accountId, reason).catch(() => {});
    }

    async initSession(accountId, { manual = false } = {}) {
        if (connecting.has(accountId)) return;
        if (sessions.has(accountId)) return;
        await this._assertAccountNotBanned(accountId, { manual });

        connecting.add(accountId);
        try {
            await this._startSession(accountId);
        } catch (err) {
            console.error(`[WAManager] initSession error for ${accountId}:`, err.message);
            connecting.delete(accountId);
        }
    }

    async _startSession(accountId) {
        // [FIX-SESSION] استخدام PostgreSQL بدل /tmp — الجلسة تبقى بعد كل Railway deploy
        const { state, saveCreds } = await usePostgreSQLAuthState(accountId, SystemDB);
        const { version } = await fetchLatestBaileysVersion();

        const sock = makeWASocket({
            version,
            auth: state,
            printQRInTerminal: false,
            browser: ['WhatsApp SaaS', 'Chrome', '120.0.0'],
            connectTimeoutMs: 60000,
            defaultQueryTimeoutMs: 30000,
            keepAliveIntervalMs: 25000,
            syncFullHistory: true,
            shouldSyncHistoryMessage: () => true,
            logger: { level: 'silent', trace: () => {}, debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, fatal: () => {}, child: () => ({ level: 'silent', trace: () => {}, debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, fatal: () => {}, child: () => ({}) }) },
        });

        sessions.set(accountId, sock);

        sock.ev.on('creds.update', saveCreds);

        sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
            if (qr) {
                qrData.set(accountId, { qr, timestamp: Date.now() });
                emit('qr_code', { accountId, qr });
                emit(`qr:${accountId}`, { qr });
            }

            if (connection === 'open') {
                connecting.delete(accountId);
                reconnectAt.delete(accountId); // إعادة ضبط عداد المحاولات عند نجاح الاتصال
                qrData.delete(accountId);
                readySessions.add(accountId); // [FIX-LIVE-PUBLISH-READY] الاتصال مكتمل فعلياً الآن
                this._invalidateAccountMeta(accountId);
                await SystemDB.run(
                    `UPDATE accounts SET status='connected', updated_at=NOW() WHERE id=$1 AND status <> 'banned'`, [accountId]
                ).catch(() => {});
                await query(`UPDATE link_import_account_guards SET consecutive_503=0,updated_at=NOW() WHERE account_id=$1 AND circuit_state='CLOSED'`, [accountId]).catch(() => {});
                // حفظ الحساب في Redis حتى يستعيده index.js بعد deploy
                try {
                    const SessionPersistence = require('../core/SessionPersistence');
                    await SessionPersistence.save(accountId, { accountId, connectedAt: Date.now() });
                } catch {}
                emit('account_status', { accountId, status: 'connected' });
                console.log(`[WAManager] Account ${accountId} connected.`);

                // ── مزامنة المجموعات تلقائياً عند الاتصال ─────────────────────
                setTimeout(() => {
                    try {
                        const GroupSyncService = require('../api/services/GroupSyncService');
                        GroupSyncService.triggerSync(accountId).then(result => {
                            if (result?.success) {
                                console.log(`[WAManager] Auto-sync on connect: ${result.count} مجموعة لـ ${accountId}`);
                            } else {
                                console.warn(`[WAManager] Auto-sync on connect failed for ${accountId}:`, result?.error);
                            }
                        }).catch(err => {
                            console.warn(`[WAManager] Auto-sync on connect error (${accountId}):`, err.message);
                        });
                    } catch (err) {
                        console.warn(`[WAManager] GroupSyncService require error:`, err.message);
                    }
                }, 3000);
            }

            if (connection === 'close') {
                connecting.delete(accountId);
                sessions.delete(accountId);
                readySessions.delete(accountId); // [FIX-LIVE-PUBLISH-READY] لم يعد جاهزاً بعد قطع الاتصال
                const statusCode = lastDisconnect?.error?.output?.statusCode;

                // 403/forbidden يحتاج حماية ومراجعة، وليس إعادة اتصال آلية.
                const isForbidden = statusCode === DisconnectReason.forbidden;
                const isLoggedOut = statusCode === DisconnectReason.loggedOut;
                const isBadSession = statusCode === DisconnectReason.badSession;
                const noReconnectCodes = new Set([
                    DisconnectReason.loggedOut,
                    DisconnectReason.badSession,
                    DisconnectReason.forbidden,
                ]);
                const disconnectGuard = await this._recordDisconnectSignal(accountId, statusCode);
                const shouldReconnect = shouldReconnectByPolicy({ statusCode, loggedOut: isLoggedOut, badSession: isBadSession, circuitOpen: disconnectGuard?.circuit_state === 'OPEN' }) && !noReconnectCodes.has(statusCode);

                // ═══════════════════════════════════════════════════════════════
                // انقطاع WebSocket العادي يعاد الاتصال به، أما forbidden/logout/badSession
                // فيوقف الحساب ويحتاج تدخل المستخدم؛ لا نكتب حالة disconnected عابرة.
                if (isForbidden) {
                    await this._handleAccountBanned(accountId, statusCode);
                } else if (shouldReconnect) {
                    console.log(`[WAManager] Account ${accountId} temporarily disconnected (statusCode=${statusCode}) — session still valid, reconnecting automatically...`);
                    emit('account_status', { accountId, status: 'reconnecting' });
                } else {
                    // logout حقيقي أو جلسة تالفة — هذه فعلاً الحالة الوحيدة التي
                    // تعني أن الاتصال انتهى ولن يُستعاد تلقائياً بعد الآن.
                    await SystemDB.run(
                        `UPDATE accounts SET status='disconnected', updated_at=NOW() WHERE id=$1`, [accountId]
                    ).catch(() => {});
                    emit('account_status', { accountId, status: 'disconnected' });
                }

                if (shouldReconnect) {
                    // الانقطاعات المؤقتة فقط تتبع exponential backoff: 5s, 10s, 20s, 40s, 60s.
                    const attempt = (reconnectAt.get(accountId) || 0) + 1;
                    reconnectAt.set(accountId, attempt);
                    const delay = Math.min(5000 * Math.pow(2, attempt - 1), 60000);
                    console.log(`[WAManager] Account ${accountId} disconnected — reconnecting in ${delay / 1000}s... (attempt ${attempt})`);
                    setTimeout(() => this.initSession(accountId).catch(error => console.warn(`[WAManager] reconnect blocked/failed for ${accountId}: ${error.message}`)), delay);
                } else {
                    reconnectAt.delete(accountId);
                    const reasonLabel = isForbidden ? 'forbidden/banned (confirmed)' : (disconnectGuard?.circuit_state === 'OPEN' ? 'circuit-breaker-open' : (isLoggedOut ? 'logged out' : (isBadSession ? 'bad session' : 'unknown')));
                    console.log(`[WAManager] Account ${accountId} stopped (statusCode=${statusCode}, reason=${reasonLabel}). Not reconnecting.`);
                    qrData.delete(accountId);
                    this._invalidateAccountMeta(accountId);
                    // لا نحذف جلسة الحساب عند فتح Circuit Breaker بسبب 503؛ نحافظ على الأدلة والجلسة للمراجعة.
                    if (isForbidden || isLoggedOut || isBadSession) {
                        try { const SP = require('../core/SessionPersistence'); await SP.delete(accountId); } catch {}
                        await deletePostgreSQLAuthState(accountId, SystemDB).catch(() => {});
                    }
                }
            }
        });

        sock.ev.on('messages.upsert', async ({ messages }) => {
            for (const msg of messages) {
                if (!msg.message) continue;
                emit('new_message', { accountId, message: msg });
                // Persist every text-bearing WhatsApp message for real link
                // discovery, including private messages and messages sent by the
                // account itself. Keyword alerts remain separately scoped below.
                try {
                    const KWService = require('../api/services/KeywordMonitoringService');
                    await KWService.persistMessageForDiscovery(accountId, msg).catch(err =>
                        console.warn(`[LinkDiscovery] message persist failed for ${accountId}: ${err.message}`)
                    );
                    if (!msg.key?.fromMe) {
                        KWService.enqueueMessage(accountId, msg).catch(err =>
                            console.warn(`[KeywordWorker] enqueue failed for ${accountId}: ${err.message}`)
                        );
                    }
                } catch (err) {
                    console.warn(`[KeywordWorker] load failed: ${err.message}`);
                }
            }
        });

        // [PRIVATE-SEND-ACK-TRACKING] هذا المستمع آمن بالتصميم لأنه لا يفعل
        // شيئاً إلا لو كان messageId موجوداً فعلاً في _pendingPrivateAcks —
        // أي رسالة لم تُسجَّل هناك (كل رسائل المجموعات، وأي رسالة خاصة انتهت
        // مهلة انتظارها بالفعل) تُتجاهَل بأمان دون أي أثر جانبي.
        // Baileys may deliver historical messages through history sync rather
        // than messages.upsert. Persist those messages too so a real discovery
        // run can search an existing private conversation after reconnect.
        sock.ev.on('messaging-history.set', async ({ messages = [] } = {}) => {
            try {
                const KWService = require('../api/services/KeywordMonitoringService');
                for (const msg of messages) {
                    if (msg?.message) await KWService.persistMessageForDiscovery(accountId, msg);
                }
                console.log(`[LinkDiscovery] history synced for ${accountId}: ${messages.length} messages`);
            } catch (err) {
                console.warn(`[LinkDiscovery] history persist failed for ${accountId}: ${err.message}`);
            }
        });

        sock.ev.on('messages.update', (updates) => {
            for (const u of updates) {
                const id = u.key?.id;
                if (!id) continue;
                const status = u.update?.status;
                if (status === undefined || status === null) continue;
                _resolvePrivateAck(id, status);
            }
        });

        sock.ev.on('groups.upsert', (newGroups) => {
            try {
                require('../api/services/GroupRealtimeSync').onGroupsUpsert(accountId, sock, newGroups);
            } catch (err) {
                console.error(`[WAManager] groups.upsert handler error (${accountId}):`, err.message);
            }
        });

        sock.ev.on('groups.update', (updates) => {
            try {
                require('../api/services/GroupRealtimeSync').onGroupsUpdate(accountId, sock, updates);
            } catch (err) {
                console.error(`[WAManager] groups.update handler error (${accountId}):`, err.message);
            }
        });

        sock.ev.on('group-participants.update', (update) => {
            try {
                require('../api/services/GroupRealtimeSync').onParticipantsUpdate(accountId, sock, update);
            } catch (err) {
                console.error(`[WAManager] group-participants.update handler error (${accountId}):`, err.message);
            }
        });
    }

    // ════════════════════════════════════════════════════════════════════════
    //  [البند 3] معالجة الحظر الحقيقي — تُستدعى مرة واحدة فقط عند تأكّد الحظر
    // ════════════════════════════════════════════════════════════════════════
    async _handleAccountBanned(accountId, statusCode) {
        console.error(`[WAManager] 🚫 Account ${accountId} BANNED (statusCode=${statusCode}).`);

        // 1) status = 'banned' في قاعدة البيانات (مختلف عن 'disconnected')
        try {
            await SystemDB.run(
                `UPDATE accounts SET status='banned',health_status='protected',task_status='stopped',updated_at=NOW() WHERE id=$1`, [accountId]
            );
            await query(`INSERT INTO link_import_account_guards(account_id,circuit_state,reason_code,reason,opened_at,last_signal_at,updated_at) VALUES($1,'OPEN','ACCOUNT_BANNED','WhatsApp returned 403/forbidden',NOW(),NOW(),NOW()) ON CONFLICT(account_id) DO UPDATE SET circuit_state='OPEN',reason_code='ACCOUNT_BANNED',reason='WhatsApp returned 403/forbidden',opened_at=COALESCE(link_import_account_guards.opened_at,NOW()),last_signal_at=NOW(),updated_at=NOW()`, [accountId]).catch(() => {});
        } catch (err) {
            console.error(`[WAManager] _handleAccountBanned: failed to update status:`, err.message);
        }

        // 2) Socket Notification — إشعار فوري للواجهة الأمامية
        emit('account_status', { accountId, status: 'banned' });
        emit('account_banned', { accountId, reason: 'forbidden', statusCode, timestamp: Date.now() });

        // 3) استبعاد الحساب من جميع الحملات الحالية والمستقبلية
        await this._excludeFromAllCampaigns(accountId);
    }

    // ── استبعاد حساب محظور من كل الحملات/الجداول/المهام المجدولة ─────────────
    async _excludeFromAllCampaigns(accountId) {
        // (أ) إلغاء كل المهام المجدولة (BullMQ) المرتبطة بهذا الحساب
        try {
            const JobScheduler = require('../scheduler/JobScheduler');
            await JobScheduler.removeAccountJobs(accountId);
        } catch (err) {
            console.error(`[WAManager] _excludeFromAllCampaigns: JobScheduler error:`, err.message);
        }

        // (ب) إيقاف عمليات أتمتة الانضمام المرتبطة بالحساب المحظور
        try {
            const LinkImportService = require('../api/services/LinkImportService');
            await LinkImportService.stopAccountOperations(accountId, 'تم إيقاف العملية لأن WhatsApp أبلغ عن حظر أو منع للحساب');
        } catch (err) {
            console.error(`[WAManager] _excludeFromAllCampaigns: join automation stop error:`, err.message);
        }

        // (ج) إيقاف أي broadcast_schedules نشطة كانت تعتمد حصرياً على هذا الحساب
        try {
            const accountDB = await DatabaseManager.getAccountDB(accountId);
            await accountDB.run(
                `UPDATE broadcast_schedules SET status='paused', updated_at=NOW()
                 WHERE account_id=$1 AND status='active'`,
                [accountId]
            ).catch(() => {});
            await accountDB.run(
                `UPDATE campaigns SET status='paused', updated_at=NOW()
                 WHERE status='running'`,
            ).catch(() => {});
        } catch (err) {
            console.error(`[WAManager] _excludeFromAllCampaigns: broadcast/campaign pause error:`, err.message);
        }

        console.log(`[WAManager] Account ${accountId} excluded from all current/future campaigns.`);
    }

    async connectAccount(accountId) {
        await this._assertAccountNotBanned(accountId, { manual: true });
        await this.initSession(accountId, { manual: true });
        return { success: true, message: 'Connection initiated' };
    }

    async startFreshQRSession(accountId) {
        await this._assertAccountNotBanned(accountId, { manual: true });
        const sock = sessions.get(accountId);
        if (sock) {
            try { sock.end(); } catch {}
            sessions.delete(accountId);
        }
        connecting.delete(accountId);
        qrData.delete(accountId);
        readySessions.delete(accountId); // [FIX-LIVE-PUBLISH-READY]

        await deletePostgreSQLAuthState(accountId, SystemDB).catch(() => {});

        await this.initSession(accountId, { manual: true });
        return { success: true };
    }

    async connectWithPairingCode(accountId, phoneNumber) {
        await this._assertAccountNotBanned(accountId, { manual: true });
        await this.initSession(accountId, { manual: true });
        const sock = sessions.get(accountId);
        if (!sock) throw new Error('Session not ready');
        try {
            const code = await sock.requestPairingCode(phoneNumber.replace(/\D/g, ''));
            return { success: true, code };
        } catch (err) {
            throw new Error(`Pairing code failed: ${err.message}`);
        }
    }

    async disconnectAccount(accountId) {
        const sock = sessions.get(accountId);
        if (sock) {
            try { await sock.logout(); } catch {}
            sessions.delete(accountId);
        }
        connecting.delete(accountId);
        readySessions.delete(accountId); // [FIX-LIVE-PUBLISH-READY]
        this._invalidateAccountMeta(accountId);
        await SystemDB.run(
            `UPDATE accounts SET status='disconnected', updated_at=NOW() WHERE id=$1`, [accountId]
        ).catch(() => {});
        emit('account_status', { accountId, status: 'disconnected' });
        return { success: true };
    }

    async resetSession(accountId) {
        await this.disconnectAccount(accountId);
        await deletePostgreSQLAuthState(accountId, SystemDB).catch(() => {});
        qrData.delete(accountId);
        return { success: true, message: 'Session reset' };
    }

    async fullDeleteAccount(accountId) {
        await this.resetSession(accountId);
    }

    // ════════════════════════════════════════════════════════════════════════
    //  إرسال خام (بدون حماية) — لا يُستخدم مباشرة من أي كود إرسال جديد.
    //  أُبقي عليه فقط كأساس داخلي لـ sendMessageSafe وللتوافق العكسي مع أي
    //  استدعاءات قديمة محتملة خارج هذا الملف.
    // ════════════════════════════════════════════════════════════════════════
    async sendMessage(accountId, jid, content) {
        const sock = sessions.get(accountId);
        if (!sock) throw new Error('Account not connected');
        return await sock.sendMessage(jid, content);
    }

    async sendTextMessage(accountId, phone, text) {
        const jid = phone.includes('@') ? phone : `${phone}@s.whatsapp.net`;
        return await this.sendMessageSafe(accountId, jid, { text });
    }

    async sendGroupMessage(accountId, groupId, content) {
        const jid = groupId.includes('@') ? groupId : `${groupId}@g.us`;
        return await this.sendMessageSafe(accountId, jid, content);
    }

    // ════════════════════════════════════════════════════════════════════════
    //  [البند 1 + 9] sendMessageSafe — نقطة الإرسال المركزية المحمية الوحيدة
    // ════════════════════════════════════════════════════════════════════════
    /**
     * كل إرسال في المشروع يجب أن يمر من هنا. تقوم هذه الدالة بـ:
     *   1. تحديد operationType تلقائياً (group اذا كان الـ jid ينتهي بـ @g.us، وإلا private)
     *      ما لم يُمرَّر صراحة عبر options.operationType.
     *   2. [البند 9] محاكاة سلوك بشري: sendPresenceUpdate('composing') → انتظار
     *      مرتبط بطول الرسالة → sendMessage() → sendPresenceUpdate('paused').
     *
     * @param {string} accountId
     * @param {string} jid
     * @param {object} content     محتوى الرسالة بصيغة Baileys القياسية
     * @param {object} [options]
     * @param {'group'|'private'} [options.operationType]  يُستنتج تلقائياً من الـ jid إن لم يُحدَّد
     * @param {string} [options.taskId]                     معرّف المهمة لأغراض SmartRetry
     */
    async sendMessageSafe(accountId, jid, content, options = {}) {
        const operationType = options.operationType
            || (jid.endsWith('@g.us') ? 'group' : 'private');

        console.log(`[WAManager][SEND-DEBUG] 1) طلب إرسال مستلم — accountId=${accountId} jid=${jid} type=${operationType}`);

        const sock = sessions.get(accountId);
        if (!sock) {
            console.error(`[WAManager][SEND-DEBUG] فشل — الحساب ${accountId} غير متصل (لا يوجد socket)`);
            throw new Error('Account not connected');
        }
        // [FIX-LIVE-PUBLISH-READY] وجود الـ socket في sessions لا يعني اتصالاً
        // فعلياً مكتملاً (قد يكون لا يزال في طور المصافحة بعد إعادة تشغيل
        // الخادم) — الإرسال على socket غير جاهز يفشل فوراً وبصمت.
        if (!readySessions.has(accountId)) {
            console.error(`[WAManager][SEND-DEBUG] فشل — الحساب ${accountId} socket موجود لكن الاتصال غير مكتمل بعد`);
            const err = new Error('الحساب لا يزال يتصل بواتساب — لم تكتمل المصافحة بعد');
            err.protectionReason = 'not_ready';
            throw err;
        }

        const taskId = options.taskId || null;

        const meta = await this._getAccountMeta(accountId);
        const userId = meta.userId;
        console.log(`[WAManager][SEND-DEBUG] 2) رقم المستلم=${jid.split('@')[0]} | userId=${userId || 'غير موجود'} | accountId=${accountId}`);

        console.log(`[WAManager][SEND-DEBUG] 3) بدء الإرسال الفعلي إلى ${jid}`);

        try {
            const result = await this._sendWithPresence(sock, jid, content);
            console.log(`[WAManager][SEND-DEBUG] 5) ✅ نجاح مؤكَّد فعلياً — messageId=${result?.key?.id} jid=${jid}`);
            return result;
        } catch (sendErr) {
            console.error(`[WAManager][SEND-DEBUG] 5) ❌ فشل — jid=${jid} السبب: ${sendErr.message} | protectionReason=${sendErr.protectionReason || 'غير محدد'}`);

            // [FIX-SESSION-RACE-RECOVERY] بعض حالات فشل الإرسال الصامت جذرها
            // جلسة Signal تالفة لهذا الطرف تحديداً (بقايا سباق كتابة قديم قبل
            // إضافة القفل التسلسلي في PostgreSQLAuthState). عند اكتشاف نمط
            // خطأ متعلق بفك التشفير/الجلسة، نمسح جلسة هذا الرقم تحديداً
            // (Baileys يعيد بناءها تلقائياً وبأمان) ونعيد محاولة الإرسال مرة
            // واحدة فقط، بدل تسجيل فشل نهائي لمشكلة قابلة للإصلاح تلقائياً.
            const msg = String(sendErr?.message || '').toLowerCase();
            const looksLikeSessionCorruption =
                msg.includes('closed session') || msg.includes('decrypt') ||
                msg.includes('bad mac') || msg.includes('session record') ||
                sendErr?.protectionReason === 'send_unconfirmed';

            if (looksLikeSessionCorruption && !options._sessionRepairRetried) {
                try {
                    const targetPhone = jid.split('@')[0];
                    console.warn(`[WAManager][SEND-DEBUG] اكتشاف عطل محتمل في الجلسة لـ ${jid} — إصلاح وإعادة محاولة واحدة فقط.`);
                    await repairCorruptedSessions(accountId, SystemDB, targetPhone);
                    const retryResult = await this._sendWithPresence(sock, jid, content);
                    console.log(`[WAManager][SEND-DEBUG] ✅ نجحت إعادة المحاولة بعد إصلاح الجلسة — messageId=${retryResult?.key?.id}`);
                    return retryResult;
                } catch (retryErr) {
                    console.error(`[WAManager][SEND-DEBUG] ❌ فشلت إعادة المحاولة أيضاً بعد إصلاح الجلسة — jid=${jid} السبب: ${retryErr.message}`);
                    throw retryErr;
                }
            }

            throw sendErr;
        }
    }

    // ── [البند 9] محاكاة السلوك البشري قبل/بعد كل إرسال ───────────────────────
    async _sendWithPresence(sock, jid, content) {
        const isGroup = jid.endsWith('@g.us');

        // [ROLLBACK-FIX-SEND-GHOST-SUBSCRIBE] presenceSubscribe()+composing
        // قبل الإرسال الخاص كانت إضافة تجريبية لتفسير مشكلة "✅ في السجل لكن
        // لا وصول فعلي" — تأكَّد لاحقاً (بمراسلة طرف ثالث حقيقي) أن المشكلة
        // ما زالت قائمة رغم هذه الإضافة، أي أنها لم تكن الحل، وقد تكون هي
        // نفسها من يُدخل جلسة التشفير الخاصة في حالة غير متوقعة قبل أول
        // رسالة فعلية لجهة جديدة. لذا نُبقيها فقط للمجموعات (حيث لم تُثبت
        // أنها مشكلة) ونزيلها تماماً من مسار الإرسال الخاص.
        if (isGroup) {
            try { await sock.presenceSubscribe(jid); } catch { /* بعض الأنواع لا تدعمها — تجاهل بأمان */ }
            try { await sock.sendPresenceUpdate('composing', jid); } catch { /* تجاهل بأمان */ }
        }

        // مدة الكتابة المحاكاة: مرتبطة بطول النص (≈ سرعة كتابة بشرية معقولة)
        // بحد أدنى وأقصى معقولين لتفادي تأخير غير واقعي على رسائل طويلة جداً.
        const textLength = (content?.text || content?.caption || '').length;
        const typingMs = Math.min(4000, Math.max(400, textLength * 35 + Math.floor(Math.random() * 300)));
        await new Promise(r => setTimeout(r, typingMs));

        console.log(`[WAManager][SEND-DEBUG] 4) استدعاء sock.sendMessage — jid=${jid} isGroup=${isGroup}`);

        try {
            const result = await sock.sendMessage(jid, content);
            if (isGroup) {
                try { await sock.sendPresenceUpdate('paused', jid); } catch {}
            }

            console.log(`[WAManager][SEND-DEBUG] استجابة Baileys الأولية — jid=${jid} messageId=${result?.key?.id || 'مفقود'} status=${result?.status ?? 'مفقود'}`);

            // وجود key.id فقط يعني أن Baileys بنى الرسالة محلياً وأرسلها
            // لطابور الشبكة — status:1 (PENDING) في النتيجة يؤكد ذلك فقط،
            // وليس وصولها الفعلي لخوادم واتساب. لا نقبل نتيجة بلا معرّف
            // رسالة على الإطلاق.
            if (!result?.key?.id) {
                const err = new Error('sendMessage أعاد نتيجة بلا معرّف رسالة (key.id) — الإرسال لم يُبنَ محلياً حتى');
                err.protectionReason = 'send_unconfirmed';
                err.rawResult = result;
                throw err;
            }

            // [PRIVATE-SEND-ACK-TRACKING] للرسائل الخاصة فقط: ننتظر فعلياً
            // حدث messages.update الذي يرفع حالة هذه الرسالة تحديداً إلى
            // SERVER_ACK أو أعلى، قبل اعتبار الإرسال ناجحاً بشكل نهائي.
            // المجموعات مستثناة تماماً من هذا الانتظار (سبق أن ثبت أنه
            // يُفشِل إرسالها الطبيعي دون داعٍ).
            if (!isGroup && (result.status ?? WAMessageStatus.PENDING) < WAMessageStatus.SERVER_ACK) {
                console.log(`[WAManager][SEND-DEBUG] الحالة الأولية PENDING — انتظار تأكيد SERVER_ACK فعلي من واتساب (حتى ${PRIVATE_ACK_TIMEOUT_MS / 1000}ث)...`);
                try {
                    const finalStatus = await _waitForPrivateAck(result.key.id, jid);
                    console.log(`[WAManager][SEND-DEBUG] ✅ تأكيد فعلي وصل — jid=${jid} finalStatus=${finalStatus}`);
                } catch (ackErr) {
                    console.error(`[WAManager][SEND-DEBUG] ❌ لم يصل تأكيد فعلي — jid=${jid} السبب: ${ackErr.message}`);
                    ackErr.rawResult = result;
                    throw ackErr;
                }
            }

            return result;
        } catch (err) {
            if (isGroup) {
                try { await sock.sendPresenceUpdate('paused', jid); } catch {}
            }
            throw err;
        }
    }

    async getGroups(accountId) {
        const sock = sessions.get(accountId);
        if (!sock) return [];
        try {
            const groups = await sock.groupFetchAllParticipating();
            return Object.values(groups);
        } catch { return []; }
    }

    // ── [FIX-DIRECT-PUBLISH-2] جلب أعضاء مجموعة بالشكل الذي يحتاجه BroadcastController ──
    async getGroupMembers(accountId, groupId) {
        const sock = sessions.get(accountId);
        if (!sock) {
            throw new Error('الحساب غير متصل بواتساب — لا يمكن قراءة أعضاء المجموعة');
        }
        // [FIX-LIVE-PUBLISH-READY] نفس مشكلة sendMessageSafe: socket موجود لا
        // يعني اتصالاً مكتملاً — استدعاء groupMetadata على اتصال غير مكتمل
        // يفشل بصمت (أو يعلّق حتى timeout طويل). ننتظر جاهزية حقيقية أولاً.
        if (!readySessions.has(accountId)) {
            const becameReady = await this.waitUntilReady(accountId, 15_000);
            if (!becameReady) {
                throw new Error('الحساب لا يزال يتصل بواتساب — لم تكتمل المصافحة بعد');
            }
        }

        const jid = groupId.includes('@') ? groupId : `${groupId}@g.us`;
        const metadata = await sock.groupMetadata(jid);
        const participants = metadata?.participants || [];

        const normalize = (j) => (j ? j.replace(/:\d+@/, '@') : null);

        const selfIds = new Set();
        for (const c of [sock.user?.id, sock.user?.lid, sock.authState?.creds?.me?.id, sock.authState?.creds?.me?.lid]) {
            const n = normalize(c);
            if (n) selfIds.add(n);
        }
        // [FIX-PRIVATE-SEND-SELF] أضف أيضاً رقم الهاتف الحقيقي للحساب نفسه
        // بصيغة @s.whatsapp.net — فحص selfIds السابق يقارن jid/lid الخام، لكن
        // بعد حل الأعضاء عبر onWhatsApp() أدناه قد يتحول jid عضو آخر (كان
        // بصيغة @lid مختلفة) إلى نفس رقم الحساب المُرسِل الحقيقي (يحدث هذا
        // فعلياً عندما يكون صاحب الحساب نفسه عضواً في المجموعة تحت LID مختلف
        // عن sock.user.id). إرسال رسالة "خاصة" لنفس رقم المُرسِل يُقبل محلياً
        // من Baileys بنجاح (لا استثناء) لكنها لا تصل كمحادثة فعلية على واتساب
        // — بالضبط عرض المشكلة المُبلَّغ عنه (✅ في السجل لكن لا استلام حقيقي).
        const selfPhoneJid = normalize(sock.user?.id)?.split('@')[0] || null;
        if (selfPhoneJid) selfIds.add(`${selfPhoneJid}@s.whatsapp.net`);

        const all = [];
        const admins = [];
        const targetJids = [];
        const phoneByJid    = {}; // [فلتر السعودية] jid → رقم الهاتف الحقيقي (وليس معرّف LID)
        const sendableByJid = {}; // [إصلاح الإرسال الخاص] jid → jid فعلي قابل لاستقبال رسالة خاصة

        // [إصلاح الإرسال الخاص] الأعضاء الذين لا نملك لهم رقماً حقيقياً مباشراً
        // (أي pJid ينتهي بـ @lid بدون phoneNumber) — نحتاج تحويلهم عبر onWhatsApp.
        const needsResolve = [];

        for (const p of participants) {
            const pJid = normalize(p.id);
            if (!pJid) continue;

            const candidates = [p.id, p.lid, p.phoneNumber, p.jid].map(normalize).filter(Boolean);
            const isSelf = candidates.some(c => selfIds.has(c));
            if (isSelf) continue;

            const isAdmin = p.admin === 'admin' || p.admin === 'superadmin';

            // [فلتر السعودية] عندما تكون الخصوصية مفعّلة، p.id يكون LID (رقم داخلي عشوائي)
            // وليس رقم الهاتف الحقيقي. الرقم الحقيقي يأتي فقط عبر p.phoneNumber
            // (بصيغة jid مثل 9665xxxxxxxx@s.whatsapp.net) عند توفره من واتساب.
            const realPhoneJid = normalize(p.phoneNumber) || (pJid.endsWith('@s.whatsapp.net') ? pJid : null);
            const realPhone    = realPhoneJid ? realPhoneJid.split('@')[0] : pJid.split('@')[0];

            const entry = { jid: pJid, phone: realPhone, is_admin: isAdmin };
            // [FIX-SAUDI-FILTER-FALSE-EXCLUDE] phoneByJid لا يُملأ هنا إلا عندما
            // يكون الرقم الحقيقي مؤكداً فعلاً من بيانات المشارك نفسها (@s.whatsapp.net
            // أو phoneNumber صريح). إن كان pJid بصيغة @lid بلا رقم معروف، لا نضع أي
            // قيمة احتياطية هنا (كانت سابقاً pJid.split('@')[0] — وهو معرّف LID عشوائي
            // لا علاقة له برقم الهاتف — فيُقارَن خطأً بفلتر +966 ويُستبعد العضو ظلماً
            // بصفته "غير سعودي" رغم أن رقمه الحقيقي لم يُعرف بعد. الرقم الصحيح يُملأ
            // لاحقاً بعد التأكد عبر onWhatsApp أدناه، أو يبقى العضو دون phoneByJid إن
            // تعذّر التأكد، فيُستثنى حينها بسبب "تعذّر تحديد رقم" الصريح، لا بسبب فلتر
            // سعودي خاطئ.
            if (realPhoneJid) {
                phoneByJid[pJid] = realPhone;
            }

            // [إصلاح الإرسال الخاص] jid فعلي قابل لاستقبال DM:
            // - إن كان pJid نفسه بصيغة @s.whatsapp.net فهو صالح مباشرة للإرسال الخاص.
            // - إن توفر phoneNumber (حتى لو pJid كان @lid) نبني منه jid صالحاً للإرسال.
            // - غير ذلك (LID بلا رقم) — يُجدوَل للتحويل عبر onWhatsApp لاحقاً.
            //
            // [FIX-PRIVATE-SEND-GHOST] سابقاً كان أي pJid بصيغة @s.whatsapp.net
            // يُعتبر "صالحاً للإرسال" فوراً دون أي تحقق فعلي من وجوده على واتساب.
            // في بعض الحالات (خاصة بعد التحديثات الأخيرة لـ Baileys 7 وتغييرات
            // بروتوكول LID) قد يكون هذا الـ jid صيغة PN داخلية غير مرتبطة فعلياً
            // برقم مستقبل حقيقي — فتقبل sock.sendMessage() الطلب محلياً بنجاح
            // (Baileys لا يرمي استثناء) رغم أن الرسالة لا تصل أبداً على تطبيق
            // واتساب الفعلي. لذلك نضيف هؤلاء أيضاً لقائمة needsResolve للتحقق
            // النهائي عبر onWhatsApp() بدل الوثوق بالصيغة وحدها.
            // [FIX-PRIVATE-SEND-GHOST] كل عضو، أياً كانت صيغة الـ jid، يُضاف
            // لقائمة التحقق الإلزامي أدناه بدل الوثوق بصيغة @s.whatsapp.net
            // وحدها كدليل على قابلية الإرسال الفعلية.
            needsResolve.push(pJid);

            all.push(entry);
            if (isAdmin) admins.push(pJid);
            else targetJids.push(pJid);
        }

        // [FIX-PRIVATE-SEND-GHOST] لكل عضو، أياً كانت صيغة الـ jid الأصلية،
        // يجب تأكيد وجوده الفعلي على واتساب عبر onWhatsApp() قبل اعتباره
        // "قابلاً للإرسال" — بدل الوثوق بمجرد صيغة الـ jid (@s.whatsapp.net)،
        // التي قد تكون صحيحة الشكل لكنها لا تشير لمستقبل فعلي في بعض حالات
        // LID الحديثة. هذا هو التصحيح الجذري لمشكلة "الإرسال يُسجَّل ناجحاً
        // لكن لا يصل فعلياً على واتساب".
        if (needsResolve.length) {
            // مسار سريع أولاً: lidMapping المحلي (بدون استعلام شبكي) — يعطي
            // مرشحاً للرقم الحقيقي، لكن لا نثق به وحده، فقط يُسرّع/يُقلّل
            // عدد الاستعلامات المطلوبة عبر onWhatsApp أدناه.
            const lidStore = sock.signalRepository?.lidMapping;
            const candidateJid = {}; // pJid → مرشح jid للتحقق منه

            // [FIX-LID-ONWHATSAPP-MISMATCH] onWhatsApp() تستعلم من خوادم واتساب
            // بصيغة "رقم هاتف حقيقي" فقط — تمرير معرّف @lid خام (رقم داخلي عشوائي
            // لا علاقة له بأي رقم هاتف فعلي) كمدخل بحث يعيد دائماً exists:false،
            // مهما كان العضو حقيقياً وموجوداً بالفعل في المجموعة. هذا كان يُسقط
            // 100% من الأعضاء ذوي الخصوصية المفعّلة (@lid بلا phoneNumber معروف)
            // في أي مجموعة تقريباً، دون أي فشل شبكي فعلي — فقط استعلام لا معنى له.
            const lidOnlyMembers = []; // أعضاء @lid بلا رقم حقيقي محلول من أي مصدر

            for (const pJid of needsResolve) {
                // المرشح الأول: الرقم الحقيقي إن كان متوفراً من بيانات المشارك نفسها
                const entry = all.find(a => a.jid === pJid);
                const knownPhone = entry ? phoneByJid[pJid] : null;
                if (knownPhone && pJid.endsWith('@s.whatsapp.net')) {
                    candidateJid[pJid] = pJid; // pJid نفسه رقم حقيقي بالفعل
                    continue;
                }
                let resolvedViaLidStore = false;
                if (lidStore && typeof lidStore.getPNForLID === 'function') {
                    try {
                        const pn = await lidStore.getPNForLID(pJid);
                        if (pn) {
                            candidateJid[pJid] = normalize(pn.includes('@') ? pn : `${pn}@s.whatsapp.net`);
                            resolvedViaLidStore = true;
                        }
                    } catch { /* تجاهل، لا يوجد mapping محلي لهذا LID */ }
                }
                if (resolvedViaLidStore) continue;

                if (pJid.endsWith('@s.whatsapp.net')) {
                    // رقم حقيقي بالفعل بحكم الصيغة، حتى لو لم يُعرف عبر lidMapping
                    candidateJid[pJid] = pJid;
                } else {
                    // @lid بلا أي رقم حقيقي محلول من أي مصدر — استعلام onWhatsApp عنه
                    // بصيغته الخام مضمون الفشل، فلا يُدرَج ضمن lookupInputs إطلاقاً.
                    lidOnlyMembers.push(pJid);
                }
            }

            // ── التحقق النهائي الإلزامي: onWhatsApp() يستعلم من خوادم واتساب
            //    فعلياً ويؤكد وجود الرقم — هذا وحده يضمن أن الإرسال سيصل حقاً. ──
            // [FIX-ONWHATSAPP-HANG] onWhatsApp() لم تكن محاطة بأي مهلة زمنية:
            // عند عدم استجابة خوادم واتساب (شائع مع دفعات كبيرة من الأرقام
            // أو ازدحام مؤقت) كانت الدالة بأكملها تتجمد إلى الأبد — لا استثناء
            // يُرمى، لا سجل خطأ يظهر، وجلسة النشر المباشر تبقى "قيد التشغيل"
            // بصمت دون أي محاولة إرسال خاص فعلية، رغم اكتمال حساب الأعضاء
            // المؤهلين قبل هذه النقطة تماماً. الحل: مهلة زمنية صريحة (15ث)
            // بحد أقصى، مع تسجيل واضح لأي تعليق/فشل بدل الصمت الكامل.
            if (typeof sock.onWhatsApp === 'function') {
                const pJids = Object.keys(candidateJid);
                const lookupInputs = pJids.map(j => (candidateJid[j] || j).split('@')[0]);
                const ONWHATSAPP_TIMEOUT_MS = 15_000;
                try {
                    const results = await Promise.race([
                        sock.onWhatsApp(...lookupInputs),
                        new Promise((_, reject) =>
                            setTimeout(() => reject(new Error(`onWhatsApp timeout بعد ${ONWHATSAPP_TIMEOUT_MS / 1000}ث — لا استجابة من خوادم واتساب`)), ONWHATSAPP_TIMEOUT_MS)
                        ),
                    ]);

                    // [FIX-ONWHATSAPP-MISALIGN] كان الربط السابق يعتمد على تطابق
                    // فهرس نتيجة onWhatsApp (idx) بفهرس lookupInputs المُرسَل —
                    // Baileys/خوادم واتساب لا تضمن هذا الترتيب دائماً (قد تُسقط
                    // أرقاماً غير صالحة من النتيجة أو تُعيدها بترتيب مختلف)، مما
                    // كان يُنتج ربط عضو بجواب عضو آخر تماماً — وإن تطابقت عدة
                    // نتائج مُزاحة على نفس resolvedJid، تُصنَّف كل هذه الأعضاء
                    // خطأً "مكررة" رغم كونها أرقاماً مختلفة فعلياً (بالضبط عرض
                    // المشكلة المُبلَّغ عنه: كل الأعضاء "مكررون" من أول مجموعة).
                    // الحل: مطابقة صريحة عبر رقم الهاتف (r.jid يحتوي الرقم الذي
                    // استُعلِم عنه فعلياً) بدل الوثوق بترتيب المصفوفة إطلاقاً.
                    const byQueriedNumber = new Map(); // رقم الهاتف المستعلَم → نتيجة onWhatsApp
                    results?.forEach(r => {
                        if (!r?.jid) return;
                        const queriedNumber = normalize(r.jid)?.split('@')[0];
                        if (queriedNumber) byQueriedNumber.set(queriedNumber, r);
                    });

                    pJids.forEach((originalPJid, idx) => {
                        const queriedInput = lookupInputs[idx];
                        const r = byQueriedNumber.get(queriedInput);
                        if (!r?.exists || !r?.jid) return;
                        const resolvedJid = normalize(r.jid);
                        if (!resolvedJid) return;
                        // [FIX-PRIVATE-SEND-SELF] استبعاد أي عضو تبيّن بعد الحل
                        // النهائي أن رقمه الحقيقي هو نفسه رقم الحساب المُرسِل
                        // (كان يظهر تحت LID مختلف قبل onWhatsApp فلم يُكتشف
                        // بفحص selfIds الأولي). إرسال "خاص" لهذا الرقم يعني
                        // إرسال رسالة للحساب نفسه — لا تصل كمحادثة فعلية.
                        if (selfIds.has(resolvedJid)) return;
                        sendableByJid[originalPJid] = resolvedJid;
                        if (resolvedJid.endsWith('@s.whatsapp.net')) {
                            phoneByJid[originalPJid] = resolvedJid.split('@')[0];
                        }
                    });
                } catch (err) {
                    console.warn(`[WAManager] getGroupMembers: onWhatsApp bulk lookup فشل/انتهت مهلته لـ ${pJids.length} عضو:`, err.message);
                    // [FIX-ONWHATSAPP-HANG] احتياط: عند فشل/تجاوز مهلة الاستعلام الجماعي،
                    // نُسقط مباشرة لكل عضو بصيغة @s.whatsapp.net أصلية (رقم حقيقي مؤكد
                    // الصيغة من بيانات المجموعة نفسها) كمرشح إرسال بدل استبعاد الجميع
                    // بلا استثناء — أفضل من تعطيل الإرسال الخاص بالكامل عند أي ازدحام
                    // شبكي عابر، مع إبقاء الفحص اللاحق (فلتر +966) هو خط الدفاع الحقيقي.
                    for (const pJid of pJids) {
                        if (pJid.endsWith('@s.whatsapp.net') && !selfIds.has(pJid)) {
                            sendableByJid[pJid] = pJid;
                            phoneByJid[pJid] = pJid.split('@')[0];
                        }
                    }
                }
            } else {
                console.warn(`[WAManager] getGroupMembers: sock.onWhatsApp غير متاح — تعذّر تأكيد الأرقام، سيتم استبعاد الأعضاء غير المؤكدين.`);
            }

            // [FIX-LID-DIRECT-SEND] أعضاء @lid بلا رقم حقيقي محلول من أي مصدر
            // (لا phoneNumber من بيانات المجموعة، ولا lidMapping محلي) — لا نملك
            // طريقة لتحويلهم لرقم هاتف، ولا فائدة من استعلام onWhatsApp عنهم
            // بصيغة LID الخام (يفشل دائماً كما هو موضّح أعلاه). الحل الصحيح:
            // Baileys (v7+) وبروتوكول واتساب الحديث يدعمان توجيه رسالة خاصة
            // مباشرة عبر معرّف @lid نفسه دون أي تحويل لرقم — طالما العضو ضمن
            // مجموعة مشتركة فعلية (وهو مؤكَّد هنا، فقد جاء من groupMetadata
            // نفسها). لذلك يُعتبر @lid نفسه jid صالحاً للإرسال المباشر كملاذ
            // أخير، بدل استبعاد العضو بالكامل من النشر الخاص.
            if (lidOnlyMembers.length) {
                console.log(`[WAManager] getGroupMembers: ${lidOnlyMembers.length} عضو بمعرّف @lid بلا رقم حقيقي محلول — سيُرسل إليهم مباشرة عبر معرّف الـ LID نفسه.`);
            }
            for (const pJid of lidOnlyMembers) {
                if (selfIds.has(pJid)) continue;
                if (sendableByJid[pJid]) continue; // تأكيد فعلاً عبر مسار آخر أعلاه (احتياط)
                sendableByJid[pJid] = pJid;
                // phoneByJid تبقى بلا قيمة عمداً هنا — لا رقم حقيقي مؤكَّد، فيبقى
                // فلتر السعودية يتعامل معه بصفته "غير معروف" لا "غير سعودي"،
                // تماماً حسب المنطق الموثَّق أعلاه (FIX-SAUDI-FILTER-FALSE-EXCLUDE).
            }
        }

        return {
            all,
            admins,
            target_jids: targetJids,
            phone_by_jid:    phoneByJid,    // [فلتر السعودية] للفلترة بالرقم الحقيقي بدل LID
            sendable_by_jid: sendableByJid, // [إصلاح الإرسال الخاص] jid فعلي صالح للإرسال الخاص لكل عضو
            total: all.length,
            admins_count: admins.length,
            members_count: targetJids.length,
        };
    }

    startTasks(accountId) { emit('tasks_started', { accountId }); }
    stopTasks(accountId)  { emit('tasks_stopped', { accountId }); }

    getStats() {
        return {
            connected: [...sessions.keys()],
            connecting: [...connecting],
            totalSessions: sessions.size,
        };
    }
}

module.exports = new WhatsAppManager();
