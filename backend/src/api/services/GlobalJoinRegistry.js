const crypto = require('crypto');
const { query, queryOne, withAdvisoryLock } = require('../../lib/postgres');
const SocketBridge = require('../../core/SocketBridge');

const STATUSES = Object.freeze({ PENDING: 'PENDING', RESERVED: 'RESERVED', JOINED: 'JOINED', ALREADY_MEMBER: 'ALREADY_MEMBER', FAILED: 'FAILED', INVALID: 'INVALID', SKIPPED_DUPLICATE: 'SKIPPED_DUPLICATE', BLOCKED: 'BLOCKED' });

function normalize(raw) {
  const originalUrl = String(raw || '').trim().replace(/[.,;:!?')\]}]+$/, '');
  if (!originalUrl) return null;
  const candidate = /^https?:\/\//i.test(originalUrl) ? originalUrl : `https://${originalUrl}`;
  let url; try { url = new URL(candidate); } catch { return null; }
  const host = url.hostname.toLowerCase().replace(/^www\./, '');
  if (!['t.me', 'telegram.me'].includes(host)) return null;
  const parts = url.pathname.split('/').filter(Boolean); if (!parts.length) return null;
  let identifier = parts[0].replace(/^@/, ''); let linkType = 'PUBLIC';
  if (parts[0].toLowerCase() === 'joinchat' && parts[1]) { identifier = parts[1]; linkType = 'PRIVATE_INVITE'; }
  else if (parts[0].startsWith('+') && parts[0].length > 1) { identifier = parts[0].slice(1); linkType = 'PRIVATE_INVITE'; }
  if (!/^[A-Za-z0-9_+\-]{4,128}$/.test(identifier)) return null;
  return { originalUrl, normalizedUrl: linkType === 'PRIVATE_INVITE' ? `https://t.me/+${identifier}` : `https://t.me/${identifier}`, identifier, linkType, urlHash: crypto.createHash('sha256').update(`${linkType}:${identifier.toLowerCase()}`).digest('hex') };
}
function emit(userId, payload) { try { SocketBridge.to(`user:${userId}`).emit('telegram:global-deduplication', payload); } catch {} }

const GlobalJoinRegistry = {
  STATUSES,
  normalize,
  async reserve({ client, userId, accountId, operationId, originalUrl, normalizedUrl, telegramIdentifier, linkType }) {
    const parsed = normalize(normalizedUrl || originalUrl); if (!parsed) return { allowed: false, status: STATUSES.INVALID, reason: 'INVALID_LINK' };
    const runner = async (dbClient) => {
      await dbClient.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`telegram-global-link:${parsed.urlHash}`]);
      await dbClient.query(`INSERT INTO telegram_global_join_links(original_url,normalized_url,url_hash,telegram_identifier,link_type,status,reserved_by_account_id,reserved_operation_id,last_seen_at) VALUES($1,$2,$3,$4,$5,'RESERVED',$6,$7,NOW()) ON CONFLICT(normalized_url) DO NOTHING`, [originalUrl || parsed.originalUrl, parsed.normalizedUrl, parsed.urlHash, telegramIdentifier || parsed.identifier, linkType || parsed.linkType, accountId, operationId]);
      const row = (await dbClient.query(`SELECT * FROM telegram_global_join_links WHERE normalized_url=$1 FOR UPDATE`, [parsed.normalizedUrl])).rows[0];
      if (row.status === STATUSES.JOINED || row.status === STATUSES.ALREADY_MEMBER) return { allowed: false, status: STATUSES.SKIPPED_DUPLICATE, reason: 'GLOBAL_DUPLICATE', existing: row, normalized: parsed };
      if (row.status === STATUSES.RESERVED && String(row.reserved_operation_id) !== String(operationId)) return { allowed: false, status: STATUSES.SKIPPED_DUPLICATE, reason: 'GLOBAL_RESERVED', existing: row, normalized: parsed };
      await dbClient.query(`UPDATE telegram_global_join_links SET status='RESERVED',reserved_by_account_id=$1,reserved_operation_id=$2,last_seen_at=NOW(),updated_at=NOW() WHERE id=$3`, [accountId, operationId, row.id]);
      return { allowed: true, status: STATUSES.RESERVED, registryId: row.id, normalized: parsed };
    };
    const result = client ? await runner(client) : await withAdvisoryLock(`telegram-global-link:${parsed.urlHash}`, async lockedClient => runner(lockedClient));
    if (!result.allowed) { await query(`INSERT INTO telegram_global_join_audit(user_id,account_id,operation_id,original_url,normalized_url,url_hash,action,previous_status,new_status,reason,existing_account_id,existing_joined_at) VALUES($1,$2,$3,$4,$5,$6,'SKIPPED',$7,$8,$9,$10,$11)`, [userId, accountId, operationId, originalUrl || parsed.originalUrl, parsed.normalizedUrl, parsed.urlHash, result.existing?.status || null, result.status, result.reason, result.existing?.joined_by_account_id || null, result.existing?.joined_at || null]).catch(() => {}); emit(userId, { action: 'SKIPPED', reason: result.reason, normalizedUrl: parsed.normalizedUrl, operationId, accountId }); }
    return result;
  },
  async markJoined(client, { registryId, accountId, operationId, chatId = null, username = null, status = STATUSES.JOINED, userId = null, normalizedUrl = null }) {
    const updated = await client.query(`UPDATE telegram_global_join_links SET status=$1,telegram_chat_id=COALESCE($2,telegram_chat_id),telegram_username=COALESCE($3,telegram_username),joined_by_account_id=$4,joined_by_operation_id=$5,joined_at=COALESCE(joined_at,NOW()),reserved_by_account_id=NULL,reserved_operation_id=NULL,last_checked_at=NOW(),updated_at=NOW() WHERE id=$6 RETURNING normalized_url,url_hash`, [status, chatId, username, accountId, operationId, registryId]);
    const row = updated.rows[0]; if (row) await client.query(`INSERT INTO telegram_global_join_audit(user_id,account_id,operation_id,normalized_url,url_hash,telegram_chat_id,action,previous_status,new_status,reason) VALUES($1,$2,$3,$4,$5,$6,'MEMBERSHIP_CONFIRMED','RESERVED',$7,$8)`, [userId, accountId, operationId, normalizedUrl || row.normalized_url, row.url_hash, chatId, status, status === STATUSES.ALREADY_MEMBER ? 'TELEGRAM_ALREADY_MEMBER' : 'TELEGRAM_MEMBERSHIP_VERIFIED']);
  },
  async markFailed(client, { registryId, errorCode = null, errorMessage = null, userId = null, accountId = null, operationId = null }) {
    const updated = await client.query(`UPDATE telegram_global_join_links SET status='FAILED',last_error_code=$1,last_error=$2,reserved_by_account_id=NULL,reserved_operation_id=NULL,last_checked_at=NOW(),updated_at=NOW() WHERE id=$3 AND status='RESERVED' RETURNING normalized_url,url_hash`, [errorCode, errorMessage, registryId]);
    const row = updated.rows[0]; if (row) await client.query(`INSERT INTO telegram_global_join_audit(user_id,account_id,operation_id,normalized_url,url_hash,action,previous_status,new_status,reason,error_code) VALUES($1,$2,$3,$4,$5,'FAILED','RESERVED','FAILED',$6,$7)`, [userId, accountId, operationId, row.normalized_url, row.url_hash, errorMessage || 'JOIN_FAILED', errorCode]);
  },
  async getStatus(raw) {
    const parsed = normalize(raw); if (!parsed) return { status: STATUSES.INVALID, normalizedUrl: null };
    const row = await queryOne(`SELECT * FROM telegram_global_join_links WHERE normalized_url=$1 OR url_hash=$2 OR (telegram_chat_id IS NOT NULL AND telegram_chat_id=$3)`, [parsed.normalizedUrl, parsed.urlHash, String(raw)]);
    if (!row) return { status: STATUSES.PENDING, normalizedUrl: parsed.normalizedUrl, urlHash: parsed.urlHash };
    const [attempts, skips] = await Promise.all([queryOne(`SELECT COUNT(*)::int count,MAX(created_at) last_attempt FROM telegram_global_join_audit WHERE normalized_url=$1`, [row.normalized_url]), queryOne(`SELECT COUNT(*)::int count FROM telegram_global_join_audit WHERE normalized_url=$1 AND action='SKIPPED'`, [row.normalized_url])]);
    return { ...row, attempts: Number(attempts?.count || 0), skipCount: Number(skips?.count || 0) };
  },
  async dashboard() {
    const [stats, top, recent] = await Promise.all([
      queryOne(`SELECT COUNT(*)::int total,COUNT(*) FILTER(WHERE status IN ('JOINED','ALREADY_MEMBER'))::int joined,COUNT(*) FILTER(WHERE status='SKIPPED_DUPLICATE')::int duplicate,COUNT(*) FILTER(WHERE status='FAILED')::int failed,COUNT(*) FILTER(WHERE status='RESERVED')::int reserved,COUNT(*) FILTER(WHERE status='PENDING')::int pending FROM telegram_global_join_links`),
      query(`SELECT normalized_url,status,joined_by_account_id,joined_at,created_at FROM telegram_global_join_links ORDER BY updated_at DESC LIMIT 100`),
      query(`SELECT * FROM telegram_global_join_audit ORDER BY created_at DESC LIMIT 100`),
    ]); return { stats: stats || {}, links: top.rows, audit: recent.rows };
  },
};
module.exports = GlobalJoinRegistry;
