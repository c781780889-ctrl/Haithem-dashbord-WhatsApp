'use strict';

const crypto = require('crypto');
const os = require('os');
const { query, queryOne, queryAll, withTransaction, withAdvisoryLock } = require('../../lib/postgres');
const SocketBridge = require('../../core/SocketBridge');
const QueueManager = require('../../lib/QueueManager');
const getTelegramService = () => require('./TelegramService');
const LinkImportService = require('./LinkImportService');
const GlobalJoinRegistry = require('./GlobalJoinRegistry');

const SEARCH_ROLE = 'SEARCH_ROLE';
const JOIN_ROLE = 'JOIN_ROLE';
const PROCESS_WORKER_ID = `${os.hostname()}:${process.pid}`;
const OPERATION_LEASE_SECONDS = 120;
const DISCOVERY_LEASE_SECONDS = 300;
const OUTBOX_RETRY_SECONDS = 30;
function isJoinWorkerReady(account) {
  const worker = getTelegramService().getWorker(account?.id);
  return Boolean(account?.status === 'connected' && account?.automation_role === JOIN_ROLE && account?.automation_enabled !== false && worker?.client && String(worker.status).toLowerCase() === 'running' && worker.role === JOIN_ROLE);
}
const TG_LINK_PATTERN = /(?:https?:\/\/)?(?:t\.me|telegram\.me)\/(?:\+|joinchat\/)?[A-Za-z0-9_+\-]+[^\s\])"'>]*/gi;
const OPERATION_TRANSITIONS = {
  QUEUED: new Set(['PROCESSING', 'SKIPPED']),
  PROCESSING: new Set(['SUCCESS', 'RETRY', 'SKIPPED', 'FAILED']),
  RETRY: new Set(['PROCESSING', 'SKIPPED']),
  SUCCESS: new Set(),
  SKIPPED: new Set(),
  FAILED: new Set(),
};
const JOB_TRANSITIONS = {
  QUEUED: new Set(['RUNNING', 'PAUSED', 'STOPPED']),
  RUNNING: new Set(['PAUSED', 'STOPPED', 'COMPLETED']),
  PAUSED: new Set(['RUNNING', 'STOPPED']),
  STOPPED: new Set(),
  COMPLETED: new Set(),
};

function emit(userId, eventType, payload = {}) {
  try { SocketBridge.to(`user:${userId}`).emit(`telegram:join-automation:${eventType}`, { eventType, ...payload }); } catch {}
}
function parseJSON(value, fallback = []) {
  if (Array.isArray(value) || (value && typeof value === 'object')) return value;
  try { return value ? JSON.parse(value) : fallback; } catch { return fallback; }
}
function safePayload(value) {
  const text = JSON.stringify(value || {}, (key, item) => /session|token|secret|password|api_hash|apiHash|credential/i.test(key) ? '[REDACTED]' : item);
  return JSON.parse(text || '{}');
}
function parseBoolean(value, fallback = false) { if (value === undefined || value === null || value === '') return fallback; return value === true || value === 'true' || value === 1 || value === '1'; }
function clampInt(value, min, max, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(max, Math.max(min, Math.floor(number))) : fallback;
}
function normalizeTelegramLink(raw) {
  const original = String(raw || '').trim().replace(/[.,;:!?')\]}]+$/, '');
  if (!original) return null;
  const candidate = /^https?:\/\//i.test(original) ? original : `https://${original}`;
  let parsed;
  try { parsed = new URL(candidate); } catch { return null; }
  const host = parsed.hostname.toLowerCase().replace(/^www\./, '');
  if (!['t.me', 'telegram.me'].includes(host)) return null;
  const parts = parsed.pathname.split('/').filter(Boolean);
  if (!parts.length) return null;
  let identifier = parts[0].replace(/^@/, '');
  let linkType = 'PUBLIC';
  if (parts[0] === 'joinchat' && parts[1]) { identifier = parts[1]; linkType = 'PRIVATE_INVITE'; }
  else if (parts[0].startsWith('+') && parts[0].length > 1) { identifier = parts[0].slice(1); linkType = 'PRIVATE_INVITE'; }
  if (!/^[A-Za-z0-9_+\-]{4,128}$/.test(identifier)) return null;
  return { normalizedUrl: linkType === 'PRIVATE_INVITE' ? `https://t.me/+${identifier}` : `https://t.me/${identifier}`, originalUrl: original, identifier, linkType };
}
async function isAllowedDiscoveryLink(client, parsed) {
  if (!parsed) return false;
  // Private invite links are valid discovery targets even though Telegram cannot
  // resolve their destination without importing the invite first.
  if (parsed.linkType === 'PRIVATE_INVITE') return true;
  if (!client || typeof client.getEntity !== 'function' || parsed.linkType !== 'PUBLIC') return false;
  try {
    const entity = await client.getEntity(parsed.identifier);
    const className = String(entity?.className || entity?.constructor?.className || '').toLowerCase();
    const isChannelEntity = className === 'channel' || className.endsWith('.channel');
    // Public groups are represented by Telegram as Channel entities with megagroup=true.
    // A public channel is also a Channel entity. Requiring username excludes private peers.
    return isChannelEntity && Boolean(String(entity?.username || '').trim());
  } catch {
    return false;
  }
}
function scope(userId, isAdmin, column = 'user_id') { return isAdmin ? { clause: 'TRUE', params: [] } : { clause: `${column}=$1`, params: [userId] }; }
async function recordEvent({ userId, jobId = null, operationId = null, accountId = null, linkId = null, eventType, status = null, payload = {} }) {
  const clean = safePayload(payload);
  await query(`INSERT INTO telegram_automation_events(user_id,job_id,operation_id,account_id,link_id,event_type,status,payload) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb)`, [userId, jobId, operationId, accountId, linkId, eventType, status, JSON.stringify(clean)]).catch(() => {});
  emit(userId, eventType, { jobId, operationId, accountId, linkId, status, payload: clean });
}
async function recordAudit({ actorId, userId, action, entityType, entityId, before = {}, after = {}, req }) {
  await query(`INSERT INTO telegram_automation_audit_logs(actor_id,user_id,action,entity_type,entity_id,before_state,after_state,ip,user_agent) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8,$9)`, [actorId || null, userId || null, action, entityType, entityId || null, JSON.stringify(safePayload(before)), JSON.stringify(safePayload(after)), req?.ip || null, req?.get?.('user-agent') || null]).catch(() => {});
}
async function beginIdempotency(userId, action, key) {
  if (!key) return null;
  const inserted = await queryOne(`INSERT INTO telegram_automation_idempotency(user_id,action,idempotency_key) VALUES($1,$2,$3) ON CONFLICT(user_id,action,idempotency_key) DO NOTHING RETURNING id`, [userId, action, key]);
  if (inserted) return { id: inserted.id, replay: false };
  const existing = await queryOne(`SELECT id,status,response_json,created_at FROM telegram_automation_idempotency WHERE user_id=$1 AND action=$2 AND idempotency_key=$3`, [userId, action, key]);
  if (existing?.response_json) return { id: existing.id, replay: true, response: parseJSON(existing.response_json, {}) };
  if (existing && new Date(existing.created_at).getTime() < Date.now() - 10 * 60 * 1000) { await query(`UPDATE telegram_automation_idempotency SET status='PROCESSING',response_json=NULL,created_at=NOW(),completed_at=NULL WHERE id=$1`, [existing.id]); return { id: existing.id, replay: false }; }
  const error = new Error('الطلب نفسه قيد التنفيذ؛ استخدم نفس المفتاح وانتظر النتيجة'); error.code = 'IDEMPOTENCY_IN_PROGRESS'; error.statusCode = 409; throw error;
}
async function completeIdempotency(record, response) { if (!record || record.replay) return; await query(`UPDATE telegram_automation_idempotency SET status='COMPLETED',response_json=$1::jsonb,completed_at=NOW() WHERE id=$2`, [JSON.stringify(safePayload(response)), record.id]).catch(() => {}); }
async function verifyMembership(client, link, telegramResult = null) {
  try {
    let entity;
    try { entity = await client.getInputEntity(link.telegram_identifier); }
    catch {
      const chat = telegramResult?.chats?.[0];
      if (chat) entity = await client.getInputEntity(chat);
      else return { verified: false, state: 'NOT_VERIFIED', reason: 'ENTITY_NOT_RESOLVED' };
    }
    let participant;
    if (typeof client.getParticipant === 'function') participant = await client.getParticipant(entity, 'me');
    else if (typeof client.invoke === 'function') {
      const { Api } = require('telegram');
      participant = await client.invoke(new Api.channels.GetParticipant({ channel: entity, participant: await client.getInputEntity('me') }));
    } else return { verified: false, state: 'NOT_VERIFIED', reason: 'GRAMJS_VERIFY_UNAVAILABLE' };
    return participant ? { verified: true, state: 'JOINED', evidence: { participantClass: participant.className || null, verifiedAt: new Date().toISOString() } } : { verified: false, state: 'NOT_VERIFIED', reason: 'EMPTY_PARTICIPANT' };
  } catch (error) {
    const classified = classifyError(error);
    if (classified.resultCode === 'PRIVATE_OR_RESTRICTED' || /USER_NOT_PARTICIPANT/i.test(String(error.message || error))) return { verified: false, state: 'PRIVATE_OR_RESTRICTED', reason: classified.resultCode };
    return { verified: false, state: 'NOT_VERIFIED', reason: classified.resultCode || 'VERIFY_ERROR' };
  }
}
function classifyError(error) {
  const message = String(error?.errorMessage || error?.message || error || 'Unknown Telegram error');
  if (/USER_ALREADY_PARTICIPANT|ALREADY_PARTICIPANT|ALREADY_MEMBER/i.test(message)) return { resultCode: 'ALREADY_MEMBER', terminal: true, membershipState: 'ALREADY_MEMBER' };
  if (/INVITE_HASH_INVALID|INVITE_HASH_EXPIRED|USERNAME_INVALID|USERNAME_NOT_OCCUPIED|CHANNEL_INVALID/i.test(message)) return { resultCode: 'INVALID_LINK', terminal: true };
  if (/CHANNEL_PRIVATE|CHAT_ADMIN_REQUIRED|PRIVATE_CHANNEL|USER_NOT_PARTICIPANT/i.test(message)) return { resultCode: 'PRIVATE_OR_RESTRICTED', terminal: true, membershipState: 'RESTRICTED' };
  if (/JOIN_REQUEST|CHAT_WRITE_FORBIDDEN|PERMISSION|ADMIN_REQUIRED/i.test(message)) return { resultCode: 'PERMISSION_REQUIRED', terminal: true, membershipState: 'JOIN_PENDING' };
  if (/AUTH_KEY|SESSION_REVOKED|USER_DEACTIVATED|AUTH_KEY_UNREGISTERED|ACCOUNT_DEACTIVATED/i.test(message)) return { resultCode: 'ACCOUNT_UNAVAILABLE', terminal: true };
  const flood = message.match(/FLOOD_WAIT[_ ](\d+)/i);
  if (flood) return { resultCode: 'RATE_LIMITED', retryable: true, retryAfterSeconds: Number(flood[1]) };
  if (/TIMEOUT|ETIMEDOUT|ECONNRESET|NETWORK|CONNECTION|TEMPORARY/i.test(message)) return { resultCode: 'TEMPORARY_ERROR', retryable: true };
  return { resultCode: 'UNKNOWN_ERROR', retryable: true };
}
async function updateLinkAggregate(linkId, client = null) {
  const run = client ? (sql, params) => client.query(sql, params).then(result => result.rows[0] || null) : queryOne;
  const row = await run(`SELECT COUNT(*)::int total,COUNT(*) FILTER (WHERE status='SUCCESS')::int successful,COUNT(*) FILTER (WHERE status IN ('SUCCESS','FAILED','SKIPPED'))::int finished FROM telegram_join_operations WHERE link_id=$1`, [linkId]);
  if (!row) return;
  const status = Number(row.successful) > 0 && Number(row.finished) >= Number(row.total) ? 'JOINED' : Number(row.successful) > 0 ? 'PARTIALLY_JOINED' : Number(row.finished) >= Number(row.total) ? 'FAILED' : 'PROCESSING';
  const joinStatus = Number(row.successful) > 0 ? (Number(row.finished) >= Number(row.total) ? 'JOINED' : 'PARTIALLY_JOINED') : 'PENDING';
  const exec = client ? (sql, params) => client.query(sql, params) : query;
  await exec(`UPDATE telegram_automation_links SET status=$1,join_status=$2,updated_at=NOW() WHERE id=$3`, [status, joinStatus, linkId]);
}

const Service = {
  normalizeTelegramLink,
  isAllowedDiscoveryLink,
  classifyError,
  verifyMembership,
  operationTransitions: OPERATION_TRANSITIONS,
  jobTransitions: JOB_TRANSITIONS,

  async ingestMessage({ userId, accountId, accountName, chatId, messageId, text, sourceGroup, chatTitle, messageDate, client }) {
    if (!userId || !text) return { linksFound: [], linksSaved: 0, duplicates: 0, rejected: 0 };
    const account = await queryOne(`SELECT id,automation_role,automation_enabled FROM telegram_accounts WHERE id=$1 AND user_id=$2`, [accountId, userId]);
    if (!account || account.automation_role !== SEARCH_ROLE || account.automation_enabled === false) return { linksFound: [], linksSaved: 0, duplicates: 0, rejected: 0 };
    const candidates = [...new Map((String(text).match(TG_LINK_PATTERN) || []).map(normalizeTelegramLink).filter(Boolean).map(item => [item.normalizedUrl, item])).values()];
    const linksFound = [];
    let rejected = 0;
    for (const candidate of candidates) {
      if (await isAllowedDiscoveryLink(client, candidate)) linksFound.push(candidate.normalizedUrl);
      else rejected += 1;
    }
    let linksSaved = 0; let duplicates = 0;
    for (const normalizedUrl of linksFound) {
      const parsed = normalizeTelegramLink(normalizedUrl);
      const sourceKey = `${accountId}:${chatId || ''}:${messageId || ''}`;
      const source = { accountId, accountName: accountName || null, chatId: chatId || null, chatTitle: chatTitle || sourceGroup || null, messageId: messageId || null, messageDate: messageDate || null, seenAt: new Date().toISOString(), sourceType: 'TELEGRAM_MESSAGE', sourceKey };
      const row = await queryOne(`
        INSERT INTO telegram_automation_links(user_id,normalized_url,original_url,telegram_identifier,link_type,source_account_id,source_chat_id,source_message_id,source_history)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)
        ON CONFLICT(user_id,normalized_url) DO UPDATE SET
          original_url=EXCLUDED.original_url,last_seen_at=NOW(),source_account_id=EXCLUDED.source_account_id,
          source_chat_id=EXCLUDED.source_chat_id,source_message_id=EXCLUDED.source_message_id,
          source_history=(SELECT COALESCE(jsonb_agg(value ORDER BY ord DESC),'[]'::jsonb) FROM (SELECT DISTINCT ON (value->>'sourceKey') value,ord FROM jsonb_array_elements(COALESCE(telegram_automation_links.source_history,'[]'::jsonb) || EXCLUDED.source_history) WITH ORDINALITY AS items(value,ord) ORDER BY value->>'sourceKey',ord DESC LIMIT 100) unique_sources),updated_at=NOW()
        RETURNING id,(xmax=0) AS inserted
      `, [userId, parsed.normalizedUrl, parsed.originalUrl, parsed.identifier, parsed.linkType, accountId, chatId || null, messageId || null, JSON.stringify([source])]);
      await GlobalJoinRegistry.register({ userId, accountId, originalUrl: parsed.originalUrl, normalizedUrl: parsed.normalizedUrl, telegramIdentifier: parsed.identifier, linkType: parsed.linkType, sourceType: source.sourceType, sourceKey: source.sourceKey });
      if (row?.inserted) { linksSaved += 1; await recordEvent({ userId, accountId, linkId: row.id, eventType: 'link_discovered', status: 'NEW', payload: { normalizedUrl: parsed.normalizedUrl, source, globalRegistry: true } }); }
      else { duplicates += 1; await recordEvent({ userId, accountId, linkId: row?.id || null, eventType: 'link_duplicate', status: 'NEW', payload: { normalizedUrl: parsed.normalizedUrl, source, globalRegistry: true } }); }
    }
    if (linksSaved || duplicates) await query(`UPDATE telegram_accounts SET last_activity_at=NOW(),updated_at=NOW() WHERE id=$1`, [accountId]).catch(() => {});
    return { linksFound, linksSaved, duplicates, rejected };
  },

  async getSettings(userId) {
    const row = await queryOne(`SELECT min_delay_seconds,max_delay_seconds,max_retries,retry_backoff_seconds,strategy,selected_search_account_ids,selected_account_ids,selected_link_ids,updated_at FROM telegram_join_automation_settings WHERE user_id=$1`, [userId]);
    return {
      minDelaySeconds: Number(row?.min_delay_seconds || 120),
      maxDelaySeconds: Number(row?.max_delay_seconds || 150),
      maxRetries: Number(row?.max_retries ?? 1),
      retryBackoffSeconds: Number(row?.retry_backoff_seconds || 60),
      strategy: ['least_loaded', 'smart', 'round_robin'].includes(row?.strategy) ? row.strategy : 'smart',
      selectedSearchAccountIds: parseJSON(row?.selected_search_account_ids, []),
      selectedAccountIds: parseJSON(row?.selected_account_ids, []),
      selectedLinkIds: parseJSON(row?.selected_link_ids, []),
      updatedAt: row?.updated_at || null,
    };
  },

  async updateSettings({ userId, settings = {} }) {
    const current = await this.getSettings(userId);
    const minDelaySeconds = clampInt(settings.minDelaySeconds ?? current.minDelaySeconds, 30, 86400, current.minDelaySeconds);
    const maxDelaySeconds = clampInt(settings.maxDelaySeconds ?? current.maxDelaySeconds, 30, 86400, current.maxDelaySeconds);
    if (minDelaySeconds > maxDelaySeconds) { const error = new Error('الحد الأدنى للفاصل لا يمكن أن يتجاوز الحد الأقصى'); error.code = 'SETTINGS_INVALID'; throw error; }
    const maxRetries = clampInt(settings.maxRetries ?? current.maxRetries, 0, 2, current.maxRetries);
    const retryBackoffSeconds = clampInt(settings.retryBackoffSeconds ?? current.retryBackoffSeconds, 30, 3600, current.retryBackoffSeconds);
    const strategy = ['least_loaded', 'smart', 'round_robin'].includes(settings.strategy) ? settings.strategy : current.strategy;
    const normalizeIds = (value, fallback) => Array.isArray(value) ? [...new Set(value.map(String).filter(Boolean))].slice(0, 1000) : fallback;
    const selectedSearchAccountIds = normalizeIds(settings.selectedSearchAccountIds, current.selectedSearchAccountIds);
    const selectedAccountIds = normalizeIds(settings.selectedAccountIds, current.selectedAccountIds);
    const selectedLinkIds = normalizeIds(settings.selectedLinkIds, current.selectedLinkIds);
    const row = await queryOne(`INSERT INTO telegram_join_automation_settings(user_id,min_delay_seconds,max_delay_seconds,max_retries,retry_backoff_seconds,strategy,selected_search_account_ids,selected_account_ids,selected_link_ids) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9::jsonb) ON CONFLICT(user_id) DO UPDATE SET min_delay_seconds=EXCLUDED.min_delay_seconds,max_delay_seconds=EXCLUDED.max_delay_seconds,max_retries=EXCLUDED.max_retries,retry_backoff_seconds=EXCLUDED.retry_backoff_seconds,strategy=EXCLUDED.strategy,selected_search_account_ids=EXCLUDED.selected_search_account_ids,selected_account_ids=EXCLUDED.selected_account_ids,selected_link_ids=EXCLUDED.selected_link_ids,updated_at=NOW() RETURNING updated_at`, [userId, minDelaySeconds, maxDelaySeconds, maxRetries, retryBackoffSeconds, strategy, JSON.stringify(selectedSearchAccountIds), JSON.stringify(selectedAccountIds), JSON.stringify(selectedLinkIds)]);
    return { minDelaySeconds, maxDelaySeconds, maxRetries, retryBackoffSeconds, strategy, selectedSearchAccountIds, selectedAccountIds, selectedLinkIds, updatedAt: row?.updated_at || new Date().toISOString() };
  },

  async dashboard(userId, isAdmin = false) {
    const accountScope = scope(userId, isAdmin, 'ta.user_id'); const linkScope = scope(userId, isAdmin, 'tal.user_id');
    const accounts = await queryAll(`SELECT ta.id,ta.name,ta.phone_number,ta.username,ta.status,ta.automation_role,ta.automation_enabled,ta.last_activity_at,ta.last_operation_at,ta.operation_count,ta.error_count,ta.last_error,ta.stopped_at,ta.stop_reason,ta.worker_id,ta.worker_state,ta.connection_state,ta.last_heartbeat_at,ta.last_success_at,ta.next_allowed_operation_at FROM telegram_accounts ta WHERE ${accountScope.clause} ORDER BY ta.created_at DESC`, accountScope.params);
    const links = await queryAll(`SELECT tal.*,ta.name source_account_name FROM telegram_automation_links tal LEFT JOIN telegram_accounts ta ON ta.id=tal.source_account_id WHERE ${linkScope.clause} AND tal.archived=false ORDER BY tal.last_seen_at DESC LIMIT 250`, linkScope.params);
    const [total, pending, processing, joined, failed, newCount, operations, activeJobs, latestJob, latestEvents] = await Promise.all([
      queryOne(`SELECT COUNT(*)::int count FROM telegram_automation_links tal WHERE ${linkScope.clause} AND tal.archived=false`, linkScope.params),
      queryOne(`SELECT COUNT(*)::int count FROM telegram_automation_links tal WHERE ${linkScope.clause} AND tal.archived=false AND tal.join_status='PENDING'`, linkScope.params),
      queryOne(`SELECT COUNT(*)::int count FROM telegram_automation_links tal WHERE ${linkScope.clause} AND tal.archived=false AND tal.status='PROCESSING'`, linkScope.params),
      queryOne(`SELECT COUNT(*)::int count FROM telegram_automation_links tal WHERE ${linkScope.clause} AND tal.archived=false AND tal.join_status='JOINED'`, linkScope.params),
      queryOne(`SELECT COUNT(*)::int count FROM telegram_automation_links tal WHERE ${linkScope.clause} AND tal.archived=false AND tal.status='FAILED'`, linkScope.params),
      queryOne(`SELECT COUNT(*)::int count FROM telegram_automation_links tal WHERE ${linkScope.clause} AND tal.archived=false AND tal.status='NEW'`, linkScope.params),
      queryOne(`SELECT COUNT(*)::int total,COUNT(*) FILTER (WHERE status='SUCCESS')::int success,COUNT(*) FILTER (WHERE status='RETRY')::int retry,COUNT(*) FILTER (WHERE status='FAILED')::int failed,COUNT(*) FILTER (WHERE status='SKIPPED')::int skipped FROM telegram_join_operations WHERE ${isAdmin ? 'TRUE' : 'user_id=$1'}`, isAdmin ? [] : [userId]),
      queryOne(`SELECT COUNT(*)::int count FROM telegram_automation_jobs WHERE ${isAdmin ? 'TRUE' : 'user_id=$1'} AND status IN ('QUEUED','RUNNING','PAUSED')`, isAdmin ? [] : [userId]),
      queryOne(`SELECT id FROM telegram_automation_jobs WHERE ${isAdmin ? 'TRUE' : 'user_id=$1'} AND status IN ('QUEUED','RUNNING','PAUSED') ORDER BY created_at DESC LIMIT 1`, isAdmin ? [] : [userId]),
      queryAll(`SELECT * FROM telegram_automation_events WHERE ${isAdmin ? 'TRUE' : 'user_id=$1'} ORDER BY created_at DESC LIMIT 30`, isAdmin ? [] : [userId]),
    ]);
    const searchAccounts = accounts.filter(item => item.automation_role === SEARCH_ROLE); const joinAccounts = accounts.filter(item => item.automation_role === JOIN_ROLE);
    const workers = accounts.map(account => { const worker = getTelegramService().getWorker(account.id); return { accountId: account.id, status: worker?.status || account.worker_state || account.status || 'DISCONNECTED', ready: isJoinWorkerReady(account), lastCheck: worker?.lastCheck || account.last_heartbeat_at || null, linksFound: Number(worker?.linksFound || 0), error: worker?.error || account.last_error || null, workerId: worker?.workerId || account.worker_id || null, connectionState: account.connection_state || 'DISCONNECTED', role: worker?.role || account.automation_role || null }; });
    return { accounts, searchAccounts, joinAccounts, links: links.map(link => ({ ...link, source_history: parseJSON(link.source_history), joined_by_accounts: parseJSON(link.joined_by_accounts) })), events: latestEvents, latestJobId: latestJob?.id || null, workers, stats: { total: Number(total?.count || 0), new: Number(newCount?.count || 0), pending: Number(pending?.count || 0), processing: Number(processing?.count || 0), joined: Number(joined?.count || 0), failed: Number(failed?.count || 0), operations: Number(operations?.total || 0), successfulOperations: Number(operations?.success || 0), retryOperations: Number(operations?.retry || 0), skippedOperations: Number(operations?.skipped || 0), activeJobs: Number(activeJobs?.count || 0) } };
  },

  async health(userId, isAdmin = false) {
    const accountScope = scope(userId, isAdmin, 'user_id');
    const accounts = await queryAll(`SELECT id,name,status,worker_state,connection_state,last_heartbeat_at,last_error FROM telegram_accounts WHERE ${accountScope.clause} ORDER BY name`, accountScope.params);
    let queueStats = {}; let redis = 'unknown'; let postgresql = 'unknown';
    try { postgresql = (await queryOne('SELECT 1 AS ok'))?.ok === 1 ? 'connected' : 'degraded'; } catch { postgresql = 'unavailable'; }
    try { queueStats = await QueueManager.getStats(); redis = Object.values(queueStats).some(item => item?.error) ? 'degraded' : 'connected'; } catch { redis = 'unavailable'; }
    const workersHealthy = accounts.filter(item => item.worker_state === 'RUNNING' && item.connection_state === 'CONNECTED').length;
    const status = postgresql === 'unavailable' || redis === 'unavailable' ? 'unhealthy' : accounts.some(item => item.worker_state === 'ERROR') ? 'degraded' : 'healthy';
    return { status, components: { postgresql, redis, queue: QueueManager._isRunning ? 'running' : 'stopped', workersHealthy, workersTotal: accounts.length, socket: 'available' }, accounts, queues: queueStats };
  },

  async getLinks({ userId, isAdmin = false, page = 1, pageSize = 50, search = '', status = '', joinStatus = '', linkType = '', archived = false, accountId = '', dateFrom = '', dateTo = '', sort = 'last_seen_at.desc' }) {
    const safePage = clampInt(page, 1, 1000000, 1); const safePageSize = clampInt(pageSize, 1, 100, 50); const offset = (safePage - 1) * safePageSize;
    const archivedValue = parseBoolean(archived, false); const conditions = [isAdmin ? 'TRUE' : 'l.user_id=$1', 'l.archived=$2']; const params = isAdmin ? [archivedValue] : [userId, archivedValue];
    const add = (sql, value) => { params.push(value); conditions.push(sql.replace('?', `$${params.length}`)); };
    if (search) add(`(l.normalized_url ILIKE ? OR l.telegram_identifier ILIKE ? OR l.original_url ILIKE ?)`, `%${search}%`);
    // For the triple search placeholders, duplicate the value with stable positions.
    if (search) { const base = params.length; params.splice(base - 1, 1, `%${search}%`, `%${search}%`, `%${search}%`); conditions[conditions.length - 1] = `(l.normalized_url ILIKE $${base} OR l.telegram_identifier ILIKE $${base + 1} OR l.original_url ILIKE $${base + 2})`; }
    if (status) add('l.status=?', status); if (joinStatus) add('l.join_status=?', joinStatus); if (linkType) add('l.link_type=?', linkType); if (accountId) add('l.source_account_id=?', accountId); if (dateFrom) add('l.last_seen_at>=?::timestamptz', dateFrom); if (dateTo) add('l.last_seen_at<=?::timestamptz', dateTo);
    const sortMap = { 'last_seen_at.desc': 'l.last_seen_at DESC', 'last_seen_at.asc': 'l.last_seen_at ASC', 'created_at.desc': 'l.created_at DESC', 'status.asc': 'l.status ASC,l.last_seen_at DESC' }; const order = sortMap[sort] || sortMap['last_seen_at.desc'];
    const count = await queryOne(`SELECT COUNT(*)::int total FROM telegram_automation_links l WHERE ${conditions.join(' AND ')}`, params);
    const rows = await queryAll(`SELECT l.*,ta.name source_account_name FROM telegram_automation_links l LEFT JOIN telegram_accounts ta ON ta.id=l.source_account_id WHERE ${conditions.join(' AND ')} ORDER BY ${order} LIMIT $${params.length + 1} OFFSET $${params.length + 2}`, [...params, safePageSize, offset]);
    return { items: rows.map(row => ({ ...row, source_history: parseJSON(row.source_history), joined_by_accounts: parseJSON(row.joined_by_accounts) })), page: safePage, pageSize: safePageSize, total: Number(count?.total || 0), totalPages: Math.ceil(Number(count?.total || 0) / safePageSize) };
  },

  async setAccountRole({ userId, accountId, role, enabled, isAdmin = false, requestId = null, req }) {
    if (![SEARCH_ROLE, JOIN_ROLE].includes(role)) { const error = new Error('الدور غير صالح'); error.code = 'ACCOUNT_WRONG_ROLE'; throw error; }
    const idempotency = await beginIdempotency(userId, 'ROLE_CHANGE', requestId);
    if (idempotency?.replay) return idempotency.response;
    const response = await withAdvisoryLock(`telegram-role:${accountId}`, async client => {
      const result = await client.query(`SELECT * FROM telegram_accounts WHERE id=$1 AND (${isAdmin ? 'TRUE' : 'user_id=$2'})`, isAdmin ? [accountId] : [accountId, userId]);
      const account = result.rows[0]; if (!account) { const error = new Error('الحساب غير موجود أو لا تملك صلاحية الوصول إليه'); error.code = 'ACCOUNT_NOT_OWNED'; throw error; }
      const activeOperation = await client.query(`SELECT id,job_id FROM telegram_join_operations WHERE account_id=$1 AND status='PROCESSING' LIMIT 1`, [accountId]);
      if (activeOperation.rows[0]) { const error = new Error('Account has active operation; أوقف المهمة أو انتظر انتهاء العملية قبل تغيير الدور'); error.code = 'ACCOUNT_ACTIVE_OPERATION'; error.statusCode = 409; throw error; }
      const before = { automation_role: account.automation_role, automation_enabled: account.automation_enabled, status: account.status };
      await getTelegramService().stopWorker(accountId);
      const update = await client.query(`UPDATE telegram_accounts SET automation_role=$1,automation_enabled=COALESCE($2,automation_enabled),role_transition_version=role_transition_version+1,worker_state='DISCONNECTED',connection_state='DISCONNECTED',updated_at=NOW() WHERE id=$3 RETURNING *`, [role, enabled === undefined ? null : Boolean(enabled), accountId]);
      const reloaded = update.rows[0];
      await recordAudit({ actorId: userId, userId: reloaded.user_id, action: 'ROLE_CHANGE', entityType: 'telegram_account', entityId: accountId, before, after: { automation_role: role, automation_enabled: reloaded.automation_enabled }, req });
      await getTelegramService().startWorker(reloaded);
      const runtimeWorker = getTelegramService().getWorker(accountId);
      if (runtimeWorker && runtimeWorker.role !== role) { const error = new Error('فشل تحقق تطابق دور Worker مع الدور الجديد'); error.code = 'ROLE_RUNTIME_MISMATCH'; error.statusCode = 409; throw error; }
      emit(reloaded.user_id, 'account_role_changed', { accountId, role, workerId: `${PROCESS_WORKER_ID}:${accountId}` });
      return { id: reloaded.id, name: reloaded.name, phone_number: reloaded.phone_number, username: reloaded.username, status: reloaded.status, automation_role: role, automation_enabled: reloaded.automation_enabled, worker_state: 'CONNECTING', connection_state: 'CONNECTING', operation_count: reloaded.operation_count, error_count: reloaded.error_count, last_error: reloaded.last_error };
    });
    await completeIdempotency(idempotency, response);
    return response;
  },

  async createDiscoveryJob({ userId, accountIds, isAdmin = false, requestId = null, req }) {
    const requested = [...new Set((accountIds || []).map(String).filter(Boolean))]; if (!requested.length) { const error = new Error('حدد حساب بحث واحدًا على الأقل'); error.code = 'ACCOUNT_NOT_FOUND'; throw error; }
    const accounts = await queryAll(`SELECT id,status,automation_role,automation_enabled FROM telegram_accounts WHERE id=ANY($1::uuid[]) AND (${isAdmin ? 'TRUE' : 'user_id=$2'})`, isAdmin ? [requested] : [requested, userId]);
    if (accounts.length !== requested.length) { const error = new Error('أحد حسابات البحث غير موجود أو لا تملك صلاحية الوصول إليه'); error.code = 'ACCOUNT_NOT_OWNED'; throw error; }
    if (accounts.some(item => item.automation_role !== SEARCH_ROLE || item.automation_enabled === false)) { const error = new Error('البحث متاح لحسابات SEARCH_ROLE المفعلة فقط'); error.code = 'ACCOUNT_WRONG_ROLE'; throw error; }
    const stableRequestId = requestId || crypto.randomUUID();
    const job = await queryOne(`INSERT INTO telegram_discovery_jobs(user_id,account_ids,total_accounts,status,worker_id,heartbeat_at,request_id) VALUES($1,$2::jsonb,$3,'QUEUED',$4,NOW(),$5) ON CONFLICT(user_id,request_id) WHERE request_id IS NOT NULL DO UPDATE SET updated_at=telegram_discovery_jobs.updated_at RETURNING *, (xmax=0) AS inserted`, [userId, JSON.stringify(requested), requested.length, PROCESS_WORKER_ID, stableRequestId]);
    if (job && !job.inserted) return { discoveryJob: job, status: job.status, idempotent: true };
    await recordAudit({ actorId: userId, userId, action: 'DISCOVERY_CREATE', entityType: 'telegram_discovery_job', entityId: job.id, after: { accountCount: requested.length }, req });
    try { await QueueManager.enqueueTelegramDiscovery({ discoveryJobId: job.id, userId }, { jobId: `telegram-discovery-${job.id}` }); }
    catch (error) { await query(`UPDATE telegram_discovery_jobs SET status='RETRY',error=$1,updated_at=NOW() WHERE id=$2`, [error.message, job.id]); throw Object.assign(new Error('تعذر إدخال مهمة البحث إلى الطابور'), { code: 'REDIS_UNAVAILABLE' }); }
    return { discoveryJob: job, status: 'QUEUED' };
  },

  async processDiscoveryJob({ discoveryJobId, userId }) {
    const job = await queryOne(`UPDATE telegram_discovery_jobs SET status='PROCESSING',started_at=COALESCE(started_at,NOW()),heartbeat_at=NOW(),lease_expires_at=NOW()+($1 * INTERVAL '1 second'),worker_id=$2,updated_at=NOW() WHERE id=$3 AND user_id=$4 AND (status IN ('QUEUED','RETRY') OR (status='PROCESSING' AND lease_expires_at<NOW())) RETURNING *`, [DISCOVERY_LEASE_SECONDS, `${PROCESS_WORKER_ID}:discovery`, discoveryJobId, userId]);
    if (!job) return;
    const ids = parseJSON(job.account_ids, []); const cursor = parseJSON(job.cursor, {}); let processed = Number(job.processed_accounts || 0); let linksFound = Number(job.links_found || 0); let linksSaved = Number(job.links_saved || 0); let duplicates = Number(job.duplicates || 0);
    try {
      for (let index = Number(cursor.accountIndex || 0); index < ids.length; index += 1) {
        const accountId = ids[index]; const account = await queryOne(`SELECT * FROM telegram_accounts WHERE id=$1 AND user_id=$2 AND automation_role=$3 AND automation_enabled=true`, [accountId, userId, SEARCH_ROLE]);
        if (!account || account.status !== 'connected') { processed += 1; await query(`UPDATE telegram_discovery_jobs SET processed_accounts=$1,progress=$2,cursor=$3::jsonb,heartbeat_at=NOW(),lease_expires_at=NOW()+($4 * INTERVAL '1 second'),updated_at=NOW() WHERE id=$5`, [processed, (processed / ids.length) * 100, JSON.stringify({ accountIndex: index + 1 }), DISCOVERY_LEASE_SECONDS, discoveryJobId]); continue; }
        const result = await getTelegramService().scanHistoryJob(accountId, discoveryJobId, { dialogIndex: Number(cursor.dialogIndex || 0), onProgress: async progress => { linksFound += Number(progress.linksFound || 0); linksSaved += Number(progress.linksSaved || 0); duplicates += Number(progress.duplicates || 0); await query(`UPDATE telegram_discovery_jobs SET total_dialogs=$1,processed_dialogs=$2,links_found=$3,links_saved=$4,duplicates=$5,cursor=$6::jsonb,heartbeat_at=NOW(),lease_expires_at=NOW()+($7 * INTERVAL '1 second'),updated_at=NOW() WHERE id=$8`, [progress.totalDialogs, progress.dialogIndex, linksFound, linksSaved, duplicates, JSON.stringify({ accountIndex: index, dialogIndex: progress.dialogIndex }), DISCOVERY_LEASE_SECONDS, discoveryJobId]); } });
        linksFound += Number(result.linksFound || 0); linksSaved += Number(result.linksSaved || 0); duplicates += Number(result.duplicates || 0); processed += 1;
        await query(`UPDATE telegram_discovery_jobs SET processed_accounts=$1,progress=$2,links_found=$3,links_saved=$4,duplicates=$5,cursor=$6::jsonb,heartbeat_at=NOW(),lease_expires_at=NOW()+($7 * INTERVAL '1 second'),updated_at=NOW() WHERE id=$8`, [processed, (processed / ids.length) * 100, linksFound, linksSaved, duplicates, JSON.stringify({ accountIndex: index + 1, dialogIndex: 0 }), DISCOVERY_LEASE_SECONDS, discoveryJobId]);
      }
      await query(`UPDATE telegram_discovery_jobs SET status='COMPLETED',progress=100,processed_accounts=total_accounts,links_found=$1,links_saved=$2,duplicates=$3,lease_expires_at=NULL,heartbeat_at=NOW(),completed_at=NOW(),updated_at=NOW() WHERE id=$4`, [linksFound, linksSaved, duplicates, discoveryJobId]);
      await recordEvent({ userId, eventType: 'discovery_completed', status: 'COMPLETED', payload: { discoveryJobId, linksFound, linksSaved, duplicates } });
    } catch (error) {
      await query(`UPDATE telegram_discovery_jobs SET status='RETRY',error=$1,heartbeat_at=NOW(),lease_expires_at=NULL,updated_at=NOW() WHERE id=$2`, [error.message, discoveryJobId]);
      await recordEvent({ userId, eventType: 'discovery_failed', status: 'RETRY', payload: { discoveryJobId, errorCode: error.code || 'DISCOVERY_ERROR' } });
      throw error;
    }
  },

  async createJob({ userId, accountIds, linkIds, allPending = false, settings = {}, isAdmin = false, requestId = null, req }) {
    const requestedAccounts = [...new Set((accountIds || []).map(String).filter(Boolean))]; let requestedLinks = [...new Set((linkIds || []).map(String).filter(Boolean))];
    if (!requestedAccounts.length || (!requestedLinks.length && !allPending)) { const error = new Error('يجب تحديد حسابات الانضمام وروابط مؤهلة'); error.code = 'JOB_INVALID_STATE'; throw error; }
    const savedSettings = await this.getSettings(userId);
    const effectiveSettings = { ...savedSettings, ...(settings || {}) };
    const safeSettings = { minDelaySeconds: clampInt(effectiveSettings.minDelaySeconds, 30, 86400, 120), maxDelaySeconds: clampInt(effectiveSettings.maxDelaySeconds, 30, 86400, 150), maxRetries: clampInt(effectiveSettings.maxRetries, 0, 2, 1), retryBackoffSeconds: clampInt(effectiveSettings.retryBackoffSeconds, 30, 3600, 60), strategy: ['least_loaded', 'smart', 'round_robin'].includes(effectiveSettings.strategy) ? effectiveSettings.strategy : 'round_robin' };
    if (safeSettings.minDelaySeconds > safeSettings.maxDelaySeconds) { const error = new Error('الحد الأدنى للفاصل لا يمكن أن يتجاوز الحد الأقصى'); error.code = 'JOB_INVALID_STATE'; throw error; }
    const result = await withTransaction(async client => {
      const accountQuery = await client.query(`SELECT id,name,status,automation_role,automation_enabled,next_allowed_operation_at FROM telegram_accounts WHERE id=ANY($1::uuid[]) AND (${isAdmin ? 'TRUE' : 'user_id=$2'})`, isAdmin ? [requestedAccounts] : [requestedAccounts, userId]);
      const accounts = accountQuery.rows; if (accounts.length !== requestedAccounts.length || accounts.some(item => item.automation_role !== JOIN_ROLE || item.automation_enabled === false || item.status !== 'connected')) { const error = new Error('كل الحسابات المحددة يجب أن تكون Telegram متصلة ومخصصة لدور الانضمام فقط'); error.code = 'ACCOUNT_OFFLINE'; throw error; } const notReady = accounts.find(item => !isJoinWorkerReady(item)); if (notReady) { const error = new Error(`حساب الانضمام ${notReady.name || ''} متصل في قاعدة البيانات، لكن Worker Telegram الفعلي ليس جاهزًا بعد. انتظر حتى يظهر Worker بحالة RUNNING ثم أعد المحاولة`); error.code = 'ACCOUNT_OFFLINE'; throw error; }
      const loadQuery = await client.query(`SELECT account_id,COUNT(*) FILTER (WHERE status IN ('QUEUED','PROCESSING','RETRY'))::int AS active_count,COUNT(*) FILTER (WHERE status='FAILED' AND updated_at>NOW()-INTERVAL '24 hours')::int AS recent_failures,MAX(updated_at) FILTER (WHERE status='SUCCESS') AS last_success_at FROM telegram_join_operations WHERE user_id=$1 AND account_id=ANY($2::uuid[]) GROUP BY account_id`, [userId, requestedAccounts]);
      const loadByAccount = new Map(loadQuery.rows.map(row => [String(row.account_id), row]));
      const orderedAccounts = [...accounts].sort((a, b) => {
        if (safeSettings.strategy === 'round_robin') return 0;
        const left = loadByAccount.get(String(a.id)) || {}; const right = loadByAccount.get(String(b.id)) || {};
        const aScore = Number(left.active_count || 0) + Number(left.recent_failures || 0) * (safeSettings.strategy === 'smart' ? 3 : 2) + (a.next_allowed_operation_at && new Date(a.next_allowed_operation_at) > new Date() ? 1000 : 0);
        const bScore = Number(right.active_count || 0) + Number(right.recent_failures || 0) * (safeSettings.strategy === 'smart' ? 3 : 2) + (b.next_allowed_operation_at && new Date(b.next_allowed_operation_at) > new Date() ? 1000 : 0);
        return aScore - bScore || String(a.id).localeCompare(String(b.id));
      });
      if (allPending) {
        const allPendingQuery = await client.query(`SELECT id FROM telegram_automation_links WHERE archived=false AND join_status='PENDING' AND (${isAdmin ? 'TRUE' : 'user_id=$1'}) ORDER BY created_at ASC`, isAdmin ? [] : [userId]);
        requestedLinks = allPendingQuery.rows.map(row => String(row.id));
      }
      if (!requestedLinks.length) { const error = new Error('لا توجد روابط جاهزة للانضمام'); error.code = 'LINK_NOT_FOUND'; throw error; }
      const linkQuery = await client.query(`SELECT id,normalized_url,telegram_identifier,link_type FROM telegram_automation_links WHERE id=ANY($1::uuid[]) AND archived=false AND (${isAdmin ? 'TRUE' : 'user_id=$2'})`, isAdmin ? [requestedLinks] : [requestedLinks, userId]);
      const links = linkQuery.rows; if (!links.length || links.length !== requestedLinks.length) { const error = new Error('لا توجد روابط Telegram مؤهلة ضمن التحديد'); error.code = 'LINK_NOT_FOUND'; throw error; }
      const stableRequestId = requestId || crypto.randomUUID();
      const jobResult = await client.query(`INSERT INTO telegram_automation_jobs(user_id,job_type,status,requested_account_ids,requested_link_ids,settings,request_id) VALUES($1,'JOIN','QUEUED',$2::jsonb,$3::jsonb,$4::jsonb,$5) ON CONFLICT(user_id,request_id) WHERE request_id IS NOT NULL DO UPDATE SET updated_at=telegram_automation_jobs.updated_at RETURNING *, (xmax=0) AS inserted`, [userId, JSON.stringify(requestedAccounts), JSON.stringify(requestedLinks), JSON.stringify(safeSettings), stableRequestId]);
      const job = jobResult.rows[0];
      if (job && !job.inserted) return { job, totalOperations: Number(job.total_count || 0), outboxes: [], idempotent: true };
      let created = 0; const outboxes = [];
      for (let linkIndex = 0; linkIndex < links.length; linkIndex += 1) {
        const selected = orderedAccounts[linkIndex % orderedAccounts.length];
        const link = links[linkIndex];
        const operationId = crypto.randomUUID();
        const reservation = await GlobalJoinRegistry.reserve({ client, userId, accountId: selected.id, operationId, originalUrl: link.normalized_url, normalizedUrl: link.normalized_url, telegramIdentifier: link.telegram_identifier, linkType: link.link_type });
        if (!reservation.allowed) {
          const skipped = await client.query(`INSERT INTO telegram_join_operations(id,user_id,link_id,account_id,job_id,idempotency_key,status,result_code,error_code,error_message,scheduled_at) VALUES($1,$2,$3,$4,$5,$6,'SKIPPED','GLOBAL_DUPLICATE','GLOBAL_DUPLICATE',$7,NOW()) ON CONFLICT DO NOTHING RETURNING *`, [operationId, userId, link.id, selected.id, job.id, `tg-join:${job.id}:${link.id}:${selected.id}:duplicate`, `تم تخطي الرابط: ${reservation.reason === 'GLOBAL_RESERVED' ? 'محجوز حاليًا' : 'تم الانضمام إليه عالميًا مسبقًا'}`]);
          if (skipped.rows[0]) { created += 1; await client.query(`INSERT INTO telegram_global_join_audit(user_id,account_id,operation_id,original_url,normalized_url,url_hash,action,previous_status,new_status,reason,created_at) VALUES($1,$2,$3,$4,$5,$6,'SKIPPED',$7,'SKIPPED_DUPLICATE',$8,NOW())`, [userId, selected.id, operationId, link.normalized_url, link.normalized_url, reservation.normalized?.urlHash || '', reservation.existing?.status || null, reservation.reason]); }
          continue;
        }
        const delaySeconds = safeSettings.minDelaySeconds + (safeSettings.maxDelaySeconds > safeSettings.minDelaySeconds ? crypto.randomInt(0, safeSettings.maxDelaySeconds - safeSettings.minDelaySeconds + 1) : 0) + created * safeSettings.minDelaySeconds;
        const opResult = await client.query(`INSERT INTO telegram_join_operations(id,user_id,link_id,account_id,job_id,idempotency_key,status,scheduled_at) VALUES($1,$2,$3,$4,$5,$6,'QUEUED',NOW()+($7 * INTERVAL '1 second')) ON CONFLICT DO NOTHING RETURNING *`, [operationId, userId, link.id, selected.id, job.id, `tg-join:${job.id}:${link.id}:${selected.id}`, delaySeconds]);
        const operation = opResult.rows[0]; if (!operation) continue;
        const scheduledAt = new Date(Date.now() + delaySeconds * 1000).toISOString();
        const payload = { operationId: operation.id, userId, jobId: job.id, accountId: selected.id, linkId: link.id, settings: safeSettings, scheduledAt };
        const outbox = await client.query(`INSERT INTO telegram_automation_outbox(aggregate_type,aggregate_id,event_type,payload) VALUES('JOIN_OPERATION',$1,'ENQUEUE_JOIN',$2::jsonb) ON CONFLICT(aggregate_type,aggregate_id,event_type) DO NOTHING RETURNING id`, [operation.id, JSON.stringify(payload)]);
        if (outbox.rows[0]) outboxes.push(outbox.rows[0].id); created += 1;
      }
      if (!created) { const error = new Error('لم تُنشأ عمليات جديدة؛ كل علاقات الحساب والرابط موجودة مسبقًا أو تمت معالجتها'); error.code = 'DUPLICATE_OPERATION'; throw error; }
      await client.query(`UPDATE telegram_automation_jobs SET total_count=$1,status='RUNNING',started_at=NOW(),updated_at=NOW() WHERE id=$2`, [created, job.id]);
      await client.query(`INSERT INTO telegram_automation_events(user_id,job_id,event_type,status,payload) VALUES($1,$2,'job_created','RUNNING',$3::jsonb)`, [userId, job.id, JSON.stringify({ total: created, accountCount: accounts.length, linkCount: links.length })]);
      return { job: { ...job, total_count: created, status: 'RUNNING' }, totalOperations: created, outboxes };
    });
    await this.dispatchOutboxBatch().catch(() => {});
    await recordAudit({ actorId: userId, userId, action: 'JOB_CREATE', entityType: 'telegram_automation_job', entityId: result.job.id, after: { totalOperations: result.totalOperations }, req });
    emit(userId, 'job_created', { jobId: result.job.id, totalOperations: result.totalOperations });
    return result;
  },

  async previewLinks({ userId, contentBase64 = '', filename = '' }) {
    const rawLinks = LinkImportService.parseImportFile(Buffer.from(String(contentBase64 || ''), 'base64'), filename);
    const parsed = rawLinks.map(raw => ({ raw: String(raw || '').trim(), link: normalizeTelegramLink(raw) })).filter(item => item.raw);
    const unique = [...new Map(parsed.filter(item => item.link).map(item => [item.link.normalizedUrl, item])).values()];
    const normalized = unique.map(item => item.link.normalizedUrl);
    const existingRows = normalized.length ? await queryAll(`SELECT normalized_url FROM telegram_automation_links WHERE user_id=$1 AND normalized_url=ANY($2::text[])`, [userId, normalized]) : [];
    const existing = new Set(existingRows.map(row => row.normalized_url));
    const items = parsed.slice(0, 2000).map(item => item.link ? { originalUrl: item.raw, normalizedUrl: item.link.normalizedUrl, status: existing.has(item.link.normalizedUrl) ? 'existing' : 'new', reason: existing.has(item.link.normalizedUrl) ? 'موجود مسبقًا' : 'سيُضاف بعد التأكيد' } : { originalUrl: item.raw, normalizedUrl: null, status: 'invalid', reason: 'رابط تيليجرام غير صالح' });
    const newCount = unique.filter(item => !existing.has(item.link.normalizedUrl)).length;
    return { filename, total: rawLinks.length, uniqueCount: unique.length, duplicateInFile: Math.max(0, rawLinks.length - unique.length), existingCount: unique.length - newCount, invalidCount: parsed.filter(item => !item.link).length, newCount, items, previewTruncated: parsed.length > 2000 };
  },

  async importLinks({ userId, links = [], content = '', contentBase64 = '', filename = '', format = 'txt', requestId = null, req }) {
    const idempotency = await beginIdempotency(userId, 'LINK_IMPORT', requestId);
    if (idempotency?.replay) return idempotency.response;
    let rawLinks = Array.isArray(links) ? links : [];
    if (!rawLinks.length && contentBase64) {
      rawLinks = LinkImportService.parseImportFile(Buffer.from(String(contentBase64), 'base64'), filename);
    }
    if (!rawLinks.length && content) {
      if (format === 'json') { const parsed = JSON.parse(content); rawLinks = Array.isArray(parsed) ? parsed : parsed.links || []; }
      else rawLinks = String(content).split(/[\\r\\n,]+/).map(value => value.trim()).filter(Boolean);
    }
    rawLinks = rawLinks.map(item => typeof item === 'string' ? item : item.url || item.link || '').filter(Boolean);
    if (!rawLinks.length) { const error = new Error('لم يتم العثور على روابط في بيانات الاستيراد'); error.code = 'INVALID_LINK'; throw error; }
    let saved = 0; let duplicates = 0; let invalid = 0;
    for (const raw of rawLinks) {
      const parsed = normalizeTelegramLink(raw); if (!parsed) { invalid += 1; continue; }
      const sourceKey = `import:file:${parsed.normalizedUrl}`;
      const row = await queryOne(`INSERT INTO telegram_automation_links(user_id,normalized_url,original_url,telegram_identifier,link_type,source_account_id,source_history) VALUES($1,$2,$3,$4,$5,NULL,$6::jsonb) ON CONFLICT(user_id,normalized_url) DO UPDATE SET last_seen_at=NOW(),updated_at=NOW() RETURNING id,(xmax=0) AS inserted`, [userId, parsed.normalizedUrl, parsed.originalUrl, parsed.identifier, parsed.linkType, JSON.stringify([{ accountId: null, accountName: null, sourceType: 'IMPORT_FILE', seenAt: new Date().toISOString(), sourceKey }])]);
      await GlobalJoinRegistry.register({ userId, originalUrl: parsed.originalUrl, normalizedUrl: parsed.normalizedUrl, telegramIdentifier: parsed.identifier, linkType: parsed.linkType, sourceType: 'IMPORT_FILE', sourceKey });
      if (row?.inserted) { saved += 1; await recordEvent({ userId, accountId: null, linkId: row.id, eventType: 'link_imported', status: 'NEW', payload: { normalizedUrl: parsed.normalizedUrl, sourceType: 'IMPORT_FILE', globalRegistry: true } }); } else duplicates += 1;
    }
    const response = { saved, duplicates, invalid, total: rawLinks.length };
    await recordAudit({ actorId: userId, userId, action: 'LINK_IMPORT', entityType: 'telegram_automation_link', after: response, req });
    await completeIdempotency(idempotency, response);
    return response;
  },

  async notifications(userId, options = {}) {
    return queryAll(`SELECT * FROM telegram_automation_notifications WHERE user_id=$1 ${options.unreadOnly ? 'AND is_read=false' : ''} ORDER BY created_at DESC LIMIT 100`, [userId]);
  },
  async markNotificationRead(userId, notificationId) {
    const row = await queryOne(`UPDATE telegram_automation_notifications SET is_read=true,read_at=NOW() WHERE id=$1 AND user_id=$2 RETURNING *`, [notificationId, userId]);
    if (!row) { const error = new Error('الإشعار غير موجود'); error.code = 'NOTIFICATION_NOT_FOUND'; throw error; }
    return row;
  },

  async dispatchOutbox(outboxId) {
    const row = await queryOne(`UPDATE telegram_automation_outbox SET status='PROCESSING',attempt_count=attempt_count+1 WHERE id=$1 AND status IN ('PENDING','RETRY') AND available_at<=NOW() RETURNING *`, [outboxId]);
    if (!row) return;
    try {
      const payload = parseJSON(row.payload, {});
      if (row.event_type === 'ENQUEUE_JOIN') await QueueManager.enqueueTelegramJoin(payload, { delay: Math.max(0, new Date(payload.scheduledAt || 0).getTime() - Date.now()), jobId: `telegram-join-${payload.operationId}` });
      await query(`UPDATE telegram_automation_outbox SET status='PROCESSED',processed_at=NOW(),last_error=NULL WHERE id=$1`, [outboxId]);
    } catch (error) {
      const delay = OUTBOX_RETRY_SECONDS * Math.max(1, Number(row.attempt_count || 1));
      await query(`UPDATE telegram_automation_outbox SET status='RETRY',available_at=NOW()+($1 * INTERVAL '1 second'),last_error=$2 WHERE id=$3`, [Math.min(3600, delay), error.message, outboxId]);
      await QueueManager.enqueueTelegramOutbox({ outboxId }, { delay: Math.min(3600, delay) * 1000, jobId: `telegram-outbox-${outboxId}-retry-${row.attempt_count}` }).catch(() => {});
    }
  },
  async dispatchOutboxBatch() {
    const rows = await queryAll(`SELECT id FROM telegram_automation_outbox WHERE status IN ('PENDING','RETRY') AND available_at<=NOW() ORDER BY created_at LIMIT 100`);
    for (const row of rows) await QueueManager.enqueueTelegramOutbox({ outboxId: row.id }, { jobId: `telegram-outbox-${row.id}` }).catch(() => {});
    return rows.length;
  },

  async processOperation({ operationId, userId, jobId, accountId, linkId, settings = {}, workerId = `${PROCESS_WORKER_ID}:join` }) {
    const operation = await queryOne(`UPDATE telegram_join_operations SET status='PROCESSING',attempt_count=attempt_count+1,last_attempt_at=NOW(),processing_started_at=NOW(),heartbeat_at=NOW(),lease_expires_at=NOW()+($1 * INTERVAL '1 second'),worker_id=$2,queue_job_id=COALESCE($3,queue_job_id),updated_at=NOW() WHERE id=$4 AND user_id=$5 AND status IN ('QUEUED','RETRY') RETURNING *`, [OPERATION_LEASE_SECONDS, workerId, jobId || null, operationId, userId]);
    if (!operation) return { skipped: true, reason: 'OPERATION_ALREADY_PROCESSING_OR_FINISHED' };
    const lockKey = `telegram_join:${userId}:${linkId}:${accountId}`;
    const locked = await withAdvisoryLock(lockKey, async () => {
      let heartbeat = setInterval(() => query(`UPDATE telegram_join_operations SET heartbeat_at=NOW(),lease_expires_at=NOW()+($1 * INTERVAL '1 second'),updated_at=NOW() WHERE id=$2 AND status='PROCESSING'`, [OPERATION_LEASE_SECONDS, operation.id]).catch(() => {}), 10000); heartbeat.unref?.();
      const started = Date.now();
      try {
        const [account, link] = await Promise.all([queryOne(`SELECT * FROM telegram_accounts WHERE id=$1 AND user_id=$2`, [accountId, userId]), queryOne(`SELECT * FROM telegram_automation_links WHERE id=$1 AND user_id=$2 AND archived=false`, [linkId, userId])]);
        if (!account) throw Object.assign(new Error('حساب Telegram غير موجود أو خارج الملكية'), { code: 'ACCOUNT_NOT_OWNED' });
        if (account.automation_role !== JOIN_ROLE) throw Object.assign(new Error('الحساب ليس JOIN_ROLE'), { code: 'ACCOUNT_WRONG_ROLE' });
        if (account.automation_enabled === false) throw Object.assign(new Error('الحساب معطل للأتمتة'), { code: 'ACCOUNT_DISABLED' });
        if (account.status !== 'connected') throw Object.assign(new Error('الحساب غير متصل'), { code: 'ACCOUNT_OFFLINE' });
        if (!link) throw Object.assign(new Error('رابط Telegram غير موجود أو مؤرشف'), { code: 'LINK_NOT_FOUND' });
        if (account.next_allowed_operation_at && new Date(account.next_allowed_operation_at).getTime() > Date.now()) {
          const delay = Math.max(30, Math.ceil((new Date(account.next_allowed_operation_at).getTime() - Date.now()) / 1000));
          await query(`UPDATE telegram_join_operations SET status='RETRY',error_code='ACCOUNT_COOLDOWN',error_message='الحساب داخل فترة cooldown',scheduled_at=NOW()+($1 * INTERVAL '1 second'),lease_expires_at=NULL,heartbeat_at=NOW(),updated_at=NOW() WHERE id=$2`, [delay, operation.id]);
          await QueueManager.enqueueTelegramJoin({ operationId, userId, jobId, accountId, linkId, settings }, { delay: delay * 1000, jobId: `telegram-join-${operation.id}-cooldown-${operation.attempt_count}` });
          await recordEvent({ userId, jobId, operationId, accountId, linkId, eventType: 'operation_retry', status: 'RETRY', payload: { errorCode: 'ACCOUNT_COOLDOWN', delaySeconds: delay } });
          return { deferred: true };
        }
        const worker = getTelegramService().getWorker(account.id);
        if (!isJoinWorkerReady(account)) throw Object.assign(new Error('جلسة Telegram لحساب الانضمام غير جاهزة؛ انتظر ظهور Worker بحالة RUNNING ثم أعد المحاولة'), { code: 'ACCOUNT_OFFLINE' });
        const minDelay = clampInt(settings.minDelaySeconds, 30, 86400, 120);
        await query(`UPDATE telegram_accounts SET next_allowed_operation_at=NOW()+($1 * INTERVAL '1 second'),last_operation_at=NOW(),last_heartbeat_at=NOW(),worker_id=$2,worker_state='RUNNING',connection_state='CONNECTED',updated_at=NOW() WHERE id=$3`, [minDelay, worker.workerId || workerId, account.id]);
        const { Api } = require('telegram');
        try {
          let telegramResult;
          if (link.link_type === 'PRIVATE_INVITE') telegramResult = await worker.client.invoke(new Api.messages.ImportChatInvite({ hash: link.telegram_identifier }));
          else { const entity = await worker.client.getInputEntity(link.telegram_identifier); telegramResult = await worker.client.invoke(new Api.channels.JoinChannel({ channel: entity })); }
          const verification = await verifyMembership(worker.client, link, telegramResult);
          const directEvidence = Boolean(telegramResult && (telegramResult.className || telegramResult.chats || telegramResult.updates));
          if (!verification.verified && !directEvidence) {
            await this.finishOperation(operation, { status: 'FAILED', resultCode: 'NOT_VERIFIED', errorCode: 'NOT_VERIFIED', errorMessage: verification.reason || 'تعذر إثبات العضوية بعد نجاح طلب Telegram', membershipState: verification.state || 'NOT_VERIFIED', durationMs: Date.now() - started });
            return { status: 'FAILED', resultCode: 'NOT_VERIFIED' };
          }
          await this.finishOperation(operation, { status: 'SUCCESS', resultCode: 'SUCCESS', membershipState: verification.verified ? 'JOINED' : 'NOT_VERIFIED', durationMs: Date.now() - started, verificationEvidence: verification.evidence || { directTelegramResult: telegramResult.className || 'TELEGRAM_RESPONSE' } });
        } catch (error) {
          const classified = classifyError(error);
          const retryCount = clampInt(settings.maxRetries, 0, 2, 1); const canRetry = Boolean(classified.retryable) && Number(operation.attempt_count || 0) <= retryCount;
          if (classified.resultCode === 'ALREADY_MEMBER') { await this.finishOperation(operation, { status: 'SUCCESS', resultCode: 'ALREADY_MEMBER', membershipState: 'ALREADY_MEMBER', durationMs: Date.now() - started }); return { status: 'SUCCESS', resultCode: 'ALREADY_MEMBER' }; }
          if (canRetry) {
            const delay = Math.max(30, Math.min(86400, Number(classified.retryAfterSeconds || settings.retryBackoffSeconds || 60) * Math.max(1, Number(operation.attempt_count || 1))));
            await query(`UPDATE telegram_join_operations SET status='RETRY',error_code=$1,error_message=$2,scheduled_at=NOW()+($3 * INTERVAL '1 second'),lease_expires_at=NULL,heartbeat_at=NOW(),duration_ms=$4,updated_at=NOW() WHERE id=$5`, [classified.resultCode, String(error.message || error), delay, Date.now() - started, operation.id]);
            await QueueManager.enqueueTelegramJoin({ operationId, userId, jobId, accountId, linkId, settings }, { delay: delay * 1000, jobId: `telegram-join-${operation.id}-retry-${operation.attempt_count}` });
            await recordEvent({ userId, jobId, operationId, accountId, linkId, eventType: 'operation_retry', status: 'RETRY', payload: { errorCode: classified.resultCode, delaySeconds: delay } });
            return { status: 'RETRY', resultCode: classified.resultCode };
          }
          const status = ['ACCOUNT_UNAVAILABLE', 'ACCOUNT_OFFLINE', 'ACCOUNT_DISABLED', 'INVALID_LINK'].includes(classified.resultCode) ? 'SKIPPED' : 'FAILED';
          await this.finishOperation(operation, { status, resultCode: classified.resultCode, errorCode: classified.resultCode, errorMessage: String(error.message || error), membershipState: classified.membershipState || null, durationMs: Date.now() - started });
          if (status !== 'SUCCESS') await query(`UPDATE telegram_accounts SET error_count=error_count+1,last_error=$1,worker_state=CASE WHEN $2='ACCOUNT_UNAVAILABLE' THEN 'AUTH_REQUIRED' ELSE worker_state END,updated_at=NOW() WHERE id=$3`, [String(error.message || error), classified.resultCode, accountId]).catch(() => {});
          return { status, resultCode: classified.resultCode };
        }
      } catch (error) {
        const classified = classifyError(error); const retryCount = clampInt(settings.maxRetries, 0, 2, 1); const canRetry = classified.retryable && Number(operation.attempt_count || 0) <= retryCount;
        if (canRetry) { const delay = Math.max(30, Math.min(3600, Number(classified.retryAfterSeconds || settings.retryBackoffSeconds || 60))); await query(`UPDATE telegram_join_operations SET status='RETRY',error_code=$1,error_message=$2,scheduled_at=NOW()+($3 * INTERVAL '1 second'),lease_expires_at=NULL,heartbeat_at=NOW(),updated_at=NOW() WHERE id=$4`, [classified.resultCode, error.message, delay, operation.id]); await QueueManager.enqueueTelegramJoin({ operationId, userId, jobId, accountId, linkId, settings }, { delay: delay * 1000, jobId: `telegram-join-${operation.id}-retry-${operation.attempt_count}` }).catch(() => {}); await recordEvent({ userId, jobId, operationId, accountId, linkId, eventType: 'operation_retry', status: 'RETRY', payload: { errorCode: classified.resultCode, delaySeconds: delay } }); return { status: 'RETRY' }; }
        const status = ['ACCOUNT_NOT_OWNED', 'ACCOUNT_WRONG_ROLE', 'ACCOUNT_DISABLED', 'ACCOUNT_OFFLINE', 'LINK_NOT_FOUND'].includes(error.code) ? 'SKIPPED' : 'FAILED'; await this.finishOperation(operation, { status, resultCode: error.code || classified.resultCode, errorCode: error.code || classified.resultCode, errorMessage: error.message, durationMs: Date.now() - started }); return { status, resultCode: error.code || classified.resultCode };
      } finally { clearInterval(heartbeat); await query(`UPDATE telegram_join_operations SET lease_expires_at=NULL,heartbeat_at=NOW(),updated_at=NOW() WHERE id=$1 AND status='PROCESSING'`, [operation.id]).catch(() => {}); }
    }, { wait: false });
    if (locked?.locked === false) { const delay = 30; await query(`UPDATE telegram_join_operations SET status='RETRY',error_code='OPERATION_ALREADY_PROCESSING',error_message='قفل العملية مستخدم حاليًا',scheduled_at=NOW()+($1 * INTERVAL '1 second'),lease_expires_at=NULL,heartbeat_at=NOW(),updated_at=NOW() WHERE id=$2`, [delay, operation.id]); await QueueManager.enqueueTelegramJoin({ operationId, userId, jobId, accountId, linkId, settings }, { delay: delay * 1000, jobId: `telegram-join-${operation.id}-lock-${operation.attempt_count}` }).catch(() => {}); await recordEvent({ userId, jobId, operationId, accountId, linkId, eventType: 'operation_retry', status: 'RETRY', payload: { errorCode: 'OPERATION_ALREADY_PROCESSING' } }); }
    return locked;
  },

  async finishOperation(operation, result) {
    const status = result.status; const successful = status === 'SUCCESS';
    await withTransaction(async client => {
      const updated = await client.query(`UPDATE telegram_join_operations SET status=$1::varchar(30),result_code=$2,error_code=$3,error_message=$4,membership_state=$5,verification_evidence=$6::jsonb,duration_ms=$7,lease_expires_at=NULL,heartbeat_at=NOW(),joined_at=CASE WHEN $1::text='SUCCESS' THEN NOW() ELSE joined_at END,updated_at=NOW() WHERE id=$8 AND status='PROCESSING' RETURNING id`, [status, result.resultCode || null, result.errorCode || null, result.errorMessage || null, result.membershipState || null, JSON.stringify(safePayload(result.verificationEvidence || {})), result.durationMs || null, operation.id]);
      if (!updated.rows[0]) return;
      await client.query(`UPDATE telegram_accounts SET operation_count=operation_count+1,last_operation_at=NOW(),last_success_at=CASE WHEN $1::text='SUCCESS' THEN NOW() ELSE last_success_at END,last_error=CASE WHEN $1::text='SUCCESS' THEN NULL ELSE COALESCE($2::text,last_error) END,updated_at=NOW() WHERE id=$3`, [status, result.errorMessage || null, operation.account_id]);
      const linkRow = (await client.query(`SELECT normalized_url FROM telegram_automation_links WHERE id=$1`, [operation.link_id])).rows[0];
      const globalRow = linkRow ? (await client.query(`SELECT id FROM telegram_global_join_links WHERE normalized_url=$1 FOR UPDATE`, [linkRow.normalized_url])).rows[0] : null;
      if (successful) {
        await client.query(`UPDATE telegram_automation_links SET joined_by_accounts=(SELECT COALESCE(jsonb_agg(DISTINCT value),'[]'::jsonb) FROM (SELECT value FROM jsonb_array_elements(COALESCE(joined_by_accounts,'[]'::jsonb)) ids(value) UNION ALL SELECT to_jsonb($1::text)) v),last_error=NULL,updated_at=NOW() WHERE id=$2`, [String(operation.account_id), operation.link_id]);
        if (globalRow) await GlobalJoinRegistry.markJoined(client, { registryId: globalRow.id, accountId: operation.account_id, operationId: operation.id, userId: operation.user_id, normalizedUrl: linkRow.normalized_url, chatId: result.telegramChatId || result.chatId || null, username: result.telegramUsername || null, status: result.resultCode === 'ALREADY_MEMBER' ? 'ALREADY_MEMBER' : 'JOINED' });
      } else {
        if (result.errorMessage) await client.query(`UPDATE telegram_automation_links SET last_error=$1,updated_at=NOW() WHERE id=$2`, [result.errorMessage, operation.link_id]);
        if (globalRow) await GlobalJoinRegistry.markFailed(client, { registryId: globalRow.id, userId: operation.user_id, accountId: operation.account_id, operationId: operation.id, errorCode: result.errorCode || result.resultCode, errorMessage: result.errorMessage || null });
      }
      await updateLinkAggregate(operation.link_id, client);
      await client.query(`UPDATE telegram_automation_jobs SET processed_count=processed_count+1,success_count=success_count+CASE WHEN $1::text='SUCCESS' THEN 1 ELSE 0 END,failed_count=failed_count+CASE WHEN $1::text='FAILED' THEN 1 ELSE 0 END,skipped_count=skipped_count+CASE WHEN $1::text='SKIPPED' THEN 1 ELSE 0 END,status=CASE WHEN processed_count+1>=total_count THEN 'COMPLETED' ELSE status END,completed_at=CASE WHEN processed_count+1>=total_count THEN NOW() ELSE completed_at END,updated_at=NOW() WHERE id=$2`, [status, operation.job_id]);
      await client.query(`INSERT INTO telegram_automation_events(user_id,job_id,operation_id,account_id,link_id,event_type,status,payload) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb)`, [operation.user_id, operation.job_id, operation.id, operation.account_id, operation.link_id, successful ? 'operation_completed' : 'operation_failed', status, JSON.stringify(safePayload({ resultCode: result.resultCode || null, membershipState: result.membershipState || null, errorCode: result.errorCode || null, durationMs: result.durationMs || null, verificationEvidence: result.verificationEvidence || {}, idempotent: result.resultCode === 'ALREADY_MEMBER' }))]);
    });
    const completedJob = await queryOne(`SELECT status FROM telegram_automation_jobs WHERE id=$1`, [operation.job_id]).catch(() => null);
    if (completedJob?.status === 'COMPLETED') await query(`INSERT INTO telegram_automation_notifications(user_id,notification_type,title,body,entity_type,entity_id) VALUES($1,'JOB_COMPLETED','اكتملت مهمة Telegram','اكتملت كل عمليات مهمة الانضمام بنجاح أو بنتيجة نهائية','telegram_automation_job',$2)`, [operation.user_id, operation.job_id]).catch(() => {});
    emit(operation.user_id, status === 'SUCCESS' ? 'operation_completed' : 'operation_failed', { jobId: operation.job_id, operationId: operation.id, accountId: operation.account_id, linkId: operation.link_id, status, payload: { resultCode: result.resultCode || null, membershipState: result.membershipState || null, idempotent: result.resultCode === 'ALREADY_MEMBER' } });
  },

  async recoverStaleOperations() {
    const stale = await queryAll(`SELECT id,user_id,job_id,account_id,link_id,attempt_count,recovery_count FROM telegram_join_operations WHERE status='PROCESSING' AND lease_expires_at IS NOT NULL AND lease_expires_at<NOW() LIMIT 100`); let recovered = 0;
    for (const operation of stale) {
      const worker = getTelegramService().getWorker(operation.account_id);
      const link = await queryOne(`SELECT id,telegram_identifier,link_type FROM telegram_automation_links WHERE id=$1 AND user_id=$2 AND archived=false`, [operation.link_id, operation.user_id]);
      if (!worker?.client || !link) {
        await query(`UPDATE telegram_join_operations SET lease_expires_at=NOW()+INTERVAL '60 seconds',heartbeat_at=NOW(),error_code='RECOVERY_WAITING_FOR_VERIFICATION',error_message='ينتظر Recovery اتصال الحساب للتحقق من العضوية',updated_at=NOW() WHERE id=$1 AND status='PROCESSING'`, [operation.id]).catch(() => {});
        continue;
      }
      let verification;
      try { verification = await verifyMembership(worker.client, link); } catch { verification = { verified: false, state: 'UNKNOWN', reason: 'VERIFY_EXCEPTION' }; }
      if (verification.verified) {
        const current = await queryOne(`SELECT * FROM telegram_join_operations WHERE id=$1 AND status='PROCESSING'`, [operation.id]);
        if (current) await this.finishOperation(current, { status: 'SUCCESS', resultCode: 'ALREADY_MEMBER', membershipState: 'ALREADY_MEMBER', verificationEvidence: { ...verification.evidence, recovered: true }, durationMs: null });
        await recordEvent({ userId: operation.user_id, jobId: operation.job_id, operationId: operation.id, accountId: operation.account_id, linkId: operation.link_id, eventType: 'operation_recovered_as_already_member', status: 'SUCCESS', payload: { recoveryCount: Number(operation.recovery_count || 0) } });
        recovered += 1;
        continue;
      }
      const row = await queryOne(`UPDATE telegram_join_operations SET status='RETRY',recovery_count=recovery_count+1,error_code='OPERATION_RECOVERED',error_message=$1,lease_expires_at=NULL,heartbeat_at=NOW(),scheduled_at=NOW()+INTERVAL '5 seconds',updated_at=NOW() WHERE id=$2 AND status='PROCESSING' AND lease_expires_at<NOW() RETURNING *`, [verification.state === 'PRIVATE_OR_RESTRICTED' ? 'تعذر التحقق لأن المورد خاص أو مقيد' : 'لم تثبت العضوية بعد انتهاء lease', operation.id]);
      if (!row) continue;
      await QueueManager.enqueueTelegramJoin({ operationId: row.id, userId: row.user_id, jobId: row.job_id, accountId: row.account_id, linkId: row.link_id, settings: {} }, { delay: 5000, jobId: `telegram-join-recovery-${row.id}-${row.recovery_count}` }).catch(() => {});
      await recordEvent({ userId: row.user_id, jobId: row.job_id, operationId: row.id, accountId: row.account_id, linkId: row.link_id, eventType: 'operation_recovered', status: 'RETRY', payload: { recoveryCount: row.recovery_count, verificationState: verification.state } }); recovered += 1;
    }
    return recovered;
  },
  async recoverDiscoveryJobs() {
    const stale = await queryAll(`SELECT id,user_id FROM telegram_discovery_jobs WHERE status='PROCESSING' AND lease_expires_at<NOW() LIMIT 50`); let recovered = 0;
    for (const job of stale) { const row = await queryOne(`UPDATE telegram_discovery_jobs SET status='RETRY',error='استعادة بعد انتهاء lease',lease_expires_at=NULL,heartbeat_at=NOW(),updated_at=NOW() WHERE id=$1 AND status='PROCESSING' RETURNING id`, [job.id]); if (row) { await QueueManager.enqueueTelegramDiscovery({ discoveryJobId: job.id, userId: job.user_id }, { delay: 5000, jobId: `telegram-discovery-recovery-${job.id}-${Date.now()}` }).catch(() => {}); await recordEvent({ userId: job.user_id, eventType: 'discovery_recovered', status: 'RETRY', payload: { discoveryJobId: job.id } }); recovered += 1; } }
    return recovered;
  },
  startBackgroundWorkers() {
    if (this._backgroundTimer) return;
    this._backgroundTimer = setInterval(() => { this.dispatchOutboxBatch().catch(() => {}); this.recoverStaleOperations().catch(() => {}); this.recoverDiscoveryJobs().catch(() => {}); }, 15000); this._backgroundTimer.unref?.();
    this.dispatchOutboxBatch().catch(() => {}); this.recoverStaleOperations().catch(() => {}); this.recoverDiscoveryJobs().catch(() => {});
  },
  stopBackgroundWorkers() { if (this._backgroundTimer) clearInterval(this._backgroundTimer); this._backgroundTimer = null; },

  async jobDashboard(userId, jobId, isAdmin = false) {
    const job = await queryOne(`SELECT * FROM telegram_automation_jobs WHERE id=$1 AND (${isAdmin ? 'TRUE' : 'user_id=$2'})`, isAdmin ? [jobId] : [jobId, userId]); if (!job) return null;
    const operations = await queryAll(`SELECT o.*,ta.name account_name,tal.normalized_url url FROM telegram_join_operations o JOIN telegram_accounts ta ON ta.id=o.account_id JOIN telegram_automation_links tal ON tal.id=o.link_id WHERE o.job_id=$1 AND (${isAdmin ? 'TRUE' : 'o.user_id=$2'}) ORDER BY o.created_at ASC`, isAdmin ? [jobId] : [jobId, userId]);
    const events = await queryAll(`SELECT * FROM telegram_automation_events WHERE job_id=$1 ORDER BY created_at DESC LIMIT 100`, [jobId]);
    const stats = await queryOne(`SELECT COUNT(*)::int total,COUNT(*) FILTER (WHERE status='SUCCESS')::int success,COUNT(*) FILTER (WHERE status='FAILED')::int failed,COUNT(*) FILTER (WHERE status='SKIPPED')::int skipped,COUNT(*) FILTER (WHERE status='RETRY')::int retry,COUNT(*) FILTER (WHERE status IN ('QUEUED','PROCESSING','RETRY'))::int pending FROM telegram_join_operations WHERE job_id=$1`, [jobId]);
    return { job, operations, events, stats, progress: Number(stats?.total || 0) ? Math.round(((Number(stats?.success || 0) + Number(stats?.failed || 0) + Number(stats?.skipped || 0)) / Number(stats.total)) * 100) : 0 };
  },

  async controlJob(userId, jobId, status, isAdmin = false, req) {
    if (!JOB_TRANSITIONS[status]) { const error = new Error('حالة المهمة غير صالحة'); error.code = 'JOB_INVALID_STATE'; throw error; }
    const idemKey = req?.get?.('idempotency-key') || req?.get?.('x-request-id'); const idempotency = await beginIdempotency(userId, `JOB_${status}`, idemKey); if (idempotency?.replay) return idempotency.response;
    const job = await queryOne(`SELECT * FROM telegram_automation_jobs WHERE id=$1 AND (${isAdmin ? 'TRUE' : 'user_id=$2'})`, isAdmin ? [jobId] : [jobId, userId]); if (!job) { const error = new Error('المهمة غير موجودة'); error.code = 'JOB_NOT_FOUND'; throw error; }
    if (job.status === status) { const response = await this.jobDashboard(userId, jobId, isAdmin); await completeIdempotency(idempotency, response); return response; }
    if (!JOB_TRANSITIONS[job.status]?.has(status)) { const error = new Error(`لا يمكن نقل المهمة من ${job.status} إلى ${status}`); error.code = 'JOB_INVALID_STATE'; throw error; }
    if (status === 'STOPPED') await query(`UPDATE telegram_join_operations SET status='SKIPPED',error_code='JOB_STOPPED',error_message='أوقف المستخدم المهمة قبل التنفيذ',lease_expires_at=NULL,heartbeat_at=NOW(),updated_at=NOW() WHERE job_id=$1 AND status IN ('QUEUED','RETRY')`, [jobId]);
    await query(`UPDATE telegram_automation_jobs SET status=$1::varchar(30),completed_at=CASE WHEN $1::text='STOPPED' THEN NOW() ELSE completed_at END,updated_at=NOW() WHERE id=$2`, [status, jobId]);
    await recordEvent({ userId, jobId, eventType: status === 'STOPPED' ? 'job_stopped' : status === 'PAUSED' ? 'job_paused' : 'job_resumed', status, payload: {} });
    await recordAudit({ actorId: userId, userId, action: `JOB_${status}`, entityType: 'telegram_automation_job', entityId: jobId, before: { status: job.status }, after: { status }, req });
    const response = await this.jobDashboard(userId, jobId, isAdmin); await completeIdempotency(idempotency, response); return response;
  },

  async archiveLink(userId, linkId, isAdmin = false, req) {
    const idemKey = req?.get?.('idempotency-key') || req?.get?.('x-request-id'); const idempotency = await beginIdempotency(userId, 'LINK_ARCHIVE', idemKey); if (idempotency?.replay) return idempotency.response;
    const result = await query(`UPDATE telegram_automation_links SET archived=true,status='ARCHIVED',join_status='SKIPPED',updated_at=NOW() WHERE id=$1 AND (${isAdmin ? 'TRUE' : 'user_id=$2'})`, isAdmin ? [linkId] : [linkId, userId]);
    if (!result.rowCount) { const error = new Error('الرابط غير موجود أو لا تملك صلاحية الوصول إليه'); error.code = 'LINK_NOT_FOUND'; throw error; }
    await recordAudit({ actorId: userId, userId, action: 'LINK_ARCHIVE', entityType: 'telegram_automation_link', entityId: linkId, after: { archived: true }, req });
    const response = { archived: true, linkId }; await completeIdempotency(idempotency, response); emit(userId, 'link_archived', { linkId }); return response;
  },

  async archiveAllLinks(userId, isAdmin = false, req) {
    const idemKey = req?.get?.('idempotency-key') || req?.get?.('x-request-id'); const idempotency = await beginIdempotency(userId, 'LINK_ARCHIVE_ALL', idemKey); if (idempotency?.replay) return idempotency.response;
    const response = await withTransaction(async client => {
      const links = await client.query(`UPDATE telegram_automation_links SET archived=true,status='ARCHIVED',join_status='SKIPPED',updated_at=NOW() WHERE archived=false AND (${isAdmin ? 'TRUE' : 'user_id=$1'}) RETURNING id`, isAdmin ? [] : [userId]);
      const linkIds = links.rows.map(row => row.id);
      if (linkIds.length) await client.query(`UPDATE telegram_join_operations SET status='SKIPPED',error_code='LINK_ARCHIVED',error_message='تم حذف الرابط قبل تنفيذ العملية',lease_expires_at=NULL,heartbeat_at=NOW(),updated_at=NOW() WHERE link_id=ANY($1::uuid[]) AND status IN ('QUEUED','RETRY','PROCESSING')`, [linkIds]);
      return { archived: true, count: linkIds.length };
    });
    await recordAudit({ actorId: userId, userId, action: 'LINK_ARCHIVE_ALL', entityType: 'telegram_automation_link', after: { archived: true, count: response.count }, req });
    await completeIdempotency(idempotency, response); emit(userId, 'links_archived_all', { count: response.count }); return response;
  },

  async report(userId, isAdmin = false) {
    const clause = isAdmin ? 'TRUE' : 'user_id=$1'; const params = isAdmin ? [] : [userId];
    const [summary, accounts, daily] = await Promise.all([
      queryOne(`SELECT COUNT(*) FILTER (WHERE archived=false)::int total,COUNT(*) FILTER (WHERE status='NEW' AND archived=false)::int new,COUNT(*) FILTER (WHERE join_status='JOINED' AND archived=false)::int joined,COUNT(*) FILTER (WHERE status='FAILED' AND archived=false)::int failed,COUNT(*) FILTER (WHERE status='PARTIALLY_JOINED' AND archived=false)::int partial FROM telegram_automation_links WHERE ${clause}`, params),
      queryAll(`SELECT ta.id,ta.name,ta.automation_role,ta.status,ta.worker_state,ta.connection_state,ta.operation_count,ta.error_count,COUNT(o.id)::int operations,COUNT(o.id) FILTER (WHERE o.status='SUCCESS')::int successful FROM telegram_accounts ta LEFT JOIN telegram_join_operations o ON o.account_id=ta.id WHERE ${isAdmin ? 'TRUE' : 'ta.user_id=$1'} GROUP BY ta.id ORDER BY operations DESC`, params),
      queryAll(`SELECT TO_CHAR(DATE_TRUNC('day',created_at),'YYYY-MM-DD') day,COUNT(*)::int total,COUNT(*) FILTER (WHERE status='SUCCESS')::int successful,COUNT(*) FILTER (WHERE status='FAILED')::int failed,COUNT(*) FILTER (WHERE status='RETRY')::int retry FROM telegram_join_operations WHERE ${clause} GROUP BY 1 ORDER BY 1 DESC LIMIT 31`, params),
    ]); return { generatedAt: new Date().toISOString(), summary: summary || {}, accounts, daily };
  },

  async exportData({ userId, isAdmin = false, entity = 'links', format = 'json', req }) {
    const clause = isAdmin ? 'TRUE' : 'user_id=$1'; const params = isAdmin ? [] : [userId];
    const tables = { links: 'telegram_automation_links', operations: 'telegram_join_operations', jobs: 'telegram_automation_jobs', events: 'telegram_automation_events' }; const table = tables[entity] || tables.links;
    const rows = await queryAll(`SELECT * FROM ${table} WHERE ${clause} ORDER BY created_at DESC LIMIT 10000`, params);
    if (format === 'csv') { const keys = rows.length ? Object.keys(rows[0]).filter(key => !/session|token|secret|password|api_hash/i.test(key)) : []; const csv = [keys.join(','), ...rows.map(row => keys.map(key => JSON.stringify(row[key] ?? '')).join(','))].join('\n'); const response = { format: 'csv', content: csv, filename: `telegram-${entity}.csv` }; await recordAudit({ actorId: userId, userId, action: 'EXPORT', entityType: `telegram_${entity}`, after: { format, count: rows.length }, req }); return response; }
    const response = { format: 'json', content: JSON.stringify(rows.map(safePayload), null, 2), filename: `telegram-${entity}.json` }; await recordAudit({ actorId: userId, userId, action: 'EXPORT', entityType: `telegram_${entity}`, after: { format, count: rows.length }, req }); return response;
  },
};

module.exports = Service;
