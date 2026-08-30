'use strict';

const crypto = require('crypto');
const SystemDB = require('../../database/SystemDB');
const SocketBridge = require('../../core/SocketBridge');

const POLL_MS = 700;
const MAX_ATTEMPTS = 5;
let workerTimer = null;
let heartbeatTimer = null;
let workerRunning = false;
let ignoredTableReady;
async function ensureIgnoredTable() {
    if (!ignoredTableReady) {
        ignoredTableReady = (async () => {
            await SystemDB.run(`CREATE TABLE IF NOT EXISTS kw_ignored_messages (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), user_id UUID NOT NULL, account_id UUID NOT NULL, message_id TEXT NOT NULL, remote_jid TEXT, message_hash TEXT, ignored_by UUID, ignored_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), UNIQUE(user_id, account_id, message_id))`);
            await SystemDB.run(`CREATE INDEX IF NOT EXISTS idx_kw_ignored_lookup ON kw_ignored_messages(user_id, account_id, message_id)`).catch(() => {});
        })().catch(error => { ignoredTableReady = undefined; throw error; });
    }
    return ignoredTableReady;
}

function normalizeText(value, caseSensitive = false) {
    let text = String(value || '').normalize('NFKC').replace(/[\u064B-\u065F\u0670]/g, '');
    text = text.replace(/[\u0640]/g, '').replace(/[\u200B-\u200D\uFEFF]/g, '').replace(/\s+/g, ' ').trim();
    return caseSensitive ? text : text.toLocaleLowerCase();
}

function extractMessageText(msg) {
    const m = msg?.message || {};
    return String(
        m.conversation || m.extendedTextMessage?.text || m.imageMessage?.caption ||
        m.videoMessage?.caption || m.documentMessage?.caption ||
        m.buttonsResponseMessage?.selectedDisplayText || m.listResponseMessage?.title || ''
    ).trim();
}

function jidPhone(jid = '') {
    return String(jid).replace(/@s\.whatsapp\.net|@c\.us|@g\.us/g, '').split(':')[0];
}

function getMessageId(msg) {
    if (msg?.key?.id) return String(msg.key.id);
    const stable = [msg?.key?.remoteJid || '', msg?.key?.participant || '', msg?.messageTimestamp || '', extractMessageText(msg)].join('|');
    return `derived:${crypto.createHash('sha256').update(stable).digest('hex').slice(0, 48)}`;
}

function matchesKeyword(keyword, text) {
    const source = normalizeText(text, !!keyword.case_sensitive);
    const terms = Array.isArray(keyword.terms) && keyword.terms.length ? keyword.terms : [keyword.word];
    const values = terms.filter(Boolean).map(term => normalizeText(term, !!keyword.case_sensitive));
    const type = keyword.match_type || 'contains';
    if (!values.length) return false;
    if (type === 'exact') return values.every(v => source === v);
    if (type === 'starts_with') return values.every(v => source.startsWith(v));
    if (type === 'ends_with') return values.every(v => source.endsWith(v));
    if (type === 'multiple' || type === 'all') return values.every(v => source.includes(v));
    return values.some(v => source.includes(v));
}

async function broadcast(event, payload) {
    try {
        if (payload?.userId) SocketBridge.to(`user:${payload.userId}`).emit(event, payload);
        else SocketBridge.emit(event, payload);
    } catch (_) {}
}

const KeywordMonitoringService = {
    normalizeText,
    extractMessageText,
    _matchesKeyword: matchesKeyword,
    _getMessageId: getMessageId,

    async getKeywords(userId) {
        return SystemDB.all(`SELECT * FROM kw_keywords WHERE user_id=$1 ORDER BY category, word`, [userId]);
    },

    async addKeyword(userId, input = {}) {
        const word = String(input.word || input.text || '').trim();
        if (!word) throw new Error('نص الكلمة المفتاحية مطلوب');
        const terms = Array.isArray(input.terms) ? input.terms.filter(Boolean).map(String) : undefined;
        const existing = await SystemDB.get(`SELECT id FROM kw_keywords WHERE user_id=$1 AND LOWER(word)=LOWER($2)`, [userId, word]);
        if (existing) throw new Error('الكلمة المفتاحية موجودة بالفعل');
        return SystemDB.get(`INSERT INTO kw_keywords
            (user_id,word,category,case_sensitive,priority,color,match_type,description,notify_enabled,private_reply_enabled,terms)
            VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`, [
            userId, word, input.category || 'عام', !!input.case_sensitive, input.priority || 'normal', input.color || '#00A884',
            input.match_type || input.matchType || 'contains', input.description || null,
            input.notify_enabled !== false, !!input.private_reply_enabled, terms ? JSON.stringify(terms) : null,
        ]);
    },

    async updateKeyword(userId, id, updates = {}) {
        const allowed = { word:'word', category:'category', case_sensitive:'case_sensitive', priority:'priority', color:'color', is_active:'is_active', match_type:'match_type', description:'description', notify_enabled:'notify_enabled', private_reply_enabled:'private_reply_enabled' };
        const fields = []; const values = []; let i = 1;
        for (const [key, column] of Object.entries(allowed)) if (updates[key] !== undefined) { fields.push(`${column}=$${i++}`); values.push(key === 'word' ? String(updates[key]).trim() : updates[key]); }
        if (Array.isArray(updates.terms)) { fields.push(`terms=$${i++}`); values.push(JSON.stringify(updates.terms)); }
        if (!fields.length) throw new Error('لا توجد تحديثات');
        fields.push('updated_at=NOW()'); values.push(id, userId);
        const row = await SystemDB.get(`UPDATE kw_keywords SET ${fields.join(',')} WHERE id=$${i++} AND user_id=$${i} RETURNING *`, values);
        if (!row) throw new Error('الكلمة غير موجودة');
        return row;
    },

    async deleteKeyword(userId, id) {
        const row = await SystemDB.get(`DELETE FROM kw_keywords WHERE id=$1 AND user_id=$2 RETURNING word`, [id, userId]);
        if (!row) throw new Error('الكلمة غير موجودة');
        return { success: true };
    },

    async getAlerts(userId, options = {}) {
        await ensureIgnoredTable();
        const page = Math.max(1, Number(options.page) || 1), limit = Math.min(100, Math.max(1, Number(options.limit) || 30));
        const where = ['a.user_id=$1']; const values = [userId]; let i = 2;
        const add = (sql, value) => { where.push(sql.replace('?', `$${i++}`)); values.push(value); };
        if (options.keyword) add(`LOWER(a.matched_keyword) LIKE LOWER(?)`, `%${options.keyword}%`);
        if (options.phone) add(`a.sender_phone LIKE ?`, `%${options.phone}%`);
        if (options.group_name) add(`LOWER(COALESCE(a.group_name,'')) LIKE LOWER(?)`, `%${options.group_name}%`);
        if (options.status) add(`a.status=?`, options.status);
        if (options.account_id) add(`a.account_id=?`, options.account_id);
        if (options.is_archived === 'false' || options.is_archived === false) where.push('COALESCE(a.is_archived,FALSE)=FALSE');
        if (options.date_from) add(`a.message_time>=?`, new Date(options.date_from));
        if (options.date_to) add(`a.message_time<=?`, new Date(options.date_to));
        const clause = where.join(' AND ');
        const total = await SystemDB.get(`SELECT COUNT(*) FROM kw_alerts a WHERE ${clause} AND NOT EXISTS (SELECT 1 FROM kw_ignored_messages im WHERE im.user_id=a.user_id AND im.account_id=a.account_id AND im.message_id=a.message_id)`, values);
        const count = Number(total?.count || 0); values.push(limit, (page - 1) * limit);
        const alerts = await SystemDB.all(`SELECT a.*,k.color keyword_color,k.priority keyword_priority,acc.name account_name,acc.phone_number account_phone
            FROM kw_alerts a LEFT JOIN kw_keywords k ON k.id=a.keyword_id LEFT JOIN accounts acc ON acc.id=a.account_id
            WHERE ${clause} AND NOT EXISTS (SELECT 1 FROM kw_ignored_messages im WHERE im.user_id=a.user_id AND im.account_id=a.account_id AND im.message_id=a.message_id) ORDER BY COALESCE(a.is_pinned,FALSE) DESC,a.message_time DESC LIMIT $${i++} OFFSET $${i}`, values);
        return { alerts, total: count, page, pages: Math.ceil(count / limit) };
    },

    async updateAlertStatus(userId, id, status, note = null) {
        const row = await SystemDB.get(`UPDATE kw_alerts SET status=$1,internal_note=COALESCE($2,internal_note),updated_at=NOW() WHERE id=$3 AND user_id=$4 RETURNING *`, [status, note, id, userId]);
        if (!row) throw new Error('التنبيه غير موجود');
        return row;
    },
    async deleteAlert(userId, id) {
        await ensureIgnoredTable();
        const alert = await SystemDB.get(`SELECT id,account_id,message_id,group_jid,message_text FROM kw_alerts WHERE id=$1 AND user_id=$2`, [id, userId]);
        if (!alert) throw new Error('التنبيه غير موجود');
        if (alert.account_id && alert.message_id) {
            const hash = crypto.createHash('sha256').update(`${alert.account_id}:${alert.message_id}:${alert.message_text || ''}`).digest('hex');
            await SystemDB.run(`INSERT INTO kw_ignored_messages(user_id,account_id,message_id,remote_jid,message_hash,ignored_by) VALUES($1,$2,$3,$4,$5,$1) ON CONFLICT(user_id,account_id,message_id) DO NOTHING`, [userId, alert.account_id, alert.message_id, alert.group_jid || null, hash]);
        }
        await SystemDB.run(`DELETE FROM kw_alerts WHERE id=$1 AND user_id=$2`, [id, userId]);
        await broadcast('keyword_alert_deleted', { userId, alertId: id, accountId: alert.account_id || null, messageId: alert.message_id || null });
        return { success:true, ignored: Boolean(alert.account_id && alert.message_id) };
    },
    async addAlertNote(userId,id,note) { return this.updateAlertStatus(userId,id,'reviewed',note); },
    async setAlertFlag(userId,id,field,value) { if (!['is_pinned','is_archived'].includes(field)) throw new Error('حقل غير مسموح'); const row = await SystemDB.get(`UPDATE kw_alerts SET ${field}=$1,updated_at=NOW() WHERE id=$2 AND user_id=$3 RETURNING *`,[!!value,id,userId]); if (!row) throw new Error('التنبيه غير موجود'); return row; },

    async getStats(userId) {
        const [keywords, today, chats, accounts, unread, replies, topKeywords, topGroups, topSenders, dailyChart] = await Promise.all([
            SystemDB.get(`SELECT COUNT(*) FROM kw_keywords WHERE user_id=$1`, [userId]),
            SystemDB.get(`SELECT COUNT(*) FROM kw_alerts WHERE user_id=$1 AND message_time>=CURRENT_DATE`, [userId]),
            SystemDB.get(`SELECT COUNT(DISTINCT COALESCE(sender_phone,group_jid)) FROM kw_alerts WHERE user_id=$1`, [userId]),
            SystemDB.get(`SELECT COUNT(*) FROM accounts WHERE user_id=$1 AND status='connected'`, [userId]),
            SystemDB.get(`SELECT COUNT(*) FROM kw_notifications WHERE user_id=$1 AND is_read=FALSE`, [userId]),
            SystemDB.get(`SELECT COUNT(*) FROM kw_replies WHERE user_id=$1 AND status='sent'`, [userId]),
            SystemDB.all(`SELECT matched_keyword,COUNT(*) cnt FROM kw_alerts WHERE user_id=$1 GROUP BY matched_keyword ORDER BY cnt DESC LIMIT 5`,[userId]),
            SystemDB.all(`SELECT COALESCE(group_name,'خاص') group_name,COUNT(*) cnt FROM kw_alerts WHERE user_id=$1 GROUP BY group_name ORDER BY cnt DESC LIMIT 5`,[userId]),
            SystemDB.all(`SELECT sender_name,sender_phone,COUNT(*) cnt FROM kw_alerts WHERE user_id=$1 GROUP BY sender_name,sender_phone ORDER BY cnt DESC LIMIT 5`,[userId]),
            SystemDB.all(`SELECT DATE_TRUNC('day',message_time) day,COUNT(*) cnt FROM kw_alerts WHERE user_id=$1 AND message_time>=NOW()-INTERVAL '7 days' GROUP BY day ORDER BY day`,[userId]),
        ]);
        return { keywords_count:Number(keywords?.count||0), today_count:Number(today?.count||0), matched_chats:Number(chats?.count||0), active_accounts:Number(accounts?.count||0), unread_notifications:Number(unread?.count||0), replies_sent:Number(replies?.count||0), top_keywords:topKeywords, top_groups:topGroups, top_senders:topSenders, daily_chart:dailyChart };
    },

    _defaultSettings() { return { monitoring_enabled:true, notifications_enabled:true, sound_enabled:true, scan_groups:true, scan_private:true, account_ids:[], log_retention_days:90 }; },
    async getSettings(userId) { const row=await SystemDB.get(`SELECT settings FROM kw_settings WHERE user_id=$1`,[userId]); return row?.settings || this._defaultSettings(); },
    async saveSettings(userId,settings) { const merged={...this._defaultSettings(),...(settings||{})}; await SystemDB.run(`INSERT INTO kw_settings(user_id,settings) VALUES($1,$2) ON CONFLICT(user_id) DO UPDATE SET settings=$2,updated_at=NOW()`,[userId,JSON.stringify(merged)]); return merged; },
    async getActivityLog(userId,limit=100) { return SystemDB.all(`SELECT * FROM kw_activity_log WHERE user_id=$1 ORDER BY created_at DESC LIMIT $2`,[userId,Math.min(500,Number(limit)||100)]); },
    async exportKeywords(userId) { return SystemDB.all(`SELECT word,terms,match_type,category,priority,color,case_sensitive,description,notify_enabled,private_reply_enabled FROM kw_keywords WHERE user_id=$1 ORDER BY word`,[userId]); },
    async importKeywords(userId,keywords) { let added=0; for(const k of keywords||[]) { try { await this.addKeyword(userId,k); added++; } catch(_) {} } return {added}; },

    async persistMessageForDiscovery(accountId, msg) {
        if (!msg?.message) return null;
        const acct = await SystemDB.get(`SELECT user_id FROM accounts WHERE id=$1`, [accountId]);
        if (!acct?.user_id) return null;
        const remote = msg.key?.remoteJid || ''; const group = remote.endsWith('@g.us');
        const id = getMessageId(msg); const text = extractMessageText(msg); if (!text) return null;
        await SystemDB.run(`INSERT INTO kw_messages(user_id,account_id,message_id,remote_jid,participant_jid,sender_phone,sender_name,chat_name,message_text,is_group,message_time,raw_payload) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT(account_id,message_id) DO NOTHING`, [acct.user_id,accountId,id,remote,msg.key?.participant||null,jidPhone(msg.key?.participant||remote),msg.pushName||jidPhone(msg.key?.participant||remote),group?remote:msg.pushName||jidPhone(remote),text,group,new Date(Number(msg.messageTimestamp||Date.now()/1000)*1000),JSON.stringify(msg)]);
        return id;
    },

    async enqueueMessage(accountId, msg) {
        await ensureIgnoredTable();
        if (!msg?.message || msg.key?.fromMe) return null;
        const acct = await SystemDB.get(`SELECT user_id FROM accounts WHERE id=$1`, [accountId]);
        if (!acct?.user_id) return null;
        const remote = msg.key?.remoteJid || ''; const isGroup = remote.endsWith('@g.us');
        const settings = await this.getSettings(acct.user_id);
        const scope = Array.isArray(settings.account_ids) ? settings.account_ids.map(String) : [];
        if (settings.monitoring_enabled === false || (scope.length > 0 && !scope.includes(String(accountId))) || (isGroup && settings.scan_groups===false) || (!isGroup && settings.scan_private===false)) return null;
        const id = getMessageId(msg); const text = extractMessageText(msg); if (!text) return null;
        const ignored = await SystemDB.get(`SELECT 1 FROM kw_ignored_messages WHERE user_id=$1 AND account_id=$2 AND message_id=$3 LIMIT 1`, [acct.user_id, accountId, id]);
        if (ignored) return null;
        await SystemDB.run(`INSERT INTO kw_event_queue(user_id,account_id,message_id,payload) VALUES($1,$2,$3,$4) ON CONFLICT(account_id,message_id,event_type) DO NOTHING`, [acct.user_id,accountId,id,JSON.stringify(msg)]);
        await SystemDB.run(`INSERT INTO kw_service_health(account_id,user_id,status,last_event_at,updated_at) VALUES($1,$2,'connected',NOW(),NOW()) ON CONFLICT(account_id) DO UPDATE SET user_id=$2,last_event_at=NOW(),updated_at=NOW()`,[accountId,acct.user_id]);
        return id;
    },

    async processIncomingMessage(accountId, userId, msg) { return this.enqueueMessage(accountId,msg); },

    async _processQueueJob(job) {
        await ensureIgnoredTable();
        const msg=job.payload||{}; const text=extractMessageText(msg); const remote=msg.key?.remoteJid||''; const group=remote.endsWith('@g.us');
        const ignored = await SystemDB.get(`SELECT 1 FROM kw_ignored_messages WHERE user_id=$1 AND account_id=$2 AND message_id=$3 LIMIT 1`, [job.user_id, job.account_id, job.message_id]);
        if (ignored) return;
        await SystemDB.run(`INSERT INTO kw_messages(user_id,account_id,message_id,remote_jid,participant_jid,sender_phone,sender_name,chat_name,message_text,is_group,message_time,raw_payload) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT(account_id,message_id) DO NOTHING`,[job.user_id,job.account_id,job.message_id,remote,msg.key?.participant||null,jidPhone(msg.key?.participant||remote),msg.pushName||jidPhone(msg.key?.participant||remote),group?remote:msg.pushName||jidPhone(remote),text,group,new Date(Number(msg.messageTimestamp||Date.now()/1000)*1000),JSON.stringify(msg)]);
        const keywords=await SystemDB.all(`SELECT * FROM kw_keywords WHERE user_id=$1 AND is_active=TRUE`,[job.user_id]);
        for(const kw of keywords) if(matchesKeyword(kw,text)) {
            const alert=await SystemDB.get(`INSERT INTO kw_alerts(user_id,keyword_id,matched_keyword,message_id,message_text,sender_name,sender_phone,group_name,group_jid,account_id,message_time,status) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'new') ON CONFLICT(account_id,message_id,keyword_id) WHERE message_id IS NOT NULL DO NOTHING RETURNING *`,[job.user_id,kw.id,kw.word,job.message_id,text,msg.pushName||jidPhone(msg.key?.participant||remote),jidPhone(msg.key?.participant||remote),group?remote:null,group?remote:null,job.account_id,new Date(Number(msg.messageTimestamp||Date.now()/1000)*1000)]);
            if(!alert) continue;
            await SystemDB.run(`UPDATE kw_keywords SET match_count=COALESCE(match_count,0)+1,updated_at=NOW() WHERE id=$1`,[kw.id]);
            let notification=null; if(kw.notify_enabled!==false) notification=await SystemDB.get(`INSERT INTO kw_notifications(user_id,alert_id,title,body) VALUES($1,$2,$3,$4) RETURNING *`,[job.user_id,alert.id,'تم اكتشاف كلمة مفتاحية',`${kw.word} — ${text}`]);
            const payload={...alert,keyword_color:kw.color,keyword_priority:kw.priority,notification_id:notification?.id||null};
            await broadcast('keyword_alert',{userId:job.user_id,alert:payload});
            if(notification) await broadcast('keyword_notification',{userId:job.user_id,notification,alert:payload});
        }
    },

    async _claimAndProcess() {
        if(workerRunning) return; workerRunning=true;
        try {
            const job=await SystemDB.get(`WITH next_job AS (SELECT id FROM kw_event_queue WHERE status IN ('received','retry') AND available_at<=NOW() ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED) UPDATE kw_event_queue q SET status='processing',locked_at=NOW(),attempts=q.attempts+1 FROM next_job WHERE q.id=next_job.id RETURNING q.*`);
            if(!job) return;
            try { await this._processQueueJob(job); await SystemDB.run(`UPDATE kw_event_queue SET status='completed',processed_at=NOW(),last_error=NULL WHERE id=$1`,[job.id]); }
            catch(err) { const failed=Number(job.attempts)>=MAX_ATTEMPTS; await SystemDB.run(`UPDATE kw_event_queue SET status=$1,available_at=NOW()+($2 || ' seconds')::interval,last_error=$3 WHERE id=$4`,[failed?'failed':'retry',Math.min(60,2**Number(job.attempts)),err.message,job.id]); }
        } finally { workerRunning=false; }
    },

    async startWorker() {
        if(workerTimer) return;
        await SystemDB.run(`UPDATE kw_event_queue SET status='retry',available_at=NOW() WHERE status='processing'`).catch(()=>{});
        workerTimer=setInterval(()=>this._claimAndProcess().catch(()=>{}),POLL_MS); workerTimer.unref?.();
        heartbeatTimer=setInterval(()=>SystemDB.run(`UPDATE kw_service_health h SET last_heartbeat=NOW(),status=CASE WHEN EXISTS (SELECT 1 FROM accounts a WHERE a.id=h.account_id AND a.status='connected') THEN 'connected' ELSE 'disconnected' END,updated_at=NOW() WHERE h.status NOT IN ('stopped')`).catch(()=>{}),5000); heartbeatTimer.unref?.();
        console.log('[KeywordWorker] Persistent durable worker started.');
    },
    stopWorker() { if(workerTimer) clearInterval(workerTimer); if(heartbeatTimer) clearInterval(heartbeatTimer); workerTimer=null; heartbeatTimer=null; },

    async getNotifications(userId, options={}) { const limit=Math.min(100,Number(options.limit)||50); return SystemDB.all(`SELECT n.*,a.matched_keyword,a.message_text,a.sender_phone FROM kw_notifications n LEFT JOIN kw_alerts a ON a.id=n.alert_id WHERE n.user_id=$1 ORDER BY n.created_at DESC LIMIT $2`,[userId,limit]); },
    async markNotificationRead(userId,id) { const row = await SystemDB.get(`UPDATE kw_notifications SET is_read=TRUE,read_at=NOW() WHERE id=$1 AND user_id=$2 RETURNING *`,[id,userId]); if (!row) throw new Error('الإشعار غير موجود'); return row; },
    async getHealth(userId) { return SystemDB.all(`SELECT a.id account_id,a.user_id,a.name account_name,a.phone_number account_phone,a.status account_status,a.health_status,COALESCE(h.status,CASE WHEN a.status='connected' THEN 'connected' ELSE 'disconnected' END) status,h.last_heartbeat,h.last_event_at,h.last_error,COALESCE(h.updated_at,a.updated_at) updated_at FROM accounts a LEFT JOIN kw_service_health h ON h.account_id=a.id WHERE a.user_id=$1 ORDER BY a.name`,[userId]); },
    async getAccountOverview(userId) {
        const [settings, accounts] = await Promise.all([this.getSettings(userId), this.getHealth(userId)]);
        const scope = Array.isArray(settings.account_ids) ? settings.account_ids.map(String) : [];
        return {
            monitoring_enabled: settings.monitoring_enabled !== false,
            all_accounts_enabled: scope.length === 0,
            accounts: accounts.map(account => ({ ...account, included: scope.length === 0 || scope.includes(String(account.account_id)), connected: account.account_status === 'connected' && account.status === 'connected' })),
        };
    },

    async sendReply(userId,alertId,body) {
        if(!String(body||'').trim()) throw new Error('نص الرد مطلوب');
        const alert=await SystemDB.get(`SELECT * FROM kw_alerts WHERE id=$1 AND user_id=$2`,[alertId,userId]); if(!alert) throw new Error('التنبيه غير موجود');
        const jid=alert.group_jid && alert.group_jid.endsWith('@g.us') ? (alert.sender_phone ? `${alert.sender_phone}@s.whatsapp.net` : null) : `${alert.sender_phone}@s.whatsapp.net`;
        if(!jid || jidPhone(jid)==='') throw new Error('رقم المستلم غير متوفر');
        const reply=await SystemDB.get(`INSERT INTO kw_replies(user_id,alert_id,account_id,recipient_jid,body) VALUES($1,$2,$3,$4,$5) RETURNING *`,[userId,alertId,alert.account_id,jid,String(body).trim()]);
        try {
            const WAM=require('../../bot/WhatsAppManager'); const result=await WAM.sendMessageSafe(alert.account_id,jid,{text:String(body).trim()},{operationType:'keyword_reply',taskId:String(reply.id)});
            const sent=await SystemDB.get(`UPDATE kw_replies SET status='sent',whatsapp_message_id=$1,sent_at=NOW() WHERE id=$2 RETURNING *`,[result?.key?.id||null,reply.id]);
            await SystemDB.run(`UPDATE kw_alerts SET status='replied',updated_at=NOW() WHERE id=$1`,[alertId]); await broadcast('keyword_reply_sent',{userId,reply:sent,alertId}); return sent;
        } catch(err) { await SystemDB.run(`UPDATE kw_replies SET status='failed',error=$1 WHERE id=$2`,[err.message,reply.id]); throw new Error(`فشل إرسال الرد: ${err.message}`); }
    },
};

module.exports = KeywordMonitoringService;
