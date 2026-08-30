'use strict';
const crypto = require('crypto');
const { query, queryOne, queryAll, withAdvisoryLock } = require('../../lib/postgres');
const SocketBridge = require('../../core/SocketBridge');
const TelegramService = require('./TelegramService');
const { v4: uuidv4 } = require('uuid');
const RedisManager = require('../../lib/RedisManager');

function normalizeText(value, arabic = true) {
  let text = String(value || '').normalize('NFKC').trim();
  if (!arabic) return text;
  return text.replace(/[إأآٱ]/g, 'ا').replace(/ى/g, 'ي').replace(/ة/g, 'ه').replace(/[ًٌٍَُِّْـ]/g, '').replace(/\s+/g, ' ');
}
function matches(text, keyword) {
  const source = keyword.case_sensitive ? String(text || '') : String(text || '').toLocaleLowerCase();
  const term = keyword.case_sensitive ? String(keyword.keyword || '') : String(keyword.keyword || '').toLocaleLowerCase();
  const a = keyword.normalize_arabic === false ? source : normalizeText(source, true);
  const b = keyword.normalize_arabic === false ? term : normalizeText(term, true);
  if (!b) return false;
  if (keyword.match_mode === 'exact') return a === b;
  if (keyword.match_mode === 'starts_with') return a.startsWith(b);
  if (keyword.match_mode === 'ends_with') return a.endsWith(b);
  if (keyword.match_mode === 'regex') { try { return new RegExp(b, keyword.case_sensitive ? '' : 'i').test(a); } catch { return false; } }
  return a.includes(b);
}
function safeAccount(account) { if (!account) return null; const { session_string, api_hash, bot_token, ...safe } = account; return safe; }
function messageIdentity(message, accountId = message.telegram_account_id || message.account_id || '') {
  const chatId = String(message.chat_id || message.chatId || '');
  const explicitId = message.message_id || message.messageId || message.telegram_message_id || message.id;
  if (explicitId !== undefined && explicitId !== null && String(explicitId).trim()) return { accountId: String(accountId), chatId, messageId: String(explicitId) };
  const fallback = crypto.createHash('sha256').update(`${accountId}:${chatId}:${message.sender_id || ''}:${message.date || message.timestamp || ''}:${message.text || message.message || ''}`).digest('hex').slice(0, 48);
  return { accountId: String(accountId), chatId, messageId: `derived:${fallback}` };
}
function messageHash(message) { return crypto.createHash('sha256').update(`${message.telegram_account_id || ''}:${message.chat_id || ''}:${message.message_id || ''}:${message.text || ''}`).digest('hex'); }
function normalizedTelegramUsername(value) {
  return String(value || '').replace(/^@+/, '').trim();
}
function normalizedTelegramId(value) {
  const id = String(value ?? '').replace(/n$/, '').trim();
  return id && id !== 'null' && id !== 'undefined' ? id : '';
}
function directChatLink(senderId, senderUsername) {
  const username = normalizedTelegramUsername(senderUsername);
  const id = normalizedTelegramId(senderId);
  if (username) return `https://t.me/${encodeURIComponent(username)}`;
  if (!id) return null;
  return `tg://openmessage?user_id=${encodeURIComponent(id)}`;
}
function senderProfileLink(senderId, senderUsername) {
  const username = normalizedTelegramUsername(senderUsername);
  const id = normalizedTelegramId(senderId);
  if (username) return `https://t.me/${encodeURIComponent(username)}?profile`;
  if (!id) return null;
  return `tg://openmessage?user_id=${encodeURIComponent(id)}`;
}
function telegramMessageLink(chatId, chatUsername, messageId, chatType) {
  const id = normalizedTelegramId(messageId);
  if (!id || id.startsWith('derived:')) return null;
  const username = normalizedTelegramUsername(chatUsername);
  if (username) return `https://t.me/${encodeURIComponent(username)}/${encodeURIComponent(id)}?single`;
  const rawChatId = normalizedTelegramId(chatId);
  if (!rawChatId) return null;
  if (['channel', 'supergroup'].includes(String(chatType || '').toLowerCase())) {
    const channelId = rawChatId.match(/^-100(\d+)$/)?.[1] || (rawChatId.match(/^\d+$/) ? rawChatId : '');
    if (channelId) return `https://t.me/c/${channelId}/${encodeURIComponent(id)}?single`;
  }
  return `tg://openmessage?chat_id=${encodeURIComponent(rawChatId)}&message_id=${encodeURIComponent(id)}`;
}
function decorateTelegramResult(result) {
  if (!result) return result;
  return {
    ...result,
    sender_link: senderProfileLink(result.sender_id, result.sender_username),
    message_link: telegramMessageLink(result.chat_id, result.chat_username, result.message_id, result.chat_type),
  };
}
function deletionChatId(peer) {
  const id = peer?.channelId ?? peer?.channel_id ?? peer?.chatId ?? peer?.chat_id;
  return id === undefined || id === null ? '' : String(id);
}
function normalizeDeletedMessageIds(messageIds) {
  return [...new Set((Array.isArray(messageIds) ? messageIds : [messageIds])
    .map(id => String(id ?? '').trim())
    .filter(Boolean))];
}
const MAX_PINNED_TELEGRAM_CHATS = 30;
let ignoredTableReady;
let blockedUsersTableReady;
let pinnedChatsTableReady;
async function ensureBlockedUsersTable() {
  if (!blockedUsersTableReady) {
    blockedUsersTableReady = (async () => {
      await query(`CREATE TABLE IF NOT EXISTS telegram_keyword_blocked_users (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), user_id UUID NOT NULL, telegram_user_id TEXT NOT NULL, telegram_username TEXT, display_name TEXT, blocked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), blocked_by UUID, reason TEXT, is_active BOOLEAN NOT NULL DEFAULT TRUE, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), UNIQUE (user_id, telegram_user_id))`);
      const upgrades = [
        `ALTER TABLE telegram_keyword_blocked_users ADD COLUMN IF NOT EXISTS telegram_username TEXT`,
        `ALTER TABLE telegram_keyword_blocked_users ADD COLUMN IF NOT EXISTS display_name TEXT`,
        `ALTER TABLE telegram_keyword_blocked_users ADD COLUMN IF NOT EXISTS blocked_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`,
        `ALTER TABLE telegram_keyword_blocked_users ADD COLUMN IF NOT EXISTS blocked_by UUID`,
        `ALTER TABLE telegram_keyword_blocked_users ADD COLUMN IF NOT EXISTS reason TEXT`,
        `ALTER TABLE telegram_keyword_blocked_users ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT TRUE`,
        `ALTER TABLE telegram_keyword_blocked_users ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`
      ];
      for (const upgrade of upgrades) await query(upgrade).catch(() => {});
      await query(`CREATE INDEX IF NOT EXISTS idx_tg_blocked_users_active ON telegram_keyword_blocked_users(user_id, is_active, telegram_user_id)`).catch(() => {});
    })().catch(error => { blockedUsersTableReady = undefined; throw error; });
  }
  return blockedUsersTableReady;
}
async function ensurePinnedChatsTable() {
  if (!pinnedChatsTableReady) {
    pinnedChatsTableReady = (async () => {
      await query(`CREATE TABLE IF NOT EXISTS telegram_keyword_pinned_chats (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), user_id UUID NOT NULL, telegram_account_id UUID NOT NULL REFERENCES telegram_accounts(id) ON DELETE CASCADE, chat_id TEXT NOT NULL, chat_title TEXT, chat_username TEXT, chat_type VARCHAR(30), pinned_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), UNIQUE (user_id, telegram_account_id, chat_id))`);
      await query(`CREATE INDEX IF NOT EXISTS idx_tg_pinned_chats_user_order ON telegram_keyword_pinned_chats(user_id, pinned_at DESC)`).catch(() => {});
      await query(`CREATE INDEX IF NOT EXISTS idx_tg_pinned_chats_lookup ON telegram_keyword_pinned_chats(user_id, telegram_account_id, chat_id)`).catch(() => {});
    })().catch(error => { pinnedChatsTableReady = undefined; throw error; });
  }
  return pinnedChatsTableReady;
}

async function ensureIgnoredMessagesTable() {
  if (!ignoredTableReady) {
    ignoredTableReady = (async () => {
      await query(`CREATE TABLE IF NOT EXISTS telegram_ignored_messages (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), telegram_account_id UUID NOT NULL, chat_id TEXT NOT NULL, message_id TEXT NOT NULL, sender_id TEXT, message_hash TEXT, ignored_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), ignored_by UUID, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), UNIQUE (telegram_account_id, chat_id, message_id))`);
      await query(`CREATE INDEX IF NOT EXISTS idx_tg_ignored_lookup ON telegram_ignored_messages(telegram_account_id, chat_id, message_id)`).catch(() => {});
      await query(`CREATE INDEX IF NOT EXISTS idx_tg_ignored_hash ON telegram_ignored_messages(message_hash) WHERE message_hash IS NOT NULL`).catch(() => {});
    })().catch(error => { ignoredTableReady = undefined; throw error; });
  }
  return ignoredTableReady;
}

const Service = {
  normalizeText, matches, directChatLink, senderProfileLink, telegramMessageLink, decorateTelegramResult, deletionChatId, normalizeDeletedMessageIds,
  MAX_PINNED_TELEGRAM_CHATS,
  async accounts(userId) {
    const rows = await queryAll(`SELECT id,name,phone_number,bot_username,status,last_activity_at,links_collected,channels_monitored,created_at,updated_at FROM telegram_accounts WHERE user_id=$1 ORDER BY created_at DESC`, [userId]);
    return rows.map(a => ({ ...a, keyword_status: a.status === 'connected' ? 'active' : 'offline' }));
  },
  async dashboard(userId, filters = {}) {
    await ensureIgnoredMessagesTable();
    await ensureBlockedUsersTable();
    await ensurePinnedChatsTable();
    const [accounts, keywords, stats, pinnedChats] = await Promise.all([
      this.accounts(userId),
      queryAll(`SELECT * FROM telegram_keywords WHERE user_id=$1 ORDER BY created_at DESC`, [userId]),
      queryOne(`SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE detected_at >= NOW()-INTERVAL '24 hours')::int AS today, COUNT(*) FILTER (WHERE COALESCE(r0.ignored,FALSE)=FALSE AND r0.sender_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM telegram_ignored_messages im WHERE im.telegram_account_id=r0.telegram_account_id AND im.chat_id=r0.chat_id AND im.message_id=r0.message_id) AND NOT EXISTS (SELECT 1 FROM telegram_keyword_blocked_users bu WHERE bu.user_id=r0.user_id AND bu.telegram_user_id=r0.sender_id AND bu.is_active=true))::int AS active FROM telegram_keyword_results r0 WHERE r0.user_id=$1`, [userId]),
      queryAll(`SELECT * FROM telegram_keyword_pinned_chats WHERE user_id=$1 ORDER BY pinned_at DESC`, [userId]),
    ]);
    const conditions = ['r.user_id=$1', 'COALESCE(r.ignored,FALSE)=FALSE', `NOT EXISTS (SELECT 1 FROM telegram_ignored_messages im WHERE im.telegram_account_id=r.telegram_account_id AND im.chat_id=r.chat_id AND im.message_id=r.message_id)`, `NOT EXISTS (SELECT 1 FROM telegram_keyword_blocked_users bu WHERE bu.user_id=r.user_id AND bu.telegram_user_id=r.sender_id AND bu.is_active=true)`]; const params = [userId]; let n = 2;
    if (filters.keyword_id) { conditions.push(`r.keyword_id=$${n++}`); params.push(filters.keyword_id); }
    if (filters.account_id) { conditions.push(`r.telegram_account_id=$${n++}`); params.push(filters.account_id); }
    if (filters.search) { conditions.push(`(r.message_text ILIKE $${n} OR r.sender_name ILIKE $${n} OR r.sender_username ILIKE $${n} OR r.chat_title ILIKE $${n})`); params.push(`%${filters.search}%`); n++; }
    const limit = Math.min(Math.max(Number(filters.limit || 50), 1), 200); const offset = Math.max(Number(filters.offset || 0), 0);
    params.push(limit, offset);
    const results = (await queryAll(`SELECT r.*,k.keyword,a.name AS account_name,a.phone_number AS account_phone,p.id AS pinned_chat_id,p.pinned_at AS chat_pinned_at FROM telegram_keyword_results r JOIN telegram_keywords k ON k.id=r.keyword_id JOIN telegram_accounts a ON a.id=r.telegram_account_id LEFT JOIN telegram_keyword_pinned_chats p ON p.user_id=r.user_id AND p.telegram_account_id=r.telegram_account_id AND p.chat_id=r.chat_id WHERE ${conditions.join(' AND ')} ORDER BY (p.id IS NOT NULL) DESC,p.pinned_at DESC NULLS LAST,r.detected_at DESC LIMIT $${n++} OFFSET $${n}`, params)).map(result => decorateTelegramResult({ ...result, is_pinned: Boolean(result.pinned_chat_id) }));
    return { accounts, keywords, results, pinnedChats, stats: stats || { total: 0, today: 0, active: 0 } };
  },
  async toggleChatPin(userId, body = {}) {
    await ensurePinnedChatsTable();
    const telegramAccountId = String(body.telegram_account_id || '').trim();
    const chatId = String(body.chat_id ?? '').trim();
    if (!telegramAccountId || !chatId) throw Object.assign(new Error('معرّف الحساب والمحادثة مطلوبان'), { code: 'CHAT_ID_REQUIRED' });
    const account = await queryOne(`SELECT id FROM telegram_accounts WHERE id=$1 AND user_id=$2`, [telegramAccountId, userId]);
    if (!account) throw Object.assign(new Error('حساب Telegram غير موجود أو لا يخص المستخدم الحالي'), { code: 'TELEGRAM_ACCOUNT_NOT_FOUND' });
    const shouldPin = body.pinned === true || body.pinned === 'true' || body.pinned === 1 || body.pinned === '1';
    if (!shouldPin) {
      const removed = await queryOne(`DELETE FROM telegram_keyword_pinned_chats WHERE user_id=$1 AND telegram_account_id=$2 AND chat_id=$3 RETURNING *`, [userId, telegramAccountId, chatId]);
      SocketBridge.to(`user:${userId}`).emit('telegram:keyword:chat_pin_updated', { user_id: userId, telegram_account_id: telegramAccountId, chat_id: chatId, pinned: false });
      return { pinned: false, chat: removed || { user_id: userId, telegram_account_id: telegramAccountId, chat_id: chatId } };
    }
    const chat = await withAdvisoryLock(`telegram-keyword-pins:${userId}`, async client => {
      const existing = await client.query(`SELECT * FROM telegram_keyword_pinned_chats WHERE user_id=$1 AND telegram_account_id=$2 AND chat_id=$3 LIMIT 1`, [userId, telegramAccountId, chatId]);
      if (!existing.rows[0]) {
        const count = await client.query(`SELECT COUNT(*)::int AS count FROM telegram_keyword_pinned_chats WHERE user_id=$1`, [userId]);
        if (Number(count.rows[0]?.count || 0) >= MAX_PINNED_TELEGRAM_CHATS) {
          throw Object.assign(new Error(`لا يمكن تثبيت أكثر من ${MAX_PINNED_TELEGRAM_CHATS} محادثة في الوقت نفسه`), { code: 'PIN_LIMIT_REACHED' });
        }
        const inserted = await client.query(`INSERT INTO telegram_keyword_pinned_chats(user_id,telegram_account_id,chat_id,chat_title,chat_username,chat_type,pinned_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,NOW(),NOW()) RETURNING *`, [userId, telegramAccountId, chatId, body.chat_title || null, body.chat_username || null, body.chat_type || null]);
        return inserted.rows[0];
      }
      const updated = await client.query(`UPDATE telegram_keyword_pinned_chats SET chat_title=COALESCE($4,chat_title),chat_username=COALESCE($5,chat_username),chat_type=COALESCE($6,chat_type),updated_at=NOW() WHERE user_id=$1 AND telegram_account_id=$2 AND chat_id=$3 RETURNING *`, [userId, telegramAccountId, chatId, body.chat_title || null, body.chat_username || null, body.chat_type || null]);
      return updated.rows[0];
    });
    SocketBridge.to(`user:${userId}`).emit('telegram:keyword:chat_pin_updated', { user_id: userId, telegram_account_id: telegramAccountId, chat_id: chatId, pinned: true, chat });
    return { pinned: true, chat };
  },
  async createKeyword(userId, body) {
    const keyword = String(body.keyword || '').trim(); if (!keyword) throw new Error('الكلمة المفتاحية مطلوبة');
    // كلمات Telegram عامة دائماً: القائمة الفارغة تعني جميع الحسابات الحالية والجديدة.
    const accountIds = [];
    const row = await queryOne(`INSERT INTO telegram_keywords(user_id,keyword,match_mode,case_sensitive,normalize_arabic,search_groups,search_channels,account_ids,is_active) VALUES($1,$2,$3,$4,$5,$6,$7,$8,true) RETURNING *`, [userId, keyword, body.match_mode || 'contains', Boolean(body.case_sensitive), body.normalize_arabic !== false, body.search_groups !== false, body.search_channels !== false, JSON.stringify(accountIds)]);
    return row;
  },
  async updateKeyword(userId, id, body) {
    const existing = await queryOne(`SELECT * FROM telegram_keywords WHERE id=$1 AND user_id=$2`, [id, userId]); if (!existing) throw new Error('الكلمة غير موجودة');
    // تطبيع الكلمات القديمة أو أي طلب تحديث إلى النطاق العام.
    const accountIds = [];
    return queryOne(`UPDATE telegram_keywords SET keyword=$1,match_mode=$2,case_sensitive=$3,normalize_arabic=$4,search_groups=$5,search_channels=$6,account_ids=$7,is_active=$8,updated_at=NOW() WHERE id=$9 AND user_id=$10 RETURNING *`, [String(body.keyword ?? existing.keyword).trim(), body.match_mode || existing.match_mode, body.case_sensitive ?? existing.case_sensitive, body.normalize_arabic ?? existing.normalize_arabic, body.search_groups ?? existing.search_groups, body.search_channels ?? existing.search_channels, JSON.stringify(accountIds), body.is_active ?? existing.is_active, id, userId]);
  },
  async deleteKeyword(userId, id) { const r = await query(`DELETE FROM telegram_keywords WHERE id=$1 AND user_id=$2`, [id, userId]); if (!r.rowCount) throw new Error('الكلمة غير موجودة'); return true; },
  async isBlocked(userId, telegramUserId) {
    await ensureBlockedUsersTable();
    const id = String(telegramUserId || '').trim();
    if (!userId || !id) return false;
    const cacheKey = `tg:blocked:${userId}:${id}`;
    try { if (await RedisManager.getCache().get(cacheKey)) return true; } catch {}
    const row = await queryOne(`SELECT 1 FROM telegram_keyword_blocked_users WHERE user_id=$1 AND telegram_user_id=$2 AND is_active=true LIMIT 1`, [userId, id]);
    if (row) { try { await RedisManager.getCache().set(cacheKey, '1', 'EX', 86400); } catch {} }
    return Boolean(row);
  },
  async listBlockedUsers(userId, filters = {}) {
    await ensureBlockedUsersTable();
    const params = [userId]; let n = 2; const conditions = ['user_id=$1'];
    if (filters.search) { conditions.push(`(telegram_user_id ILIKE $${n} OR telegram_username ILIKE $${n} OR display_name ILIKE $${n})`); params.push(`%${filters.search}%`); n++; }
    if (filters.active !== undefined) { conditions.push(`is_active=$${n++}`); params.push(String(filters.active) !== 'false'); }
    return queryAll(`SELECT * FROM telegram_keyword_blocked_users WHERE ${conditions.join(' AND ')} ORDER BY blocked_at DESC LIMIT 200`, params);
  },
  async blockUser(userId, resultId, body = {}) {
    await ensureBlockedUsersTable();
    const result = await queryOne(`SELECT r.telegram_account_id,r.sender_id,r.sender_username,r.sender_name,r.sender_first_name,r.sender_last_name FROM telegram_keyword_results r WHERE r.id=$1 AND r.user_id=$2`, [resultId, userId]);
    if (!result || !result.sender_id) throw Object.assign(new Error('لا يوجد Telegram User ID موثوق لهذه الرسالة'), { code: 'SENDER_ID_MISSING' });
    const displayName = result.sender_name || [result.sender_first_name, result.sender_last_name].filter(Boolean).join(' ') || null;
    const blocked = await queryOne(`INSERT INTO telegram_keyword_blocked_users(user_id,telegram_user_id,telegram_username,display_name,blocked_by,reason,is_active,blocked_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,true,NOW(),NOW()) ON CONFLICT(user_id,telegram_user_id) DO UPDATE SET telegram_username=COALESCE(EXCLUDED.telegram_username,telegram_keyword_blocked_users.telegram_username),display_name=COALESCE(EXCLUDED.display_name,telegram_keyword_blocked_users.display_name),blocked_by=EXCLUDED.blocked_by,reason=EXCLUDED.reason,is_active=true,updated_at=NOW() RETURNING *`, [userId, String(result.sender_id), result.sender_username || null, displayName, userId, body.reason || 'حظر من مركز كلمات تيليجرام']);
    try { await RedisManager.getCache().set(`tg:blocked:${userId}:${String(result.sender_id)}`, '1', 'EX', 86400); } catch {}
    await query(`UPDATE telegram_keyword_results SET ignored=true WHERE user_id=$1 AND sender_id=$2`, [userId, String(result.sender_id)]);
    SocketBridge.to(`user:${userId}`).emit('telegram:keyword:user_blocked', { telegram_user_id: String(result.sender_id), blockedUser: blocked });
    return { blocked: true, user: blocked };
  },
  async unblockUser(userId, blockedId) {
    await ensureBlockedUsersTable();
    const row = await queryOne(`UPDATE telegram_keyword_blocked_users SET is_active=false,updated_at=NOW() WHERE id=$1 AND user_id=$2 RETURNING *`, [blockedId, userId]);
    if (!row) throw Object.assign(new Error('المستخدم المحظور غير موجود'), { code: 'BLOCKED_USER_NOT_FOUND' });
    try { await RedisManager.getCache().del(`tg:blocked:${userId}:${String(row.telegram_user_id)}`); } catch {}
    SocketBridge.to(`user:${userId}`).emit('telegram:keyword:user_unblocked', { telegram_user_id: String(row.telegram_user_id), blockedUser: row });
    return { unblocked: true, user: row };
  },
  async isIgnored(message) {
    await ensureIgnoredMessagesTable();
    const identity = messageIdentity(message);
    const accountId = identity.accountId;
    const chatId = identity.chatId;
    const messageId = identity.messageId;
    if (!accountId || !chatId || !messageId) return false;
    const cacheKey = `tg:ignored:${accountId}:${chatId}:${messageId}`;
    try { if (await RedisManager.getCache().get(cacheKey)) return true; } catch {}
    const row = await queryOne(`SELECT 1 FROM telegram_ignored_messages WHERE telegram_account_id=$1 AND chat_id=$2 AND message_id=$3 LIMIT 1`, [accountId, chatId, messageId]);
    const flagged = row || await queryOne(`SELECT 1 FROM telegram_keyword_results WHERE telegram_account_id=$1 AND chat_id=$2 AND message_id=$3 AND COALESCE(ignored,FALSE)=TRUE LIMIT 1`, [accountId, chatId, messageId]);
    if (flagged) { try { await RedisManager.getCache().set(cacheKey, '1', 'EX', 86400); } catch {} }
    return Boolean(flagged);
  },
  async ignoreMessage(userId, resultId) {
    await ensureIgnoredMessagesTable();
    const result = await queryOne(`SELECT r.telegram_account_id,r.chat_id,r.message_id,r.sender_id,r.message_text FROM telegram_keyword_results r JOIN telegram_accounts a ON a.id=r.telegram_account_id WHERE r.id=$1 AND r.user_id=$2`, [resultId, userId]);
    if (!result) throw Object.assign(new Error('نتيجة الرسالة غير موجودة'), { code: 'RESULT_NOT_FOUND' });
    const hash = messageHash({ telegram_account_id: result.telegram_account_id, chat_id: result.chat_id, message_id: result.message_id, text: result.message_text });
    await query(`INSERT INTO telegram_ignored_messages(telegram_account_id,chat_id,message_id,sender_id,message_hash,ignored_by) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(telegram_account_id,chat_id,message_id) DO NOTHING`, [result.telegram_account_id, result.chat_id, result.message_id, result.sender_id || null, hash, userId]);
    try { await RedisManager.getCache().set(`tg:ignored:${result.telegram_account_id}:${result.chat_id}:${result.message_id}`, '1', 'EX', 86400); } catch {}
    await query(`UPDATE telegram_keyword_results SET ignored=true WHERE user_id=$1 AND telegram_account_id=$2 AND chat_id=$3 AND message_id=$4`, [userId, result.telegram_account_id, result.chat_id, result.message_id]);
    return { ignored: true, telegram_account_id: result.telegram_account_id, chat_id: result.chat_id, message_id: result.message_id };
  },
  async updateEditedMessage(accountId, messageId, messageText, peer = null) {
    const ids = normalizeDeletedMessageIds(messageId);
    const text = String(messageText || '').trim();
    const chatId = deletionChatId(peer);
    if (!accountId || !ids.length || !text) return { updated: 0, results: [] };
    const updated = chatId
      ? await query(`UPDATE telegram_keyword_results SET message_text=$1 WHERE telegram_account_id=$2 AND chat_id=$3 AND message_id=ANY($4::text[]) RETURNING *`, [text, accountId, chatId, ids])
      : await query(`UPDATE telegram_keyword_results SET message_text=$1 WHERE telegram_account_id=$2 AND message_id=ANY($3::text[]) RETURNING *`, [text, accountId, ids]);
    const results = updated.rows || [];
    for (const result of results) {
      SocketBridge.to(`user:${result.user_id}`).emit('telegram:keyword:message_updated', { result: decorateTelegramResult({ ...result, message_text: text }) });
    }
    return { updated: results.length, results };
  },
  async markMessagesDeleted(accountId, messageIds, peer = null) {
    const ids = normalizeDeletedMessageIds(messageIds);
    const chatId = deletionChatId(peer);
    if (!accountId || !ids.length) return { marked: 0, results: [] };

    const updated = chatId
      ? await query(`UPDATE telegram_keyword_results SET deleted_in_telegram=true, deleted_at=COALESCE(deleted_at,NOW()) WHERE telegram_account_id=$1 AND chat_id=$2 AND message_id=ANY($3::text[]) RETURNING *`, [accountId, chatId, ids])
      : await query(`UPDATE telegram_keyword_results SET deleted_in_telegram=true, deleted_at=COALESCE(deleted_at,NOW()) WHERE telegram_account_id=$1 AND message_id=ANY($2::text[]) RETURNING *`, [accountId, ids]);
    const results = updated.rows || [];

    for (const result of results) {
      await query(`INSERT INTO telegram_keyword_events(user_id,telegram_account_id,event_type,result_id,payload) VALUES($1,$2,'deleted',$3,$4)`, [result.user_id, accountId, result.id, JSON.stringify({ chat_id: result.chat_id, message_id: result.message_id, deleted_at: result.deleted_at })]).catch(() => {});
      // لا نستخدم أي actor من حدث الحذف؛ GramJS لا يرسله. الرابط يُبنى
      // حصراً من sender_id/sender_username المحفوظين عند التقاط الرسالة الأصلية.
      SocketBridge.to(`user:${result.user_id}`).emit('telegram:keyword:message_deleted', { result: decorateTelegramResult({ ...result, deleted_in_telegram: true }) });
    }
    return { marked: results.length, results };
  },
  async ingest(accountId, message) {
    await ensureIgnoredMessagesTable();
    await ensureBlockedUsersTable();
    const account = await queryOne(`SELECT * FROM telegram_accounts WHERE id=$1`, [accountId]); if (!account || account.status !== 'connected') return { matched: 0 };
    const identity = messageIdentity(message, accountId);
    const normalizedMessage = { ...message, telegram_account_id: identity.accountId, chat_id: identity.chatId, message_id: identity.messageId };
    if (await this.isBlocked(account.user_id, message.sender_id)) return { matched: 0, blocked: true };
    if (await this.isIgnored(normalizedMessage)) return { matched: 0, ignored: true };
    const text = String(message.text || message.message || '').trim(); if (!text) return { matched: 0 };
    const keywords = await queryAll(`SELECT * FROM telegram_keywords WHERE user_id=$1 AND is_active=true`, [account.user_id]);
    let matched = 0;
    for (const keyword of keywords) {
      const chatType = String(message.chat_type || (message.is_channel ? 'channel' : 'group'));
      if (chatType === 'channel' && !keyword.search_channels) continue; if (chatType !== 'channel' && !keyword.search_groups) continue;
      if (!matches(text, keyword)) continue;
      const result = await queryOne(`INSERT INTO telegram_keyword_results(user_id,keyword_id,telegram_account_id,chat_id,message_id,sender_id,sender_access_hash,sender_first_name,sender_last_name,sender_peer_type,sender_username,sender_name,sender_phone,message_text,chat_title,chat_username,chat_type,message_timestamp) SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18 WHERE NOT EXISTS (SELECT 1 FROM telegram_ignored_messages im WHERE im.telegram_account_id=$3 AND im.chat_id=$4 AND im.message_id=$5) ON CONFLICT(telegram_account_id,chat_id,message_id,keyword_id) DO NOTHING RETURNING *`, [account.user_id, keyword.id, identity.accountId, identity.chatId, identity.messageId, message.sender_id || null, message.sender_access_hash || null, message.sender_first_name || null, message.sender_last_name || null, message.sender_peer_type || 'user', message.sender_username || null, message.sender_name || null, message.sender_phone || null, text, message.chat_title || message.chat_name || '', message.chat_username || null, chatType, message.date ? new Date(message.date) : new Date()]);
      if (!result) continue; matched++;
      const decoratedResult = decorateTelegramResult(result);
      await query(`INSERT INTO telegram_keyword_events(user_id,telegram_account_id,event_type,result_id,payload) VALUES($1,$2,'matched',$3,$4)`, [account.user_id, accountId, result.id, JSON.stringify({ keyword: keyword.keyword, chat_id: result.chat_id })]).catch(() => {});
      SocketBridge.to(`user:${account.user_id}`).emit('telegram:keyword:matched', { result: decoratedResult, keyword: { id: keyword.id, keyword: keyword.keyword }, account: safeAccount(account) });
    }
    if (matched) await query(`UPDATE telegram_accounts SET last_activity_at=NOW(),updated_at=NOW() WHERE id=$1`, [accountId]).catch(() => {});
    return { matched };
  },
  async _resolvePrivatePeer(result) {
    if (!result.sender_id) throw Object.assign(new Error('لا يوجد معرف Telegram موثوق لهذا المرسل'), { code: 'SENDER_ID_MISSING' });
    const worker = TelegramService.getWorker?.(result.telegram_account_id);
    if (!worker?.client || worker.status !== 'running') throw Object.assign(new Error('الحساب المصدر غير متصل'), { code: 'ACCOUNT_OFFLINE' });
    const { Api } = require('telegram');
    try {
      const userId = BigInt(String(result.sender_id).replace(/n$/, ''));
      const accessHash = result.sender_access_hash ? BigInt(String(result.sender_access_hash).replace(/n$/, '')) : null;
      const peer = accessHash === null ? await worker.client.getInputEntity(userId) : new Api.InputPeerUser({ userId, accessHash });
      await worker.client.getEntity(peer);
      return { worker, peer };
    } catch (err) {
      throw Object.assign(new Error('تعذر التحقق من هوية مستخدم Telegram أو فتح محادثته الخاصة'), { code: 'SENDER_RESOLVE_FAILED', cause: err });
    }
  },
  async openDirectChat(userId, resultId) {
    const result = await queryOne(`SELECT r.*,a.name AS account_name,a.status AS account_status FROM telegram_keyword_results r JOIN telegram_accounts a ON a.id=r.telegram_account_id WHERE r.id=$1 AND r.user_id=$2`, [resultId, userId]);
    if (!result) throw Object.assign(new Error('نتيجة الاكتشاف غير موجودة'), { code: 'RESULT_NOT_FOUND' });
    await this._resolvePrivatePeer(result);
    const username = String(result.sender_username || '').replace(/^@+/, '').trim();
    const directLink = directChatLink(result.sender_id, username);
    return { chatOpened: true, telegramUserId: String(result.sender_id), telegramAccountId: String(result.telegram_account_id), directLink, username: username || null };
  },
  async reply(userId, resultId, text) {
    const result = await queryOne(`SELECT r.*,a.name AS account_name FROM telegram_keyword_results r JOIN telegram_accounts a ON a.id=r.telegram_account_id WHERE r.id=$1 AND r.user_id=$2`, [resultId, userId]);
    if (!result) throw new Error('نتيجة الاكتشاف غير موجودة'); if (!text || !String(text).trim()) throw new Error('نص الرد مطلوب');
    try { const { worker, peer } = await this._resolvePrivatePeer(result); await worker.client.sendMessage(peer, { message: String(text).trim() }); await query(`UPDATE telegram_keyword_results SET reply_status='sent',replied_at=NOW(),reply_error=NULL WHERE id=$1 AND user_id=$2`, [resultId, userId]); return { sent: true, telegramUserId: String(result.sender_id), chatOpened: true }; }
    catch (err) { await query(`UPDATE telegram_keyword_results SET reply_status='failed',reply_error=$3 WHERE id=$1 AND user_id=$2`, [resultId, userId, err.message]); throw err.code ? err : new Error('فشل إرسال الرد الخاص عبر الحساب المصدر'); }
  },
};
module.exports = Service;
