'use strict';
/**
 * TelegramService — مراقبة حقيقية عبر Telegram MTProto (gramjs)
 *
 * يعمل بحساب المستخدم العادي (لا يحتاج Admin):
 *  - يقرأ الرسائل من جميع القنوات/المجموعات التي أنت عضو فيها
 *  - يستخدم api_id + api_hash + session_string من my.telegram.org
 *  - يكتشف روابط Telegram ويحفظها في مخزن أتمتة مستقل
 *
 * للحصول على session_string:
 *  - سجّل دخولك مرة واحدة عبر سكريبت gen_session.js (مرفق)
 *  - انسخ الـ string الناتج وضعه في حقل session_string عند إضافة الحساب
 */

const { query, queryOne, queryAll } = require('../../lib/postgres');
const { v4: uuidv4 } = require('uuid');
const SocketBridge = require('../../core/SocketBridge');
const { decrypt } = require('./TelegramSessionCrypto');

// ── Regex روابط Telegram ──────────────────────────────────────────────────────
const TG_LINK_PATTERN = /(?:https?:\/\/)?(?:t\.me|telegram\.me)\/(?:\+|joinchat\/)?[A-Za-z0-9_+\-]+[^\s\])"'>]*/gi;

// ── خريطة الـ Workers النشطة ──────────────────────────────────────────────────
const activeWorkers = new Map(); // accountId → workerState
const PROCESS_WORKER_ID = `${process.env.HOSTNAME || 'telegram-runtime'}:${process.pid}`;

async function persistHealth(accountId, patch = {}) {
    const fields = Object.keys(patch);
    if (!fields.length) return;
    const allowed = new Set(['status','worker_id','worker_state','connection_state','last_heartbeat_at','last_error','last_success_at','last_operation_at']);
    const safeFields = fields.filter(field => allowed.has(field));
    if (!safeFields.length) return;
    const values = safeFields.map(field => patch[field]);
    const assignments = safeFields.map((field, index) => `${field}=$${index + 1}`).join(',');
    await query(`UPDATE telegram_accounts SET ${assignments},updated_at=NOW() WHERE id=$${values.length + 1}`, [...values, accountId]).catch(() => {});
}

// ── تحميل gramjs بشكل آمن ───────────────────────────────────────────────────
let TelegramClient, StringSession;
try {
    const telegramLib = require('telegram');
    TelegramClient  = telegramLib.TelegramClient;
    StringSession   = require('telegram').sessions.StringSession;
    console.log('[TelegramService] gramjs loaded ✓');
} catch (e) {
    console.warn('[TelegramService] gramjs not installed. Run: npm install telegram');
}

const TelegramService = {

    // ── تشغيل worker لحساب واحد ─────────────────────────────────────────────
    async startWorker(account) {
        const id = account.id;

        if (activeWorkers.has(id)) {
            console.log(`[TelegramService] Worker ${id} already running`);
            return;
        }

        if (!TelegramClient) {
            console.error('[TelegramService] gramjs not installed. Run: npm install telegram');
            await query(
                `UPDATE telegram_accounts SET status='error', updated_at=NOW() WHERE id=$1`, [id]
            ).catch(() => {});
            return;
        }

        const apiId = account.api_id || process.env.TELEGRAM_API_ID || process.env.TELEGRAM_APP_ID || process.env.TELEGRAM_APIID || process.env.API_ID;
        const apiHash = account.api_hash || process.env.TELEGRAM_API_HASH || process.env.TELEGRAM_APP_HASH || process.env.TELEGRAM_APIHASH || process.env.API_HASH;
        const storedSession = account.session_encrypted || account.session_string;
        if (!apiId || !apiHash || !storedSession) {
            console.warn(`[TelegramService] Account ${account.name} missing Telegram credentials/session`);
            await query(
                `UPDATE telegram_accounts SET status='disconnected', updated_at=NOW() WHERE id=$1`, [id]
            ).catch(() => {});
            return;
        }

        console.log(`[TelegramService] Starting MTProto worker for: ${account.name}`);

        const workerState = {
            account,
            client:     null,
            status:     'connecting',
            startedAt:  new Date(),
            linksFound: 0,
            lastCheck:  null,
            error:      null,
            active:     true,
            workerId:   `${PROCESS_WORKER_ID}:${id}`,
            role:       account.automation_role || 'SEARCH_ROLE',
            messageHandler: null,
            eventBuilder: null,
            deletionHandler: null,
            deletionEventBuilder: null,
            editedHandler: null,
            editedEventBuilder: null,
            heartbeatTimer: null,
        };

        activeWorkers.set(id, workerState);
        await persistHealth(id, { status: 'connecting', worker_id: workerState.workerId, worker_state: 'CONNECTING', connection_state: 'CONNECTING', last_error: null });

        // بدء الاتصال في الخلفية
        TelegramService._connectAndListen(id, workerState).catch(err => {
            console.error(`[TelegramService] Worker crashed for ${account.name}:`, err.message);
            workerState.status = 'error';
            workerState.error  = err.message;
        });
    },

    // ── الاتصال والاستماع ────────────────────────────────────────────────────
    async _connectAndListen(accountId, state) {
        const account = state.account;
        const apiId = account.api_id || process.env.TELEGRAM_API_ID || process.env.TELEGRAM_APP_ID || process.env.TELEGRAM_APIID || process.env.API_ID;
        const apiHash = account.api_hash || process.env.TELEGRAM_API_HASH || process.env.TELEGRAM_APP_HASH || process.env.TELEGRAM_APIHASH || process.env.API_HASH;
        const storedSession = account.session_encrypted || account.session_string;

        try {
            const session = new StringSession(decrypt(storedSession));
            const client  = new TelegramClient(
                session,
                parseInt(apiId),
                apiHash,
                {
                    connectionRetries: 5,
                    retryDelay:        3000,
                    autoReconnect:     true,
                    // لا نطلب إدخال من المستخدم — نستخدم session_string موجود
                    baseLogger: { // إخفاء logs التيليجرام الطويلة
                        error:  (...a) => console.error('[gramjs]', ...a),
                        warn:   () => {},
                        info:   () => {},
                        debug:  () => {},
                    },
                }
            );

            state.client = client;

            // الاتصال بدون طلب code (session موجود)
            await client.connect();

            if (!await client.isUserAuthorized()) {
                throw new Error('Session غير صالح — أعد إنشاء session_string');
            }

            const me = await client.getMe();
            console.log(`[TelegramService] Connected as: ${me.username || me.phone} for account "${account.name}"`);

            // تحديث الحالة
            state.status = 'running';
            await persistHealth(accountId, { status: 'connected', worker_id: state.workerId, worker_state: 'RUNNING', connection_state: 'CONNECTED', last_heartbeat_at: new Date(), last_error: null, last_success_at: new Date() });
            state.heartbeatTimer = setInterval(() => persistHealth(accountId, { status: 'connected', worker_id: state.workerId, worker_state: 'RUNNING', connection_state: 'CONNECTED', last_heartbeat_at: new Date() }), 10000);
            state.heartbeatTimer.unref?.();

            SocketBridge.emit('telegram:worker_started', {
                accountId:   accountId,
                accountName: account.name,
                phone:       me.phone || '',
                username:    me.username || '',
            });

            // Keyword Center capability remains active for every connected
            // Telegram user. Discovery is gated separately by automation_role.
            const isSearchRole = (account.automation_role || 'SEARCH_ROLE') === 'SEARCH_ROLE';

            // ── الاستماع للرسائل الجديدة (real-time) ───────────────────────
            const { NewMessage } = require('telegram/events');
            // DeletedMessage غير مُصدّر من index.js في GramJS 2.26.x؛
            // يجب استيراده من ملف الحدث مباشرة حتى لا يفشل اتصال كل الحسابات.
            let DeletedMessage = null;
            let EditedMessage = null;
            try { DeletedMessage = require('telegram/events/DeletedMessage').DeletedMessage; } catch (eventError) { console.warn(`[TelegramService] DeletedMessage listener unavailable: ${eventError.message}`); }
            try { EditedMessage = require('telegram/events/EditedMessage').EditedMessage; } catch (eventError) { console.warn(`[TelegramService] EditedMessage listener unavailable: ${eventError.message}`); }

            const messageHandler = async (event) => {
                if (!state.active) return;

                try {
                    const msg  = event.message;
                    const text = msg?.text || msg?.message || '';
                    if (!text) return;

                    state.lastCheck = new Date();

                    // حفظ هوية المحادثة المصدر وهوية صاحب الرسالة من Telegram entity الحقيقي.
                    let sourceChat = null;
                    let sourceGroup = '';
                    try {
                        sourceChat = await event.getChat();
                        sourceGroup = sourceChat?.title || sourceChat?.username || String(sourceChat?.id || '');
                    } catch {
                        sourceGroup = String(msg?.peerId?.channelId || msg?.peerId?.chatId || '');
                    }
                    let sender = null;
                    try { sender = typeof msg.getSender === 'function' ? await msg.getSender() : msg.sender || null; } catch {}
                    const senderId = sender?.id ?? msg?.senderId ?? null;
                    const senderAccessHash = sender?.accessHash ?? sender?.access_hash ?? null;
                    const sourceChatId = sourceChat?.id ?? msg?.peerId?.channelId ?? msg?.peerId?.chatId ?? sourceGroup;
                    const senderFirstName = sender?.firstName || sender?.first_name || null;
                    const senderLastName = sender?.lastName || sender?.last_name || null;
                    const sourceChatUsername = sourceChat?.username || null;
                    const telegramMessagePayload = { text, message_id: String(msg.id || ''), chat_id: String(sourceChatId || ''), chat_title: sourceGroup, chat_username: sourceChatUsername, chat_type: event.isChannel ? 'channel' : 'group', sender_id: senderId == null ? null : String(senderId), sender_access_hash: senderAccessHash == null ? null : String(senderAccessHash), sender_first_name: senderFirstName, sender_last_name: senderLastName, sender_peer_type: sender?.className === 'User' ? 'user' : 'unknown', sender_username: sender?.username || null, sender_name: [senderFirstName, senderLastName].filter(Boolean).join(' ') || null, sender_phone: sender?.phone || null, date: msg.date || new Date() };
                    try { await require('./TelegramKeywordService').ingest(accountId, telegramMessagePayload); } catch (keywordError) { console.warn(`[TelegramKeyword] ingest failed for ${accountId}: ${keywordError.message}`); }
                    try { await require('./TelegramSmartConversationService').ingest(accountId, telegramMessagePayload); } catch (smartError) { console.warn(`[TelegramSmart] ingest failed for ${accountId}: ${smartError.message}`); }
                    if (!isSearchRole) return;

                    const result = await require('./TelegramJoinAutomationService').ingestMessage({
                        userId: account.user_id,
                        accountId,
                        accountName: account.name,
                        chatId: String(sourceChatId || ''),
                        messageId: String(msg.id || ''),
                        text,
                        sourceGroup,
                        client,
                    });
                    const rawLinks = result.linksFound || [];
                    const saved = Number(result.linksSaved || 0);

                    if (rawLinks.length > 0) {
                        state.linksFound += rawLinks.length;
                        console.log(
                            `[TelegramService] "${account.name}" — ` +
                            `found ${rawLinks.length} link(s) in "${sourceGroup}", saved ${saved} new`
                        );
                        // تحديث last_activity
                        query(
                            `UPDATE telegram_accounts SET last_activity_at=NOW() WHERE id=$1`,
                            [accountId]
                        ).catch(() => {});
                    }
                } catch (err) {
                    console.error(`[TelegramService] Message handler error:`, err.message);
                }
            };
            const eventBuilder = new NewMessage({});
            state.messageHandler = messageHandler;
            state.eventBuilder = eventBuilder;
            client.addEventHandler(messageHandler, eventBuilder);

            // ── الاستماع لتعديل الرسائل قبل الحذف ─────────────────────────
            // بعض البوتات تعرض رسالة مؤقتة ثم تعدّلها إلى النص النهائي. حفظ
            // آخر نسخة هنا يضمن بقاء النص النهائي في السجل إذا حُذفت الرسالة لاحقاً.
            const editedHandler = async (event) => {
                if (!state.active) return;
                try {
                    const message = event?.message;
                    const text = message?.text || message?.message || '';
                    const messageId = message?.id;
                    const chatId = message?.chatId ?? message?.peerId?.channelId ?? message?.peerId?.chatId;
                    if (!messageId || !text || chatId === undefined || chatId === null) return;
                    const result = await require('./TelegramKeywordService').updateEditedMessage(accountId, String(messageId), text, { chatId });
                    try { await require('./TelegramSmartConversationService').updateMessage(accountId, String(messageId), text, chatId); } catch (smartError) { console.warn(`[TelegramSmart] edit handler failed for ${accountId}: ${smartError.message}`); }
                    if (result.updated) state.lastCheck = new Date();
                } catch (editError) {
                    console.warn(`[TelegramKeyword] edit handler failed for ${accountId}: ${editError.message}`);
                }
            };
            if (typeof EditedMessage === 'function') {
                const editedEventBuilder = new EditedMessage({});
                state.editedHandler = editedHandler;
                state.editedEventBuilder = editedEventBuilder;
                client.addEventHandler(editedHandler, editedEventBuilder);
            }

            // ── الاستماع لحذف الرسائل (نحتفظ بالسجل ونعلّمه كمحذوف) ────────
            // DeletedMessage يوفر chat peer للقنوات والمجموعات الكبيرة، بينما
            // قد لا يرسله Telegram للمجموعات الصغيرة؛ لذلك تستخدم الخدمة
            // message_id وحده كخطة احتياطية عند غياب peer.
            const deletionHandler = async (event) => {
                if (!state.active) return;
                try {
                    const deletedIds = Array.isArray(event?.deletedIds) ? event.deletedIds : [];
                    if (!deletedIds.length) return;
                    const result = await require('./TelegramKeywordService').markMessagesDeleted(accountId, deletedIds, event.peer);
                    try { await require('./TelegramSmartConversationService').markDeleted(accountId, deletedIds, event.peer?.channelId ?? event.peer?.chatId); } catch (smartError) { console.warn(`[TelegramSmart] deletion handler failed for ${accountId}: ${smartError.message}`); }
                    if (result.marked) {
                        state.lastCheck = new Date();
                        await persistHealth(accountId, { last_heartbeat_at: state.lastCheck });
                    }
                } catch (deletionError) {
                    console.warn(`[TelegramKeyword] deletion handler failed for ${accountId}: ${deletionError.message}`);
                }
            };
            if (typeof DeletedMessage === 'function') {
                const deletionEventBuilder = new DeletedMessage({});
                state.deletionHandler = deletionHandler;
                state.deletionEventBuilder = deletionEventBuilder;
                client.addEventHandler(deletionHandler, deletionEventBuilder);
            }

            // ── مسح الرسائل القديمة عند الاتصال (اختياري) ──────────────────
            // يمكن تفعيله لجلب روابط من الرسائل السابقة
            if (process.env.TELEGRAM_SCAN_HISTORY === 'true') {
                await TelegramService._scanHistory(client, account, accountId).catch(err => {
                    console.warn(`[TelegramService] History scan failed:`, err.message);
                });
            }

            // إبقاء الـ client مفتوحاً حتى يُطلب الإيقاف
            await client.disconnected;

        } catch (err) {
            if (!state.active) return; // تم الإيقاف عمداً

            state.status = 'error';
            state.error  = err.message;
            if (state.heartbeatTimer) clearInterval(state.heartbeatTimer);
            console.error(`[TelegramService] Connection error for "${account.name}":`, err.message);

            await persistHealth(accountId, { status: 'error', worker_id: state.workerId, worker_state: 'ERROR', connection_state: 'ERROR', last_error: err.message });

            SocketBridge.emit('telegram:worker_error', {
                accountId:   accountId,
                accountName: account.name,
                error:       err.message,
            });

            // إعادة المحاولة بعد 60 ثانية
            if (state.active && activeWorkers.has(accountId)) {
                console.log(`[TelegramService] Retrying "${account.name}" in 60s...`);
                await TelegramService._sleep(60000);
                if (state.active && activeWorkers.has(accountId)) {
                    await TelegramService._connectAndListen(accountId, state).catch(() => {});
                }
            }
        }
    },

    // ── مسح الرسائل التاريخية (إذا كان TELEGRAM_SCAN_HISTORY=true) ──────────
    async _scanHistory(client, account, accountId, options = {}) {
        if ((account.automation_role || 'SEARCH_ROLE') !== 'SEARCH_ROLE') throw Object.assign(new Error('فحص السجل متاح لحسابات SEARCH_ROLE فقط'), { code: 'ACCOUNT_WRONG_ROLE' });
        console.log(`[TelegramService] Scanning history for "${account.name}"...`);
        const dialogs = await client.getDialogs({ limit: 200 });
        const startIndex = Math.max(0, Number(options.dialogIndex || 0));
        let totalFound = 0; let totalSaved = 0; let totalDuplicates = 0;
        const onProgress = typeof options.onProgress === 'function' ? options.onProgress : async () => {};

        for (let index = startIndex; index < dialogs.length; index += 1) {
            const dialog = dialogs[index];
            if (!dialog.isGroup && !dialog.isChannel) { await onProgress({ totalDialogs: dialogs.length, dialogIndex: index + 1, linksFound: 0, linksSaved: 0, duplicates: 0 }); continue; }
            let dialogFound = 0; let dialogSaved = 0; let dialogDuplicates = 0;
            try {
                const messages = await client.getMessages(dialog.entity, { limit: 100, filter: undefined });
                for (const msg of messages) {
                    const text = msg?.text || msg?.message || '';
                    if (!text) continue;
                    const historyChatId = String(dialog.id || '');
                    const historyChatTitle = dialog.title || dialog.name || '';
                    try { await require('./TelegramSmartConversationService').ingest(accountId, { text, message_id: String(msg.id || ''), chat_id: historyChatId, chat_title: historyChatTitle, chat_username: dialog.entity?.username || null, chat_type: dialog.isChannel ? 'channel' : 'group', sender_id: msg.senderId?.toString?.() || null, sender_username: null, sender_name: null, date: msg.date || null }); } catch (smartError) { console.warn(`[TelegramSmart] history ingest failed for ${accountId}: ${smartError.message}`); }
                    const result = await require('./TelegramJoinAutomationService').ingestMessage({ userId: account.user_id, accountId, accountName: account.name, chatId: historyChatId, messageId: String(msg.id || ''), text, sourceGroup: historyChatTitle, chatTitle: historyChatTitle, messageDate: msg.date || null, client });
                    dialogFound += Array.isArray(result.linksFound) ? result.linksFound.length : 0;
                    dialogSaved += Number(result.linksSaved || 0);
                    dialogDuplicates += Number(result.duplicates || 0);
                }
            } catch { /* تجاهل القنوات التي لا يمكن قراءتها، ثم احفظ cursor */ }
            totalFound += dialogFound; totalSaved += dialogSaved; totalDuplicates += dialogDuplicates;
            await onProgress({ totalDialogs: dialogs.length, dialogIndex: index + 1, linksFound: dialogFound, linksSaved: dialogSaved, duplicates: dialogDuplicates });
        }
        console.log(`[TelegramService] History scan done: ${totalSaved} new links for "${account.name}"`);
        return { linksFound: totalFound, linksSaved: totalSaved, duplicates: totalDuplicates, totalDialogs: dialogs.length, accountId, accountName: account.name };
    },

    // ── طلب بحث يدوي من العامل النشط ─────────────────────────────────────────
    async scanHistory(accountId) {
        const state = activeWorkers.get(accountId);
        if (!state) throw new Error('مصدر البحث غير مشغّل');
        for (let attempt = 0; attempt < 40; attempt += 1) {
            if (state.client)         return this._scanHistory(state.client, state.account, accountId, {});

            if (state.status === 'error' || !state.active) throw new Error(state.error || 'تعذر تشغيل مصدر البحث');
            await this._sleep(500);
        }
        throw new Error('انتهت مهلة انتظار اتصال مصدر البحث');
    },

    async scanHistoryJob(accountId, discoveryJobId, options = {}) {
        const state = activeWorkers.get(accountId);
        if (!state) throw Object.assign(new Error('مصدر البحث غير مشغّل'), { code: 'ACCOUNT_OFFLINE' });
        for (let attempt = 0; attempt < 120; attempt += 1) {
            if (state.client) return this._scanHistory(state.client, state.account, accountId, options);
            if (state.status === 'error' || !state.active) throw Object.assign(new Error(state.error || 'تعذر تشغيل مصدر البحث'), { code: 'ACCOUNT_OFFLINE' });
            await this._sleep(500);
        }
        throw Object.assign(new Error(`انتهت مهلة انتظار اتصال مصدر البحث للمهمة ${discoveryJobId}`), { code: 'ACCOUNT_OFFLINE' });
    },

    // ── إيقاف worker ─────────────────────────────────────────────────────────
    async stopWorker(accountId) {
        const worker = activeWorkers.get(accountId);
        if (!worker) return;

        worker.active = false;

        if (worker.heartbeatTimer) clearInterval(worker.heartbeatTimer);
        if (worker.client && worker.messageHandler) {
            await Promise.resolve(worker.client.removeEventHandler(worker.messageHandler, worker.eventBuilder)).catch(() => {});
        }
        if (worker.client && worker.deletionHandler) {
            await Promise.resolve(worker.client.removeEventHandler(worker.deletionHandler, worker.deletionEventBuilder)).catch(() => {});
        }
        if (worker.client && worker.editedHandler) {
            await Promise.resolve(worker.client.removeEventHandler(worker.editedHandler, worker.editedEventBuilder)).catch(() => {});
        }
        if (worker.client) await worker.client.disconnect().catch(() => {});

        activeWorkers.delete(accountId);
        await persistHealth(accountId, { status: 'disconnected', worker_id: worker.workerId, worker_state: 'DISCONNECTED', connection_state: 'DISCONNECTED' });

        SocketBridge.emit('telegram:worker_stopped', { accountId, workerId: worker.workerId });
        console.log(`[TelegramService] Worker stopped: ${accountId}`);
    },

    // ── إيقاف جميع الـ workers ───────────────────────────────────────────────
    async stopAll() {
        await Promise.all([...activeWorkers.keys()].map(id => this.stopWorker(id)));
    },

    // ── حالة جميع الـ workers ────────────────────────────────────────────────
    getAllWorkersStatus() {
        const result = [];
        for (const [id, state] of activeWorkers) {
            result.push({
                accountId:   id,
                accountName: state.account.name,
                userId:      state.account.user_id || null,
                status:      state.status,
                startedAt:   state.startedAt,
                linksFound:  state.linksFound,
                lastCheck:   state.lastCheck,
                error:       state.error,
                workerId:     state.workerId,
                role:         state.role,
                lastHeartbeatAt: state.heartbeatTimer ? new Date() : null,
            });
        }
        return result;
    },

    // ── استقبال رسالة من Python / webhook خارجي ─────────────────────────────
    async processIncomingMessage(accountId, accountName, channelOrGroup, message) {
        if (!message || typeof message !== 'string') return;
        try {
            const account = await queryOne(`SELECT user_id,automation_role FROM telegram_accounts WHERE id=$1`, [accountId]);
            if (!account || (account.automation_role || 'SEARCH_ROLE') !== 'SEARCH_ROLE') return { linksFound: [], linksSaved: 0 };
            const worker = activeWorkers.get(accountId);
            const messageId = `derived:webhook:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
            try { await require('./TelegramSmartConversationService').ingest(accountId, { text: message, message_id: messageId, chat_id: String(channelOrGroup || ''), chat_title: String(channelOrGroup || ''), chat_type: 'group' }); } catch (smartError) { console.warn(`[TelegramSmart] webhook ingest failed for ${accountId}: ${smartError.message}`); }
            const result = await require('./TelegramJoinAutomationService').ingestMessage({ userId: account.user_id, accountId, accountName, chatId: String(channelOrGroup || ''), messageId, text: message, sourceGroup: channelOrGroup, client: worker?.client || null });
            if (worker && result.linksSaved > 0) worker.linksFound += Number(result.linksSaved);
            return { linksFound: result.linksFound || [], linksSaved: Number(result.linksSaved || 0) };
        } catch (err) {
            console.error('[TelegramService.processIncomingMessage]', err.message);
            return { linksFound: 0, linksSaved: 0 };
        }
    },

    // ── معالجة webhook من Telegram Bot API ──────────────────────────────────
    async processBotUpdate(accountId, update) {
        try {
            const account = await queryOne(
                `SELECT id, name FROM telegram_accounts WHERE id = $1`, [accountId]
            );
            if (!account) return;
            const msg = update.message || update.channel_post || update.edited_message;
            if (!msg?.text) return;
            const group = msg.chat?.title || msg.chat?.username || String(msg.chat?.id || '');
            await TelegramService.processIncomingMessage(accountId, account.name, group, msg.text);
        } catch (err) {
            console.error('[TelegramService.processBotUpdate]', err.message);
        }
    },

    // ── حفظ رابط مع منع التكرار الذري ────────────────────────────────────────
    async saveLink({ whatsapp_link, source_account_id, source_account_name, source_group }) {
        try {
            const parsed = require('./LinkUrlProcessingService').parseSupportedUrl(whatsapp_link);
            // Regex discovery is only a candidate. Unsupported or malformed URLs
            // are deliberately not persisted as actionable invitation records.
            if (!parsed.ok) return { isDuplicate: true, ignored: true, reason: parsed.code };
            const normalizedLink = parsed.canonicalUrl;
            const id = uuidv4();
            const sourceEntry = { accountId: source_account_id || null, accountName: source_account_name || null, group: source_group || null, seenAt: new Date().toISOString() };
            const result = await queryOne(
                `INSERT INTO whatsapp_links
                 (id,whatsapp_link,source_account_id,source_account_name,source_group,source_history,discovered_by_account_ids,discovered_at,last_seen,duplicate_count,status,processing_status,joined,copied,deleted)
                 VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,NOW(),NOW(),0,'new','new',false,false,false)
                 ON CONFLICT (whatsapp_link) DO UPDATE SET
                   duplicate_count=whatsapp_links.duplicate_count+1,
                   last_seen=NOW(),
                   source_account_id=EXCLUDED.source_account_id,
                   source_account_name=EXCLUDED.source_account_name,
                   source_group=EXCLUDED.source_group,
                   source_history=(SELECT jsonb_agg(value ORDER BY ord) FROM (SELECT value,ord FROM (SELECT ($6::jsonb->0) AS value,0::int AS ord UNION ALL SELECT value,ord FROM (SELECT value,ROW_NUMBER() OVER ()::int AS ord FROM jsonb_array_elements(CASE WHEN jsonb_typeof(COALESCE(whatsapp_links.source_history,'[]'::jsonb)) = 'array' THEN COALESCE(whatsapp_links.source_history,'[]'::jsonb) ELSE '[]'::jsonb END) AS h(value) WHERE NOT ((value->>'accountId') IS NOT DISTINCT FROM $3::text AND (value->>'group') IS NOT DISTINCT FROM $5::text)) history_values ORDER BY ord LIMIT 100) history_limited)),
                   discovered_by_account_ids=(SELECT COALESCE(jsonb_agg(DISTINCT value),'[]'::jsonb) FROM (SELECT value FROM jsonb_array_elements(CASE WHEN jsonb_typeof(COALESCE(whatsapp_links.discovered_by_account_ids,'[]'::jsonb)) = 'array' THEN COALESCE(whatsapp_links.discovered_by_account_ids,'[]'::jsonb) ELSE '[]'::jsonb END) ids(value) UNION ALL SELECT to_jsonb($3::text) WHERE $3 IS NOT NULL) account_values),
                   updated_at=NOW()
                 RETURNING id,duplicate_count,(xmax=0) AS inserted`,
                [id, normalizedLink, source_account_id, source_account_name, source_group, JSON.stringify([sourceEntry]), JSON.stringify(source_account_id ? [source_account_id] : [])]
            );
            if (!result) return { isDuplicate: false, id: null };
            const isDuplicate = !Boolean(result.inserted);
            if (isDuplicate) {
                const duplicatePayload = { linkId: result.id, whatsapp_link: normalizedLink, duplicate_count: Number(result.duplicate_count || 0), source: sourceEntry };
                SocketBridge.emit('telegram:link_duplicate', duplicatePayload);
                SocketBridge.emit('whatsapp:link_duplicate', duplicatePayload);
                return { isDuplicate: true, id: result.id };
            }
            const link = await queryOne(`SELECT * FROM whatsapp_links WHERE id=$1`, [result.id]);
            SocketBridge.emit('telegram:new_link', link);
            SocketBridge.emit('whatsapp:new_link', link);
            if (source_account_id) query(`UPDATE accounts SET links_collected=COALESCE(links_collected,0)+1,last_activity_at=NOW(),updated_at=NOW() WHERE id=$1`, [source_account_id]).catch(() => {});
            return { isDuplicate: false, id: result.id };
        } catch (err) {
            console.error('[TelegramService.saveLink]', err.message);
            throw err;
        }
    },

    // ── تشغيل جميع الحسابات عند بدء الخادم ──────────────────────────────────
    async initAllWorkers() {
        try {
            const accounts = await queryAll(
                `SELECT * FROM telegram_accounts
                 WHERE COALESCE(session_encrypted, session_string) IS NOT NULL
                   AND status != 'disabled'`
            );
            for (const acc of accounts) {
                await this.startWorker(acc).catch(err =>
                    console.error(`[TelegramService] Failed to start worker for ${acc.name}:`, err.message)
                );
                await TelegramService._sleep(2000);
            }
            console.log(`[TelegramService] Initialized ${accounts.length} workers`);
        } catch (err) {
            console.error('[TelegramService.initAllWorkers]', err.message);
        }
    },

    _sleep(ms) { return new Promise(r => setTimeout(r, ms)); },
};
TelegramService.getWorker = (accountId) => activeWorkers.get(accountId) || null;
module.exports = TelegramService;
