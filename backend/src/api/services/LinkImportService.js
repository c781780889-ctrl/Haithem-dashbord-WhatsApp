'use strict';

const AdmZip = require('adm-zip');
const XLSX = require('xlsx');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { randomUUID } = require('crypto');
const { query, queryOne, queryAll, getClient, withTransaction, withAdvisoryLock } = require('../../lib/postgres');
const { getRedis } = require('../../lib/redis');
const QueueManager = require('../../lib/QueueManager');
const SocketBridge = require('../../core/SocketBridge');
function getDatabaseManager() { return require('../../database/DatabaseManager'); }
function getBroadcastController() { return require('../controllers/BroadcastController'); }
function getGroupJoinerService() { return require('./GroupJoinerService'); }
function getWhatsAppManager() { return require('../../bot/WhatsAppManager'); }
const LinkUrlProcessingService = require('./LinkUrlProcessingService');
const JoinScheduler = require('./JoinScheduler');
const JoinCyclePolicy = require('./JoinCyclePolicy');
const { DEFAULT_CYCLE_LIMIT, DEFAULT_CYCLE_DURATION_MINUTES } = JoinCyclePolicy;
const { metrics } = require('../middleware/MetricsMiddleware');

const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_XML_BYTES = 40 * 1024 * 1024;
const MAX_PREVIEW_ITEMS = 2000;
const ACCOUNT_LOCK_TTL_MS = 120000;
const MAX_WAIT_SECONDS = 86400;
const fallbackLocks = new Map();
const RECOVERY_INTERVAL_MS = 30000;
const recoveryGuards = new Map();
let recoveryTimer = null;

function userRoom(userId) { return `user:${userId}`; }
function emit(userId, event, payload) { SocketBridge.to(userRoom(userId)).emit(event, payload); }
function nowIso() { return new Date().toISOString(); }
function parseJSON(value, fallback) {
  if (value === null || value === undefined) return fallback;
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch { return fallback; }
}
function clampSeconds(value, fallback = 0) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(0, Math.min(MAX_WAIT_SECONDS, Math.round(number)));
}

function withTimeout(promise, timeoutMs, message) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error(message), { code: 'JOIN_EXECUTION_TIMEOUT', retryable: true })), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function withOperationHeartbeat(operationId, promise) {
  const heartbeat = setInterval(() => {
    query(`UPDATE link_import_operations SET heartbeat_at=NOW(),lease_expires_at=NOW()+INTERVAL '2 minutes',updated_at=NOW() WHERE id=$1 AND status='processing'`, [operationId]).catch(() => {});
  }, 30000);
  heartbeat.unref?.();
  try { return await promise; } finally { clearInterval(heartbeat); }
}
function decodeXml(value) {
  return String(value || '')
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'");
}

function cleanXmlText(xml) {
  return decodeXml(String(xml || ''))
    .replace(/<w:tab\s*\/?\s*>/gi, ' ')
    .replace(/<w:br\s*\/?\s*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/[ \t]+/g, ' ');
}

function xmlAttribute(tag, attribute) {
  const match = String(tag || '').match(new RegExp(`${attribute}\\s*=\\s*["']([^"']+)["']`, 'i'));
  return match ? decodeXml(match[1]) : '';
}

function extractDocxLinks(buffer) {
  const zip = new AdmZip(buffer);
  const entries = zip.getEntries();
  const contentEntries = entries.filter(entry => /^word\/(document|header\d+|footer\d+|footnotes|endnotes)\.xml$/i.test(entry.entryName));
  const relationshipEntries = entries.filter(entry => /^word\/(?:_rels\/[^/]+\.rels|document\.xml\.rels)$/i.test(entry.entryName));
  let totalXmlBytes = 0;
  const textParts = [];
  for (const entry of contentEntries) {
    const data = entry.getData();
    totalXmlBytes += data.length;
    if (totalXmlBytes > MAX_XML_BYTES) throw new Error('محتوى Word غير آمن أو يتجاوز الحد المسموح');
    const xml = data.toString('utf8');
    textParts.push(cleanXmlText(xml));
    for (const match of xml.matchAll(/<w:hyperlink\b[^>]*>([\s\S]*?)<\/w:hyperlink>/gi)) textParts.push(cleanXmlText(match[1]));
  }
  for (const entry of relationshipEntries) {
    const data = entry.getData();
    totalXmlBytes += data.length;
    if (totalXmlBytes > MAX_XML_BYTES) throw new Error('محتوى Word غير آمن أو يتجاوز الحد المسموح');
    const xml = data.toString('utf8');
    for (const match of xml.matchAll(/<Relationship\b[^>]*>/gi)) {
      const target = xmlAttribute(match[0], 'Target');
      if (/^https?:\/\//i.test(target)) textParts.push(target);
    }
  }
  return textParts.flatMap(part => part.match(/https?:\/\/[^\s<>()\[\]{}"'«»]+/gi) || []);
}

function parseLegacyDoc(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) throw new Error('الملف فارغ');
  if (buffer.length > MAX_FILE_BYTES) throw new Error('حجم الملف يتجاوز الحد المسموح 10MB');
  const isOleDocument = buffer.length >= 8 && Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]).equals(buffer.subarray(0, 8));
  const temporaryPath = path.join(os.tmpdir(), `whatsapp-link-import-${randomUUID()}.doc`);
  try {
    fs.writeFileSync(temporaryPath, buffer, { mode: 0o600 });
    const text = execFileSync('antiword', [temporaryPath], { maxBuffer: MAX_XML_BYTES, stdio: ['ignore', 'pipe', 'pipe'] }).toString('utf8');
    return text.match(/https?:\/\/[^\s<>()\[\]{}"'«»]+/gi) || [];
  } catch (error) {
    if (error.code === 'ENOENT' && isOleDocument) {
      const fallbackText = `${buffer.toString('latin1')} ${buffer.toString('utf16le')}`;
      return fallbackText.match(/https?:\/\/[^\s<>()\[\]{}"'«»]+/gi) || [];
    }
    throw new Error(`تعذر قراءة ملف Word القديم .doc: ${error.message}`);
  } finally {
    try { fs.unlinkSync(temporaryPath); } catch (_) {}
  }
}

function parseDocx(buffer, filename) {
  if (!/\.docx$/i.test(filename || '')) throw new Error('الصيغة ليست DOCX');
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) throw new Error('الملف فارغ');
  if (buffer.length > MAX_FILE_BYTES) throw new Error('حجم الملف يتجاوز الحد المسموح 10MB');
  if (buffer.length < 4 || buffer[0] !== 0x50 || buffer[1] !== 0x4b) throw new Error('الملف ليس حاوية DOCX صالحة');
  try { return extractDocxLinks(buffer); } catch (error) { throw new Error(`تعذر قراءة ملف Word: ${error.message}`); }
}

function parseText(buffer) {
  return [buffer.toString('utf8')];
}

function parseCsv(buffer) {
  return buffer.toString('utf8').split(/\r?\n/).flatMap(line => line.split(/[;,\t]/));
}

function parseJsonLinks(buffer) {
  let parsed;
  try { parsed = JSON.parse(buffer.toString('utf8')); } catch { throw new Error('ملف JSON غير صالح'); }
  const values = Array.isArray(parsed) ? parsed : (Array.isArray(parsed?.links) ? parsed.links : []);
  return values.map(item => typeof item === 'string' ? item : item?.url || item?.link || item?.whatsapp_link || '');
}

function parseXlsx(buffer) {
  let workbook;
  try {
    workbook = XLSX.read(buffer, { type: 'buffer', cellDates: false });
  } catch (error) {
    throw new Error(`تعذر قراءة ملف Excel: ${error.message}`);
  }
  return workbook.SheetNames.flatMap(sheetName => {
    const rows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { header: 1, raw: false, defval: '' });
    return rows.flat().map(value => String(value || ''));
  });
}

function parseImportFile(buffer, filename) {
  const name = String(filename || '').toLowerCase();
  if (/\.docx$/.test(name)) return parseDocx(buffer, filename);
  if (/\.doc$/.test(name)) return parseLegacyDoc(buffer);
  if (/\.txt$/.test(name)) {
    if (buffer.length > MAX_FILE_BYTES) throw new Error('حجم الملف يتجاوز الحد المسموح 10MB');
    return parseText(buffer);
  }
  if (/\.csv$/.test(name)) {
    if (buffer.length > MAX_FILE_BYTES) throw new Error('حجم الملف يتجاوز الحد المسموح 10MB');
    return parseCsv(buffer);
  }
  if (/\.json$/.test(name)) {
    if (buffer.length > MAX_FILE_BYTES) throw new Error('حجم الملف يتجاوز الحد المسموح 10MB');
    return parseJsonLinks(buffer);
  }
  if (/\.xlsx$/.test(name)) {
    if (buffer.length > MAX_FILE_BYTES) throw new Error('حجم الملف يتجاوز الحد المسموح 10MB');
    return parseXlsx(buffer);
  }
  throw new Error('صيغة الملف غير مدعومة. استخدم .doc أو .docx أو .txt أو .csv أو .json أو .xlsx');
}

function parseImportedLinks(rawLinks) {
  const parsed = LinkUrlProcessingService.parseMany(rawLinks);
  const duplicateInFile = Math.max(0, rawLinks.length - parsed.length);
  const valid = parsed.filter(item => item.ok);
  const review = parsed.filter(item => !item.ok && item.code === 'UNSUPPORTED_LINK');
  const invalid = parsed.filter(item => !item.ok && item.code !== 'UNSUPPORTED_LINK');
  return { parsed, valid, review, invalid, duplicateInFile };
}

function prepareImport({ filename, contentBase64 }) {
  const safeFilename = String(filename || '').trim();
  if (!safeFilename) throw new Error('اسم الملف مطلوب');
  const buffer = Buffer.from(String(contentBase64 || ''), 'base64');
  if (!buffer.length) throw new Error('الملف فارغ');
  const rawLinks = parseImportFile(buffer, safeFilename);
  return { filename: safeFilename, buffer, rawLinks, parsed: parseImportedLinks(rawLinks) };
}

function previewItem(item, existingSet) {
  if (!item.ok) return {
    originalUrl: item.originalUrl || '',
    normalizedUrl: null,
    status: item.code === 'UNSUPPORTED_LINK' ? 'unsupported' : 'invalid',
    reason: item.reason || 'الرابط غير صالح',
  };
  return {
    originalUrl: item.originalUrl || item.canonicalUrl,
    normalizedUrl: item.canonicalUrl,
    status: existingSet.has(item.canonicalUrl) ? 'existing' : 'new',
    reason: existingSet.has(item.canonicalUrl) ? 'موجود مسبقًا في النظام' : 'رابط جديد صالح',
  };
}

async function getExistingCanonicalSet(userId, canonicalUrls) {
  if (!canonicalUrls.length) return new Set();
  const [importedRows, dashboardRows] = await Promise.all([
    queryAll(`SELECT canonical_url FROM link_import_links WHERE user_id=$1 AND canonical_url=ANY($2::text[])`, [userId, canonicalUrls]),
    queryAll(`SELECT whatsapp_link AS canonical_url FROM whatsapp_links WHERE whatsapp_link=ANY($1::text[])`, [canonicalUrls]),
  ]);
  return new Set([...importedRows, ...dashboardRows].map(row => row.canonical_url));
}

async function buildImportPreview(userId, prepared) {
  const canonicalUrls = prepared.parsed.valid.map(item => item.canonicalUrl);
  const existingSet = await getExistingCanonicalSet(userId, canonicalUrls);
  const allItems = prepared.parsed.parsed.map(item => previewItem(item, existingSet));
  const newCount = allItems.filter(item => item.status === 'new').length;
  const existingCount = allItems.filter(item => item.status === 'existing').length;
  return {
    filename: prepared.filename,
    fileSizeBytes: prepared.buffer.length,
    total: prepared.rawLinks.length,
    uniqueCount: prepared.parsed.parsed.length,
    duplicateInFile: prepared.parsed.duplicateInFile,
    existingCount,
    invalidCount: prepared.parsed.invalid.length,
    reviewCount: prepared.parsed.review.length,
    newCount,
    items: allItems.slice(0, MAX_PREVIEW_ITEMS),
    previewTruncated: allItems.length > MAX_PREVIEW_ITEMS,
  };
}

async function previewFile({ userId, filename, contentBase64 }) {
  if (!userId) throw new Error('المستخدم غير معروف');
  const prepared = prepareImport({ filename, contentBase64 });
  return { status: 'preview', ...(await buildImportPreview(userId, prepared)) };
}

async function resolveAdPayloads(accountId, adIds) {
  const ids = [...new Set((adIds || []).map(String).filter(Boolean))];
  if (!ids.length) return [];
  const accountDB = await getDatabaseManager().getAccountDB(accountId);
  const ads = [];
  for (const id of ids) {
    const ad = await accountDB.get(`SELECT id,name,content,media_paths,is_active FROM ad_library WHERE id = $1`, [id]);
    if (ad) ads.push(ad);
  }
  const byId = new Map(ads.map(ad => [String(ad.id), ad]));
  const missing = ids.filter(id => !byId.has(id));
  if (missing.length) throw new Error('يوجد إعلان غير موجود في مكتبة الحساب المحدد');
  const inactive = ids.filter(id => !Boolean(byId.get(id).is_active));
  if (inactive.length) throw new Error('فعّل الإعلانات المحددة من مكتبة الإعلانات قبل بدء العملية');
  return ids.map(id => {
    const ad = byId.get(id);
    return {
      id: String(ad.id),
      name: ad.name || `إعلان ${String(ad.id).slice(0, 8)}`,
      content: ad.content || '',
      media_paths: parseJSON(ad.media_paths, []),
    };
  });
}

async function acquireAccountLock(accountId) {
  const key = `wa:link-import:account:${accountId}`;
  try {
    const redis = getRedis();
    const acquired = await redis.set(key, process.pid.toString(), 'PX', ACCOUNT_LOCK_TTL_MS, 'NX');
    if (acquired === 'OK') return { release: async () => { try { await redis.del(key); } catch (_) {} } };
    return null;
  } catch (_) {
    const current = fallbackLocks.get(accountId);
    if (current && current > Date.now()) return null;
    fallbackLocks.set(accountId, Date.now() + ACCOUNT_LOCK_TTL_MS);
    return { release: async () => fallbackLocks.delete(accountId) };
  }
}

async function getAccountGuard(accountId) {
  try {
    return await queryOne(`
      SELECT a.id,a.status,a.health_status,a.task_status,
             COALESCE(g.circuit_state,'CLOSED') AS circuit_state,g.reason_code,g.reason
        FROM accounts a
        LEFT JOIN link_import_account_guards g ON g.account_id=a.id
       WHERE a.id=$1
    `, [accountId]);
  } catch (_) {
    return queryOne(`SELECT id,status,health_status,task_status,'CLOSED'::varchar AS circuit_state,NULL::varchar AS reason_code,NULL::text AS reason FROM accounts WHERE id=$1`, [accountId]).catch(() => null);
  }
}

function accountIsBlocked(account) {
  return !account || account.status === 'banned' || account.task_status === 'stopped'
    || ['blocked','protected'].includes(account.health_status)
    || account.circuit_state === 'OPEN';
}

async function assertAccountCanSchedule(accountId) {
  const account = await getAccountGuard(accountId);
  if (accountIsBlocked(account)) return { ok: false, account };
  return { ok: true, account };
}

async function requestReschedule({ operationId, accountId = null, taskId = null, linkId = null, delaySeconds = 0, reason = 'scheduler', eventType = 'operation_deferred', status = null, jobId = null }) {
  const operation = await queryOne(`
    SELECT o.id operation_id,o.task_id,o.user_id,o.account_id,o.link_id,o.status,o.current_stage,o.idempotency_key,
           t.queue_priority
      FROM link_import_operations o
      JOIN link_import_tasks t ON t.id=o.task_id
     WHERE o.id=$1
  `, [operationId]);
  if (!operation || ['success','failed','skipped','review'].includes(operation.status)) return null;
  const guard = await assertAccountCanSchedule(accountId || operation.account_id);
  if (!guard.ok) {
    await query(`UPDATE link_import_outbox SET status='CANCELLED',updated_at=NOW() WHERE aggregate_type='operation' AND aggregate_id=$1 AND status IN ('PENDING','PROCESSING')`, [operationId]).catch(() => {});
    await recordEvent({ userId: operation.user_id, taskId: operation.task_id, operationId, accountId: accountId || operation.account_id, linkId: linkId || operation.link_id, eventType: 'reschedule_blocked', payload: { reason, circuitState: guard.account?.circuit_state || null, accountStatus: guard.account?.status || null } }).catch(() => {});
    return null;
  }
  const safeDelaySeconds = Math.max(0, Math.min(MAX_WAIT_SECONDS, Math.ceil(Number(delaySeconds) || 0)));
  metrics.recordJoinDeferred(accountId || operation.account_id, reason || 'unknown');
  const scheduledAt = new Date(Date.now() + safeDelaySeconds * 1000);
  const update = await queryOne(`
    UPDATE link_import_operations
       SET scheduled_at=$1,next_run_at=$1,reschedule_count=COALESCE(reschedule_count,0)+1,updated_at=NOW()
     WHERE id=$2 AND status IN ('pending','retry','paused','processing')
     RETURNING id,reschedule_count
  `, [scheduledAt, operationId]);
  if (!update) return null;
  if (Number(update.reschedule_count || 0) > 100) {
    const churnReason = 'تم إيقاف العملية تلقائيًا بعد تجاوز حد إعادة الجدولة (Queue churn)';
    await query(`UPDATE accounts SET health_status='protected',task_status='stopped',updated_at=NOW() WHERE id=$1`, [accountId || operation.account_id]).catch(() => {});
    await query(`INSERT INTO link_import_account_guards(account_id,circuit_state,reason_code,reason,opened_at,last_signal_at,updated_at) VALUES($1,'OPEN','QUEUE_CHURN', $2,NOW(),NOW(),NOW()) ON CONFLICT(account_id) DO UPDATE SET circuit_state='OPEN',reason_code='QUEUE_CHURN',reason=EXCLUDED.reason,opened_at=COALESCE(link_import_account_guards.opened_at,NOW()),last_signal_at=NOW(),updated_at=NOW()`, [accountId || operation.account_id, churnReason]).catch(() => {});
    await query(`UPDATE link_import_operations SET status='review',current_stage='failed',last_error=$1,error_code='QUEUE_CHURN',completed_at=NOW(),next_run_at=NULL,lease_expires_at=NULL,updated_at=NOW() WHERE id=$2 AND status NOT IN ('success','failed','skipped','review')`, [churnReason, operationId]);
    await recordEvent({ userId: operation.user_id, taskId: operation.task_id, operationId, accountId: accountId || operation.account_id, linkId: linkId || operation.link_id, eventType: 'account_protected', payload: { reason: 'QUEUE_CHURN', rescheduleCount: Number(update.reschedule_count || 0) } }).catch(() => {});
    await stopAccountOperations(accountId || operation.account_id, churnReason).catch(() => {});
    return null;
  }
  const baseJobId = jobId || `link-import-op-${operationId}`;
  const workerDeferral = ['lock_deferred','pacing_deferred','retry_scheduled','wait_scheduled'].includes(eventType) || reason === 'advisory_lock' || reason === 'min_interval_between_account_joins' || reason.startsWith('wait_after_');
  const stableJobId = workerDeferral ? `${baseJobId}-future` : baseJobId;
  const outbox = await queryOne(`
    INSERT INTO link_import_outbox(user_id,aggregate_type,aggregate_id,event_type,payload,available_at,status,updated_at)
    VALUES($1,'operation',$2,'enqueue_operation',$3::jsonb,$4,'PENDING',NOW())
    ON CONFLICT(aggregate_type,aggregate_id,event_type)
    DO UPDATE SET payload=EXCLUDED.payload,available_at=EXCLUDED.available_at,status='PENDING',last_error=NULL,updated_at=NOW()
      WHERE link_import_outbox.status <> 'PROCESSING'
    RETURNING id
  `, [operation.user_id, operationId, JSON.stringify({ operationId, accountId: accountId || operation.account_id, linkId: linkId || operation.link_id, taskId: taskId || operation.task_id, delaySeconds: safeDelaySeconds, priority: Number(operation.queue_priority || 5), jobId: stableJobId }), scheduledAt]);
  await recordEvent({ userId: operation.user_id, taskId: taskId || operation.task_id, operationId, accountId: accountId || operation.account_id, linkId: linkId || operation.link_id, eventType, payload: { reason, delaySeconds: safeDelaySeconds, nextRunAt: scheduledAt.toISOString(), jobId: stableJobId } }).catch(() => {});
  if (outbox?.id) await dispatchOutbox(outbox.id);
  return { operationId, scheduledAt, delaySeconds: safeDelaySeconds, jobId: stableJobId };
}

async function recordEvent({ userId, taskId, operationId = null, accountId = null, linkId = null, eventType, payload = {} }) {
  const safePayload = payload && typeof payload === 'object' ? payload : {};
  const reason = safePayload.reason || safePayload.error || safePayload.errorCode || null;
  const nextRunAt = safePayload.nextRunAt || safePayload.next_run_at || null;
  const jobId = safePayload.jobId || safePayload.job_id || null;
  const workerId = safePayload.workerId || safePayload.worker_id || null;
  await query(`INSERT INTO link_import_events (user_id,task_id,operation_id,account_id,link_id,event_type,payload,reason,next_run_at,job_id,worker_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`, [userId, taskId, operationId, accountId, linkId, eventType, JSON.stringify(safePayload), reason, nextRunAt, jobId, workerId]).catch(() => {});
  emit(userId, 'link_import:event', { eventType, taskId, operationId, accountId, linkId, payload: safePayload, createdAt: nowIso() });
}

function redactAuditValue(value) {
  if (!value || typeof value !== 'object') return value;
  const copy = Array.isArray(value) ? [...value] : { ...value };
  for (const key of Object.keys(copy)) if (/session|token|secret|api.?hash|credential|password/i.test(key)) delete copy[key];
  return copy;
}

async function recordAudit({ actorId, action, entityType, entityId = null, before = {}, after = {}, ip = null, userAgent = null }) {
  if (!actorId) return;
  const beforeState = redactAuditValue(before) || {};
  const afterState = redactAuditValue(after) || {};
  const entry = await queryOne(`INSERT INTO link_import_audit_logs(actor_id,action,entity_type,entity_id,before_state,after_state,ip,user_agent) VALUES($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7,$8) RETURNING id,actor_id,action,entity_type,entity_id,before_state,after_state,ip,user_agent,created_at`, [actorId, action, entityType, entityId, JSON.stringify(beforeState), JSON.stringify(afterState), ip, userAgent]).catch(() => null);
  if (entry) emit(actorId, 'whatsapp:audit_log_created', { ...entry, before_state: parseJSON(entry.before_state, {}), after_state: parseJSON(entry.after_state, {}) });
  return entry;
}

function buildAuditFilter({ userId, isAdmin = false, action, entityType, from, to, search }, startAt = 1) {
  const clauses = [];
  const params = [];
  if (!isAdmin) { clauses.push(`a.actor_id=$${startAt + params.length}`); params.push(userId); }
  if (action && action !== 'all') { clauses.push(`a.action=$${startAt + params.length}`); params.push(String(action).slice(0, 60)); }
  if (entityType && entityType !== 'all') { clauses.push(`a.entity_type=$${startAt + params.length}`); params.push(String(entityType).slice(0, 40)); }
  if (from) { clauses.push(`a.created_at >= $${startAt + params.length}::timestamptz`); params.push(from); }
  if (to) { clauses.push(`a.created_at <= $${startAt + params.length}::timestamptz`); params.push(to); }
  if (search) { clauses.push(`(a.action ILIKE $${startAt + params.length} OR a.entity_type ILIKE $${startAt + params.length} OR COALESCE(a.entity_id,'') ILIKE $${startAt + params.length} OR COALESCE(u.username,'') ILIKE $${startAt + params.length} OR a.after_state::text ILIKE $${startAt + params.length})`); params.push(`%${String(search).slice(0, 120)}%`); }
  return { where: clauses.length ? clauses.join(' AND ') : 'TRUE', params };
}

async function listAuditLogs({ userId, isAdmin = false, page = 1, pageSize = 50, action = 'all', entityType = 'all', from = null, to = null, search = '' }) {
  const safePage = Math.max(1, Math.floor(Number(page) || 1));
  const safePageSize = Math.min(200, Math.max(10, Math.floor(Number(pageSize) || 50)));
  const filter = buildAuditFilter({ userId, isAdmin, action, entityType, from, to, search });
  const offset = (safePage - 1) * safePageSize;
  const [rows, count] = await Promise.all([
    queryAll(`SELECT a.id,a.actor_id,a.action,a.entity_type,a.entity_id,a.before_state,a.after_state,a.ip,a.user_agent,a.created_at,COALESCE(u.username,'مستخدم محذوف') actor_username FROM link_import_audit_logs a LEFT JOIN users u ON u.id=a.actor_id WHERE ${filter.where} ORDER BY a.created_at DESC,a.id DESC LIMIT $${filter.params.length + 1} OFFSET $${filter.params.length + 2}`, [...filter.params, safePageSize, offset]),
    queryOne(`SELECT COUNT(*)::int total FROM link_import_audit_logs a LEFT JOIN users u ON u.id=a.actor_id WHERE ${filter.where}`, filter.params),
  ]);
  return { items: rows.map(row => ({ ...row, before_state: parseJSON(row.before_state, {}), after_state: parseJSON(row.after_state, {}) })), page: safePage, pageSize: safePageSize, total: Number(count?.total || 0), totalPages: Math.max(1, Math.ceil(Number(count?.total || 0) / safePageSize)) };
}

async function auditStats({ userId, isAdmin = false, action = 'all', entityType = 'all', from = null, to = null, search = '' }) {
  const filter = buildAuditFilter({ userId, isAdmin, action, entityType, from, to, search });
  const [summary, byAction, byEntity, byDay] = await Promise.all([
    queryOne(`SELECT COUNT(*)::int total,COUNT(*) FILTER (WHERE a.created_at>=NOW()-INTERVAL '24 hours')::int last24h,COUNT(*) FILTER (WHERE a.created_at>=NOW()-INTERVAL '7 days')::int last7d,COUNT(DISTINCT a.actor_id)::int actors,MAX(a.created_at) last_event_at FROM link_import_audit_logs a LEFT JOIN users u ON u.id=a.actor_id WHERE ${filter.where}`, filter.params),
    queryAll(`SELECT a.action,COUNT(*)::int count FROM link_import_audit_logs a LEFT JOIN users u ON u.id=a.actor_id WHERE ${filter.where} GROUP BY a.action ORDER BY count DESC,a.action`, filter.params),
    queryAll(`SELECT a.entity_type,COUNT(*)::int count FROM link_import_audit_logs a LEFT JOIN users u ON u.id=a.actor_id WHERE ${filter.where} GROUP BY a.entity_type ORDER BY count DESC,a.entity_type`, filter.params),
    queryAll(`SELECT TO_CHAR(DATE_TRUNC('day',a.created_at),'YYYY-MM-DD') day,COUNT(*)::int count FROM link_import_audit_logs a LEFT JOIN users u ON u.id=a.actor_id WHERE ${filter.where} GROUP BY 1 ORDER BY 1 DESC LIMIT 14`, filter.params),
  ]);
  return { total: Number(summary?.total || 0), last24h: Number(summary?.last24h || 0), last7d: Number(summary?.last7d || 0), actors: Number(summary?.actors || 0), lastEventAt: summary?.last_event_at || null, byAction, byEntity, byDay: byDay.reverse() };
}

async function getAuditLog(userId, auditId, isAdmin = false) {
  const filter = buildAuditFilter({ userId, isAdmin });
  const row = await queryOne(`SELECT a.id,a.actor_id,a.action,a.entity_type,a.entity_id,a.before_state,a.after_state,a.ip,a.user_agent,a.created_at,COALESCE(u.username,'مستخدم محذوف') actor_username FROM link_import_audit_logs a LEFT JOIN users u ON u.id=a.actor_id WHERE a.id=$${filter.params.length + 1} AND ${filter.where}`, [...filter.params, auditId]);
  if (!row) return null;
  return { ...row, before_state: parseJSON(row.before_state, {}), after_state: parseJSON(row.after_state, {}) };
}

async function saveImport({ userId, filename, contentBase64, requestId = null }) {
  const started = Date.now();
  if (!userId) throw new Error('المستخدم غير معروف');
  const stableRequestId = String(requestId || '').trim().slice(0, 255) || null;
  if (stableRequestId) {
    const existing = await queryOne(`SELECT id,filename,file_size_bytes,total_found,new_count,duplicate_count,invalid_count,review_count,processing_ms,status,created_at FROM link_import_sources WHERE user_id=$1 AND request_id=$2`, [userId, stableRequestId]);
    if (existing) return { sourceId: existing.id, ...existing, idempotent: true };
  }
  const prepared = prepareImport({ filename, contentBase64 });
  const existingSet = await getExistingCanonicalSet(userId, prepared.parsed.valid.map(item => item.canonicalUrl));
  const client = await getClient();
  let source;
  let committed = false;
  try {
    await client.query('BEGIN');
    source = (await client.query(`INSERT INTO link_import_sources (user_id,filename,file_size_bytes,total_found,duplicate_count,invalid_count,review_count,status,request_id) VALUES ($1,$2,$3,$4,$5,$6,$7,'processing',$8) RETURNING id`, [userId, prepared.filename, prepared.buffer.length, prepared.rawLinks.length, prepared.parsed.duplicateInFile, prepared.parsed.invalid.length, prepared.parsed.review.length, stableRequestId])).rows[0];
    let newCount = 0;
    let existingCount = 0;
    for (const item of prepared.parsed.valid) {
      const row = await client.query(`INSERT INTO link_import_links (id,user_id,source_id,url,canonical_url,invite_code,validation_status) VALUES ($1,$2,$3,$4,$5,$6,'valid') ON CONFLICT (user_id,canonical_url) DO NOTHING`, [randomUUID(), userId, source.id, item.originalUrl, item.canonicalUrl, item.inviteCode]);
      if (existingSet.has(item.canonicalUrl) || !row.rowCount) existingCount++; else newCount++;
      await client.query(`INSERT INTO whatsapp_links (id,whatsapp_link,source_account_id,source_account_name,source_group,source_history,discovered_by_account_ids,discovered_at,last_seen,duplicate_count,status,processing_status,joined,copied,deleted,import_user_id) VALUES ($1,$2,NULL,'استيراد يدوي', $3, $4::jsonb, '[]'::jsonb, NOW(), NOW(), 0, 'new', 'new', false, false, false, $5) ON CONFLICT (whatsapp_link) DO NOTHING`, [randomUUID(), item.canonicalUrl, `Word: ${prepared.filename}`, JSON.stringify([{ accountId: null, accountName: 'استيراد يدوي', group: `Word: ${prepared.filename}`, seenAt: nowIso() }]), userId]);
    }
    await client.query(`UPDATE link_import_links lil SET discovered_link_id=wl.id,updated_at=NOW() FROM whatsapp_links wl WHERE lil.source_id=$1 AND lil.user_id=$2 AND lil.canonical_url=wl.whatsapp_link`, [source.id, userId]);
    const processingMs = Date.now() - started;
    await client.query(`UPDATE link_import_sources SET new_count=$1,duplicate_count=$2,processing_ms=$3,status='completed' WHERE id=$4`, [newCount, existingCount + prepared.parsed.duplicateInFile, processingMs, source.id]);
    await client.query('COMMIT');
    committed = true;
    const summary = { sourceId: source.id, filename: prepared.filename, fileSizeBytes: prepared.buffer.length, total: prepared.rawLinks.length, uniqueCount: prepared.parsed.parsed.length, newCount, duplicateInFile: prepared.parsed.duplicateInFile, existingCount, duplicateCount: existingCount + prepared.parsed.duplicateInFile, invalidCount: prepared.parsed.invalid.length, reviewCount: prepared.parsed.review.length, validCount: prepared.parsed.valid.length, processingMs, status: 'completed' };
    emit(userId, 'link_import:source_completed', summary);
    return summary;
  } catch (error) {
    if (!committed) await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function importFile(args) { return saveImport(args); }

async function listImportSources(userId, limit = 50) {
  return queryAll(`SELECT id,filename,file_size_bytes,total_found,new_count,duplicate_count,invalid_count,review_count,processing_ms,status,created_at FROM link_import_sources WHERE user_id=$1 ORDER BY created_at DESC LIMIT $2`, [userId, Math.min(100, Math.max(1, Number(limit) || 50))]);
}

async function syncImportedLinksToDashboard(userId) {
  if (!userId) return 0;
  const pending = await queryAll(`
    SELECT l.id,l.user_id,l.canonical_url,l.url,s.filename,s.created_at
      FROM link_import_links l
      LEFT JOIN link_import_sources s ON s.id=l.source_id
     WHERE l.user_id=$1 AND l.discovered_link_id IS NULL
     ORDER BY l.created_at ASC
  `, [userId]);
  let synced = 0;
  for (const item of pending) {
    const sourceGroup = `Word: ${item.filename || 'ملف مستورد'}`;
    const row = await queryOne(`
      INSERT INTO whatsapp_links
        (id,whatsapp_link,source_account_name,source_group,source_history,discovered_by_account_ids,discovered_at,last_seen,duplicate_count,status,processing_status,joined,copied,deleted,import_user_id)
      VALUES ($1,$2,'استيراد يدوي',$3,$4::jsonb,'[]'::jsonb,COALESCE($5,NOW()),COALESCE($5,NOW()),0,'new','new',false,false,false,$6)
      ON CONFLICT (whatsapp_link) DO UPDATE SET import_user_id=COALESCE(whatsapp_links.import_user_id,EXCLUDED.import_user_id),updated_at=NOW()
      RETURNING id
    `, [randomUUID(), item.canonical_url, sourceGroup, JSON.stringify([{ accountId: null, accountName: 'استيراد يدوي', group: sourceGroup, seenAt: nowIso() }]), item.created_at, userId]);
    if (row?.id) {
      await query(`UPDATE link_import_links SET discovered_link_id=$1,updated_at=NOW() WHERE id=$2 AND user_id=$3`, [row.id, item.id, userId]);
      synced++;
    }
  }
  return synced;
}

async function importDocx(args) { return importFile(args); }

async function listLinks(userId, queryParams = {}) {
  const search = String(queryParams.search || '').trim();
  const status = String(queryParams.status || '').trim();
  const params = [userId]; const conditions = ['l.user_id=$1'];
  if (search) { params.push(`%${search}%`); conditions.push(`l.canonical_url ILIKE $${params.length}`); }
  if (status) { params.push(status); conditions.push(`COALESCE(l.last_status,'pending')=$${params.length}`); }
  return queryAll(`SELECT l.*, s.filename source_filename FROM link_import_links l LEFT JOIN link_import_sources s ON s.id=l.source_id WHERE ${conditions.join(' AND ')} ORDER BY l.created_at DESC LIMIT 500`, params);
}

async function ownedAccounts(userId, accountIds, isAdmin = false) {
  if (!Array.isArray(accountIds) || accountIds.length === 0) throw new Error('اختر حسابًا واحدًا على الأقل');
  const uniqueIds = [...new Set(accountIds.map(String))];
  const accounts = await queryAll(`SELECT id,name,status,health_status,task_status,connection_type FROM accounts WHERE id=ANY($1::uuid[]) AND ($2::boolean OR user_id=$3)`, [uniqueIds, isAdmin, userId]);
  if (accounts.length !== uniqueIds.length) throw new Error('يوجد حساب غير مملوك للمستخدم الحالي');
  return accounts;
}

async function materializeDiscoveredLinks(userId, discoveredLinkIds, isAdmin = false) {
  const ids = [...new Set((discoveredLinkIds || []).map(String).filter(Boolean))];
  if (!ids.length) return [];
  const discovered = await queryAll(`
    SELECT wl.id,wl.whatsapp_link
    FROM whatsapp_links wl
    WHERE wl.id=ANY($1::uuid[]) AND wl.deleted=false
      AND ($2::boolean OR wl.import_user_id=$3 OR EXISTS (SELECT 1 FROM accounts a WHERE a.id=wl.source_account_id AND a.user_id=$3))
  `, [ids, isAdmin, userId]);
  const materializedIds = [];
  for (const item of discovered) {
    const parsed = LinkUrlProcessingService.parseSupportedUrl(item.whatsapp_link);
    if (!parsed.ok) continue;
    const inserted = await queryOne(`INSERT INTO link_import_links (user_id,discovered_link_id,url,canonical_url,invite_code,validation_status) VALUES ($1,$2,$3,$4,$5,'valid') ON CONFLICT (user_id,canonical_url) DO UPDATE SET discovered_link_id=COALESCE(link_import_links.discovered_link_id,EXCLUDED.discovered_link_id),updated_at=NOW() RETURNING id`, [userId, item.id, parsed.originalUrl || item.whatsapp_link, parsed.canonicalUrl, parsed.inviteCode]);
    if (inserted?.id) materializedIds.push(inserted.id);
    else {
      const existing = await queryOne(`SELECT id FROM link_import_links WHERE user_id=$1 AND canonical_url=$2`, [userId, parsed.canonicalUrl]);
      if (existing?.id) materializedIds.push(existing.id);
    }
  }
  return materializedIds;
}

async function updateDiscoveredLinkState(linkId, processingStatus, status, operationId = null, errorMessage = null) {
  try {
    await query(`UPDATE whatsapp_links SET processing_status=$1::varchar,status=$2::varchar,last_operation_id=COALESCE($3::uuid,last_operation_id),last_verified_at=CASE WHEN $1::varchar IN ('processing','completed','failed','review') THEN NOW() ELSE last_verified_at END,next_operation_at=CASE WHEN $1::varchar IN ('queued','deferred') THEN next_operation_at ELSE NULL END,notes=CASE WHEN $4::text IS NULL THEN notes ELSE $4::text END,updated_at=NOW() WHERE id=(SELECT discovered_link_id FROM link_import_links WHERE id=$5::uuid)`, [processingStatus, status, operationId, errorMessage, linkId]);
  } catch (error) {
    console.error(`[LinkImport] state update failed for ${linkId}: ${error.message}`);
    throw error;
  }
}

async function getCycleSettings(taskId) {
  return queryOne(`SELECT t.user_id,t.status,t.min_delay_seconds,t.max_delay_seconds,t.queue_priority,t.cycle_limit,t.cycle_duration_minutes,t.auto_resume,COALESCE(s.automation_enabled,TRUE) AS automation_enabled FROM link_import_tasks t LEFT JOIN join_automation_settings s ON s.user_id=t.user_id WHERE t.id=$1`, [taskId]);
}

async function ensureAccountCycle(task, accountId) {
  const running = await queryOne(`SELECT * FROM link_import_cycles WHERE task_id=$1 AND account_id=$2 AND status='RUNNING' ORDER BY cycle_number DESC LIMIT 1`, [task.id, accountId]);
  if (running) return running;
  const available = await queryOne(`SELECT COUNT(*)::int count FROM link_import_operations WHERE task_id=$1 AND account_id=$2 AND cycle_id IS NULL AND status IN ('pending','retry','paused')`, [task.id, accountId]);
  if (!Number(available?.count || 0)) return null;
  const latest = await queryOne(`SELECT cycle_number,status,next_cycle_at FROM link_import_cycles WHERE task_id=$1 AND account_id=$2 ORDER BY cycle_number DESC LIMIT 1`, [task.id, accountId]);
  if (latest?.status === 'RESTING' && latest.next_cycle_at && new Date(latest.next_cycle_at).getTime() > Date.now()) return null;
  const nextNumber = Number(latest?.cycle_number || 0) + 1;
  const durationMinutes = Number(task.cycle_duration_minutes || DEFAULT_CYCLE_DURATION_MINUTES);
  const created = await queryOne(`INSERT INTO link_import_cycles(task_id,user_id,account_id,cycle_number,cycle_start,cycle_end,status) VALUES($1,$2,$3,$4,NOW(),NOW()+($5 * INTERVAL '1 minute'),'RUNNING') ON CONFLICT(task_id,account_id,cycle_number) DO NOTHING RETURNING *`, [task.id, task.user_id, accountId, nextNumber, durationMinutes]);
  return created || queryOne(`SELECT * FROM link_import_cycles WHERE task_id=$1 AND account_id=$2 AND cycle_number=$3`, [task.id, accountId, nextNumber]);
}

async function assignOperationsToCycle(task, cycle) {
  const assigned = await queryOne(`SELECT COUNT(*)::int count FROM link_import_operations WHERE cycle_id=$1`, [cycle.id]);
  const slots = JoinCyclePolicy.remainingSlots(Number(assigned?.count || 0), Number(task.cycle_limit || DEFAULT_CYCLE_LIMIT));
  if (!slots) return 0;
  const result = await query(`WITH picked AS (SELECT id FROM link_import_operations WHERE task_id=$1 AND account_id=$2 AND cycle_id IS NULL AND status IN ('pending','retry','paused') ORDER BY COALESCE(scheduled_at,created_at),created_at LIMIT $3) UPDATE link_import_operations o SET cycle_id=$4,updated_at=NOW() FROM picked WHERE o.id=picked.id`, [task.id, cycle.account_id, slots, cycle.id]);
  return Number(result?.rowCount || 0);
}

async function enqueueCycleWakeup(task, cycle, nextCycleAt) {
  if (task.auto_resume === false) return null;
  const delay = Math.max(0, new Date(nextCycleAt).getTime() - Date.now());
  return QueueManager.enqueueLinkImportCycle({ taskId: task.id, accountId: cycle.account_id, cycleId: cycle.id }, {
    delay,
    attempts: 1,
    jobId: `link-import-cycle-${cycle.id}-${new Date(nextCycleAt).getTime()}`,
  });
}

async function maybeCloseCycle(task, cycleId) {
  const cycle = await queryOne(`SELECT * FROM link_import_cycles WHERE id=$1`, [cycleId]);
  if (!cycle || cycle.status !== 'RUNNING') return cycle;
  const pending = await queryOne(`SELECT COUNT(*)::int count FROM link_import_operations WHERE cycle_id=$1 AND status IN ('pending','processing','retry','paused')`, [cycleId]);
  const unassigned = await queryOne(`SELECT COUNT(*)::int count FROM link_import_operations WHERE task_id=$1 AND account_id=$2 AND cycle_id IS NULL AND status IN ('pending','retry','paused')`, [task.id, cycle.account_id]);
  const processed = Number(cycle.processed_count || 0);
  const limit = Number(task.cycle_limit || DEFAULT_CYCLE_LIMIT);
  const cycleEnd = new Date(cycle.cycle_end || (new Date(cycle.cycle_start).getTime() + Number(task.cycle_duration_minutes || DEFAULT_CYCLE_DURATION_MINUTES) * 60000));
  const limitReached = JoinCyclePolicy.shouldRest({ processedCount: processed, cycleLimit: limit, cycleEnd: null });
  const windowReached = JoinCyclePolicy.isWindowExpired(cycleEnd);
  const noWorkInCycle = Number(pending?.count || 0) === 0 && Number(unassigned?.count || 0) === 0;
  if (!limitReached && !windowReached && !noWorkInCycle) return cycle;
  await query(`UPDATE link_import_operations SET cycle_id=NULL,scheduled_at=NULL,updated_at=NOW() WHERE cycle_id=$1 AND status IN ('pending','retry','paused')`, [cycleId]);
  const nextCycleAt = cycleEnd.getTime() > Date.now() ? cycleEnd : new Date();
  const updated = await queryOne(`UPDATE link_import_cycles SET status='RESTING',cycle_end=$1,next_cycle_at=$2,remaining_count=(SELECT COUNT(*) FROM link_import_operations WHERE task_id=$4 AND account_id=$5 AND status IN ('pending','retry','paused')),current_operation_id=NULL,current_link_id=NULL,updated_at=NOW() WHERE id=$3 AND status='RUNNING' RETURNING *`, [cycleEnd, nextCycleAt, cycleId, task.id, cycle.account_id]);
  if (updated) await enqueueCycleWakeup(task, updated, nextCycleAt).catch(error => console.warn(`[LinkImport] cycle wakeup enqueue skipped: ${error.message}`));
  await recordEvent({ userId: task.user_id, taskId: task.id, operationId: null, accountId: cycle.account_id, linkId: null, eventType: 'cycle_resting', payload: { cycleId, processedCount: processed, limit, cycleEnd: cycleEnd.toISOString(), nextCycleAt: new Date(nextCycleAt).toISOString() } }).catch(() => {});
  return updated || cycle;
}

async function scheduleAccountOperation(task, accountId, delayOverride = null, jobIdOverride = null) {
  if (task.automation_enabled === false) return null;
  const accountGuard = await assertAccountCanSchedule(accountId);
  if (!accountGuard.ok) return null;
  let cycle = await ensureAccountCycle(task, accountId);
  if (!cycle) return null;
  const cycleLimit = Number(task.cycle_limit || DEFAULT_CYCLE_LIMIT);
  if (Number(cycle.processed_count || 0) >= cycleLimit || (cycle.cycle_end && new Date(cycle.cycle_end).getTime() <= Date.now())) {
    const closed = await maybeCloseCycle(task, cycle.id);
    if (!closed || closed.status !== 'RUNNING') return null;
    cycle = closed;
  }
  await assignOperationsToCycle(task, cycle);
  const operation = await queryOne(`SELECT id operation_id,account_id,link_id,idempotency_key,scheduled_at FROM link_import_operations WHERE cycle_id=$1 AND status IN ('pending','retry','paused') ORDER BY COALESCE(scheduled_at,created_at),created_at LIMIT 1`, [cycle.id]);
  if (!operation) {
    await maybeCloseCycle(task, cycle.id);
    return null;
  }
  if (delayOverride === null && operation.scheduled_at && new Date(operation.scheduled_at).getTime() > Date.now()) return operation;
  const remainingInCycle = await queryOne(`SELECT COUNT(*)::int count FROM link_import_operations WHERE cycle_id=$1 AND status IN ('pending','retry','paused')`, [cycle.id]);
  const scheduled = delayOverride === null
    ? JoinScheduler.schedule({ minDelaySeconds: task.min_delay_seconds, maxDelaySeconds: task.max_delay_seconds, remainingOperations: Number(remainingInCycle?.count || 1), cycleEndAt: cycle.cycle_end })
    : { delaySeconds: clampSeconds(delayOverride, 0), scheduledAt: new Date(Date.now() + clampSeconds(delayOverride, 0) * 1000) };
  await query(`UPDATE link_import_operations SET scheduled_at=$1,next_run_at=$1,updated_at=NOW() WHERE id=$2 AND status IN ('pending','retry','paused')`, [scheduled.scheduledAt, operation.operation_id]);
  await query(`UPDATE link_import_cycles SET current_operation_id=$1,current_link_id=$2,remaining_count=(SELECT COUNT(*) FROM link_import_operations WHERE cycle_id=$3 AND status IN ('pending','retry','paused')),updated_at=NOW() WHERE id=$3`, [operation.operation_id, operation.link_id, cycle.id]).catch(() => {});
  await query(`UPDATE link_import_links SET updated_at=NOW() WHERE id=$1`, [operation.link_id]).catch(() => {});
  await query(`UPDATE whatsapp_links SET next_operation_at=$1,updated_at=NOW() WHERE id=(SELECT discovered_link_id FROM link_import_links WHERE id=$2)`, [scheduled.scheduledAt, operation.link_id]).catch(() => {});
  await query(`UPDATE link_import_tasks SET scheduled_at=CASE WHEN scheduled_at IS NULL OR scheduled_at>$1 THEN $1 ELSE scheduled_at END,updated_at=NOW() WHERE id=$2`, [scheduled.scheduledAt, task.id]);
  const operationData = { operationId: operation.operation_id, accountId: operation.account_id, linkId: operation.link_id, taskId: task.id };
  const jobId = jobIdOverride ? `${jobIdOverride}-${accountId}` : null;
  const outbox = await queryOne(`INSERT INTO link_import_outbox(user_id,aggregate_type,aggregate_id,event_type,payload,available_at) VALUES($1,'operation',$2,'enqueue_operation',$3::jsonb,$4) ON CONFLICT(aggregate_type,aggregate_id,event_type) DO UPDATE SET payload=EXCLUDED.payload,available_at=EXCLUDED.available_at,status='PENDING',updated_at=NOW() WHERE link_import_outbox.status <> 'PROCESSING' RETURNING id`, [task.user_id, operation.operation_id, JSON.stringify({ ...operationData, delaySeconds: scheduled.delaySeconds, priority: Number(task.queue_priority || 5), jobId }), scheduled.scheduledAt]);
  await recordEvent({ userId: task.user_id, taskId: task.id, operationId: operation.operation_id, accountId: operation.account_id, linkId: operation.link_id, eventType: 'queue_outbox_created', payload: { outboxId: outbox?.id || null, delaySeconds: scheduled.delaySeconds, cycleId: cycle.id } });
  if (outbox?.id) await dispatchOutbox(outbox.id);
  return { ...operation, cycleId: cycle.id, delaySeconds: scheduled.delaySeconds };
}

async function scheduleNextOperation(taskId, delayOverride = null, jobIdOverride = null, accountId = null) {
  const task = await getCycleSettings(taskId);
  if (!task || task.status !== 'pending') return null;
  const accounts = accountId
    ? [{ account_id: accountId }]
    : await queryAll(`SELECT DISTINCT account_id FROM link_import_operations WHERE task_id=$1 AND status IN ('pending','retry','paused') ORDER BY account_id`, [taskId]);
  const scheduled = [];
  for (const account of accounts) {
    const next = await scheduleAccountOperation(task, account.account_id, delayOverride, jobIdOverride);
    if (next) scheduled.push(next);
  }
  return scheduled;
}

async function advanceCycle({ taskId, accountId, cycleId }) {
  const task = await getCycleSettings(taskId);
  if (!task || task.status !== 'pending' || task.auto_resume === false || task.automation_enabled === false) return null;
  const cycle = await queryOne(`SELECT * FROM link_import_cycles WHERE id=$1 AND task_id=$2 AND account_id=$3`, [cycleId, taskId, accountId]);
  if (!cycle || cycle.status !== 'RESTING') return null;
  if (cycle.next_cycle_at && new Date(cycle.next_cycle_at).getTime() > Date.now()) {
    await enqueueCycleWakeup(task, cycle, cycle.next_cycle_at).catch(() => {});
    return cycle;
  }
  await query(`UPDATE link_import_cycles SET status='COMPLETED',updated_at=NOW() WHERE id=$1 AND status='RESTING'`, [cycleId]);
  await recordEvent({ userId: task.user_id, taskId, operationId: null, accountId, linkId: null, eventType: 'cycle_started', payload: { previousCycleId: cycleId } }).catch(() => {});
  const next = await scheduleNextOperation(taskId, 0, `link-import-cycle-start-${cycleId}`, accountId);
  if (!next || (Array.isArray(next) && !next.length)) {
    const remaining = await queryOne(`SELECT COUNT(*)::int count FROM link_import_operations WHERE task_id=$1 AND status IN ('pending','processing','retry','paused')`, [taskId]);
    if (!Number(remaining?.count || 0)) await query(`UPDATE link_import_tasks SET status='completed',completed_at=COALESCE(completed_at,NOW()),updated_at=NOW() WHERE id=$1 AND status='pending'`, [taskId]);
  }
  return next;
}

async function getAccountJoinCooldown(accountId, minDelaySeconds) {
  const latest = await queryOne(`SELECT COALESCE(join_completed_at,join_started_at) AS last_join_at FROM link_import_operations WHERE account_id=$1 AND (join_completed_at IS NOT NULL OR join_started_at IS NOT NULL) ORDER BY COALESCE(join_completed_at,join_started_at) DESC LIMIT 1`, [accountId]).catch(() => null);
  return JoinScheduler.remainingAccountDelay(latest?.last_join_at, minDelaySeconds);
}

async function deferForAccountPacing({ operation, delaySeconds }) {
  const safeDelaySeconds = Math.max(1, Math.ceil(Number(delaySeconds) || 0));
  const scheduled = await requestReschedule({
    operationId: operation.operation_id,
    accountId: operation.account_id,
    taskId: operation.task_id,
    linkId: operation.link_id,
    delaySeconds: safeDelaySeconds,
    reason: 'min_interval_between_account_joins',
    eventType: 'pacing_deferred',
    jobId: `link-import-op-${operation.operation_id}`,
  });
  if (!scheduled) return false;
  await query(`UPDATE link_import_links SET updated_at=NOW() WHERE id=$1`, [operation.link_id]).catch(() => {});
  await query(`UPDATE whatsapp_links SET next_operation_at=$1,updated_at=NOW() WHERE id=(SELECT discovered_link_id FROM link_import_links WHERE id=$2)`, [scheduled.scheduledAt, operation.link_id]).catch(() => {});
  return true;
}

async function dispatchOutbox(outboxId) {
  const workerId = `${process.env.RAILWAY_REPLICA_ID || process.env.RAILWAY_SERVICE_NAME || 'backend'}:${process.pid}`;
  const claimed = await queryOne(`UPDATE link_import_outbox SET status='PROCESSING',attempt_count=attempt_count+1,worker_id=$2,lease_expires_at=NOW()+INTERVAL '2 minutes',updated_at=NOW() WHERE id=$1 AND available_at<=NOW() AND (status='PENDING' OR (status='PROCESSING' AND lease_expires_at<NOW())) RETURNING *`, [outboxId, workerId]);
  if (!claimed) return null;
  const payload = parseJSON(claimed.payload, {});
  try {
    const currentOperation = await queryOne(`SELECT o.status,COALESCE(s.automation_enabled,TRUE) AS automation_enabled FROM link_import_operations o JOIN link_import_tasks t ON t.id=o.task_id LEFT JOIN join_automation_settings s ON s.user_id=t.user_id WHERE o.id=$1`, [payload.operationId]).catch(() => null);
    if (!currentOperation || ['success','failed','skipped','review'].includes(currentOperation.status) || currentOperation.automation_enabled === false) {
      const reason = !currentOperation ? 'العملية غير موجودة' : currentOperation.automation_enabled === false ? 'تم إيقاف الأتمتة العامة' : 'العملية أصبحت نهائية';
      await query(`UPDATE link_import_outbox SET status='CANCELLED',processed_at=NOW(),lease_expires_at=NULL,last_error=$1,updated_at=NOW() WHERE id=$2`, [reason, claimed.id]);
      await recordEvent({ userId: claimed.user_id, taskId: payload.taskId, operationId: payload.operationId, accountId: payload.accountId, linkId: payload.linkId, eventType: 'outbox_blocked', payload: { reason: currentOperation?.automation_enabled === false ? 'emergency_stop' : 'operation_not_eligible' } }).catch(() => {});
      return null;
    }
    const guard = await assertAccountCanSchedule(payload.accountId);
    if (!guard.ok) {
      await query(`UPDATE link_import_outbox SET status='CANCELLED',processed_at=NOW(),lease_expires_at=NULL,last_error='تم إلغاء Outbox لأن الحساب محمي أو محظور',updated_at=NOW() WHERE id=$1`, [claimed.id]);
      await recordEvent({ userId: claimed.user_id, taskId: payload.taskId, operationId: payload.operationId, accountId: payload.accountId, linkId: payload.linkId, eventType: 'outbox_blocked', payload: { reason: 'account_protected', circuitState: guard.account?.circuit_state || null, accountStatus: guard.account?.status || null } }).catch(() => {});
      return null;
    }
    const job = await QueueManager.enqueueLinkImportOperation(payload, { delay: Math.max(0, Number(payload.delaySeconds || 0) * 1000), priority: Number(payload.priority || 5), attempts: 1, jobId: payload.jobId || `link-import-op-${payload.operationId}` });
    await query(`UPDATE link_import_outbox SET status='PROCESSED',processed_at=NOW(),lease_expires_at=NULL,updated_at=NOW() WHERE id=$1 AND worker_id=$2`, [claimed.id, workerId]);
    await query(`UPDATE link_import_operations SET queue_job_id=$1,updated_at=NOW() WHERE id=$2 AND status IN ('pending','retry','paused')`, [String(job?.id || ''), payload.operationId]).catch(() => {});
    await recordEvent({ userId: claimed.user_id, taskId: payload.taskId, operationId: payload.operationId, accountId: payload.accountId, linkId: payload.linkId, eventType: 'queue_enqueued', payload: { jobId: job?.id || null, outboxId: claimed.id } });
    return job;
  } catch (error) {
    const delay = Math.min(3600, Math.max(30, 30 * Number(claimed.attempt_count || 1)));
    await query(`UPDATE link_import_outbox SET status='PENDING',available_at=NOW()+($1 * INTERVAL '1 second'),last_error=$2,updated_at=NOW() WHERE id=$3`, [delay, error.message, claimed.id]).catch(() => {});
    throw error;
  }
}

async function dispatchOutboxBatch() {
  const rows = await queryAll(`SELECT id FROM link_import_outbox WHERE available_at<=NOW() AND (status='PENDING' OR (status='PROCESSING' AND lease_expires_at<NOW())) ORDER BY created_at LIMIT 50`);
  let dispatched = 0;
  for (const row of rows) { try { if (await dispatchOutbox(row.id)) dispatched += 1; } catch (_) {} }
  return dispatched;
}

async function maybeCompleteTask(taskId) {
  await query(`UPDATE link_import_tasks SET completed_operations=(SELECT COUNT(*) FROM link_import_operations WHERE task_id=$1 AND status IN ('success','failed','skipped','review')),updated_at=NOW() WHERE id=$1`, [taskId]).catch(() => {});
  const remaining = await queryOne(`SELECT COUNT(*)::int count FROM link_import_operations WHERE task_id=$1 AND status IN ('pending','processing','retry','paused')`, [taskId]);
  if (!remaining?.count) await query(`UPDATE link_import_tasks SET status='completed',completed_at=COALESCE(completed_at,NOW()),updated_at=NOW() WHERE id=$1 AND status <> 'stopped'`, [taskId]);
}

async function pauseIfRequested(operation) {
  const task = await queryOne(`SELECT status FROM link_import_tasks WHERE id=$1`, [operation.task_id]);
  if (!task || task.status === 'pending') return false;
  if (task.status === 'paused') {
    await query(`UPDATE link_import_operations SET status='paused',updated_at=NOW() WHERE id=$1 AND status IN ('pending','retry','processing')`, [operation.operation_id]);
    await recordEvent({ userId: operation.user_id, taskId: operation.task_id, operationId: operation.operation_id, accountId: operation.account_id, linkId: operation.link_id, eventType: 'paused_at_stage', payload: { stage: operation.current_stage } });
    return true;
  }
  if (task.status === 'stopped') {
    await query(`UPDATE link_import_operations SET status='skipped',current_stage='failed',completed_at=NOW(),last_error='تم إيقاف المهمة يدويًا',updated_at=NOW() WHERE id=$1 AND status NOT IN ('success','failed','skipped')`, [operation.operation_id]);
    await recordEvent({ userId: operation.user_id, taskId: operation.task_id, operationId: operation.operation_id, accountId: operation.account_id, linkId: operation.link_id, eventType: 'stopped_at_stage', payload: { stage: operation.current_stage } });
    await maybeCompleteTask(operation.task_id);
    return true;
  }
  return false;
}

async function countCycleOperation(operationId, bucket) {
  const result = await queryOne(`WITH marked AS (
    UPDATE link_import_operations
       SET cycle_counted_at=NOW(),updated_at=NOW()
     WHERE id=$1 AND cycle_id IS NOT NULL AND cycle_counted_at IS NULL
     RETURNING cycle_id
  )
  UPDATE link_import_cycles c
     SET processed_count=c.processed_count+1,
         success_count=c.success_count+CASE WHEN $2='JOINED' THEN 1 ELSE 0 END,
         request_count=c.request_count+CASE WHEN $2='JOIN_REQUEST_SENT' THEN 1 ELSE 0 END,
         failed_count=c.failed_count+CASE WHEN $2='FAILED' THEN 1 ELSE 0 END,
         remaining_count=(SELECT COUNT(*) FROM link_import_operations WHERE cycle_id=c.id AND status IN ('pending','retry','paused')),
         current_operation_id=NULL,
         current_link_id=NULL,
         last_result=$2,
         updated_at=NOW()
    FROM marked
   WHERE c.id=marked.cycle_id
   RETURNING c.*`, [operationId, bucket]);
  return result;
}

async function failOperation(operation, stage, message, status = 'review') {
  const currentStatus = operation.operation_status || operation.status || 'processing';
  if (!JoinScheduler.canTransition(currentStatus, status)) return;
  const classification = LinkUrlProcessingService.classifyJoinError(message);
  const errorCode = classification?.errorCode || stage || 'OPERATION_FAILED';
  await query(`UPDATE link_import_operations SET status=$1,current_stage=$2,last_error=$3,error_code=$4,completed_at=NOW(),stage_updated_at=NOW(),lease_expires_at=NULL,heartbeat_at=NOW(),updated_at=NOW() WHERE id=$5 AND status NOT IN ('success','failed','skipped','review')`, [status, 'failed', message, errorCode, operation.operation_id]);
  await updateDiscoveredLinkState(operation.link_id, status === 'review' ? 'review' : 'failed', status === 'review' ? 'review' : 'failed', operation.operation_id, message);
  await recordEvent({ userId: operation.user_id, taskId: operation.task_id, operationId: operation.operation_id, accountId: operation.account_id, linkId: operation.link_id, eventType: 'operation_failed', payload: { stage, error: message } });
  await maybeCompleteTask(operation.task_id);
  await scheduleNextOperation(operation.task_id, null, null, operation.account_id);
}

async function setStage(operationId, stage, fields = {}) {
  const assignments = ['current_stage=$1', 'stage_updated_at=NOW()', 'processing_started_at=COALESCE(processing_started_at,NOW())', 'updated_at=NOW()'];
  const values = [stage];
  for (const [key, value] of Object.entries(fields)) { assignments.push(`${key}=$${values.length + 1}`); values.push(value); }
  values.push(operationId);
  assignments.push('heartbeat_at=NOW()', 'lease_expires_at=NOW()+INTERVAL \'2 minutes\'');
  await query(`UPDATE link_import_operations SET ${assignments.join(',')} WHERE id=$${values.length}`, values);
}

async function waitAndContinue(operation, stage, seconds, nextStage) {
  if (!seconds) return false;
  await setStage(operation.operation_id, stage, { wait_started_at: new Date() });
  await recordEvent({ userId: operation.user_id, taskId: operation.task_id, operationId: operation.operation_id, accountId: operation.account_id, linkId: operation.link_id, eventType: 'wait_started', payload: { stage, seconds, nextStage } });
  const scheduled = await requestReschedule({ operationId: operation.operation_id, accountId: operation.account_id, taskId: operation.task_id, linkId: operation.link_id, delaySeconds: seconds, reason: `wait_after_${stage.replace(/^wait_after_/, '')}`, eventType: 'wait_scheduled', jobId: `link-import-op-${operation.operation_id}` });
  return Boolean(scheduled);
}

async function publishAds({ accountId, groupId, adPayloads, taskId }) {
  const results = [];
  for (const ad of adPayloads) {
    try {
      const broadcastController = getBroadcastController();
      await broadcastController._sendOne(accountId, groupId, broadcastController._buildMessageContent(ad), { operationType: 'group', taskId });
      results.push({ adId: ad.id, name: ad.name, status: 'success' });
      try {
        const accountDB = await getDatabaseManager().getAccountDB(accountId);
        await accountDB.run(`UPDATE ad_library SET use_count = use_count + 1, last_used_at = NOW() WHERE id = $1`, [ad.id]);
      } catch (_) {}
    } catch (error) {
      results.push({ adId: ad.id, name: ad.name, status: 'failed', error: error.message });
      break;
    }
  }
  return { success: results.length === adPayloads.length && results.every(item => item.status === 'success'), results };
}

async function createTask({ userId, linkIds, accountIds, settings = {}, isAdmin = false, requestId = null }) {
  const stableRequestId = String(requestId || settings.requestId || '').trim().slice(0, 255) || null;
  if (stableRequestId) {
    const existing = await queryOne(`SELECT * FROM link_import_tasks WHERE user_id=$1 AND request_id=$2`, [userId, stableRequestId]);
    if (existing) return { task: existing, accountsCount: 0, linksCount: 0, totalOperations: Number(existing.total_operations || 0), distributionMode: existing.distribution_mode, idempotent: true };
  }
  const persistedSettings = await queryOne(`SELECT min_delay_seconds,max_delay_seconds,max_concurrent_jobs,retry_count,retry_backoff_seconds,queue_priority,daily_operation_limit,daily_limit_protection_enabled,cycle_limit,cycle_duration_minutes,auto_resume,automation_enabled,account_settings FROM join_automation_settings WHERE user_id=$1`, [userId]).catch(() => null);
  const storedAccountSettings = parseJSON(persistedSettings?.account_settings, {});
  const configuredDailyOperationLimit = settings.dailyOperationLimit ?? settings.daily_operation_limit ?? persistedSettings?.daily_operation_limit ?? 10;
  const configuredDailyLimitProtection = settings.dailyLimitProtectionEnabled ?? settings.daily_limit_protection_enabled ?? persistedSettings?.daily_limit_protection_enabled ?? false;
  settings = { ...persistedSettings, ...settings, accountSettings: settings.accountSettings || storedAccountSettings, minDelaySeconds: settings.minDelaySeconds ?? persistedSettings?.min_delay_seconds, maxDelaySeconds: settings.maxDelaySeconds ?? persistedSettings?.max_delay_seconds, maxRetries: settings.maxRetries ?? persistedSettings?.retry_count, retryBackoffSeconds: settings.retryBackoffSeconds ?? persistedSettings?.retry_backoff_seconds, queuePriority: settings.queuePriority ?? persistedSettings?.queue_priority, dailyOperationLimit: configuredDailyOperationLimit, daily_operation_limit: configuredDailyOperationLimit, dailyLimitProtectionEnabled: Boolean(configuredDailyLimitProtection), daily_limit_protection_enabled: Boolean(configuredDailyLimitProtection), cycleLimit: settings.cycleLimit ?? settings.cycle_limit ?? persistedSettings?.cycle_limit ?? DEFAULT_CYCLE_LIMIT, cycleDurationMinutes: settings.cycleDurationMinutes ?? settings.cycle_duration_minutes ?? persistedSettings?.cycle_duration_minutes ?? DEFAULT_CYCLE_DURATION_MINUTES, autoResume: settings.autoResume ?? settings.auto_resume ?? persistedSettings?.auto_resume ?? true };
  if (persistedSettings?.automation_enabled === false && settings.allowWhenDisabled !== true) throw new Error('أتمتة الانضمام متوقفة من الإعدادات العامة');
  let accounts = await ownedAccounts(userId, accountIds, isAdmin);
  const protectedAccount = accounts.find(account => account.status === 'banned' || ['blocked', 'protected'].includes(account.health_status) || account.task_status === 'stopped');
  if (protectedAccount) throw new Error(`الحساب ${protectedAccount.name || protectedAccount.id} محمي أو محظور ولا يمكن إدخاله في مهمة جديدة`);
  const guardRows = await queryAll(`SELECT account_id,circuit_state,reason_code FROM link_import_account_guards WHERE account_id=ANY($1::uuid[]) AND circuit_state='OPEN'`, [accounts.map(account => account.id)]).catch(() => []);
  if (guardRows.length) throw new Error(`يوجد حساب محمي بقاطع مفتوح ولا يمكن بدء مهمة جديدة: ${guardRows.map(row => row.reason_code || row.account_id).join(', ')}`);
  const offlineAccount = accounts.find(account => account.status !== 'connected');
  if (offlineAccount) throw new Error(`الحساب ${offlineAccount.name || offlineAccount.id} غير متصل حاليًا؛ أعد الاتصال قبل بدء الأتمتة`);
  const accountSettings = parseJSON(settings.accountSettings, {});
  accounts = accounts.filter(account => accountSettings[String(account.id)]?.enabled !== false);
  if (!accounts.length) throw new Error('كل الحسابات المحددة متوقفة من إعدادات أتمتة الانضمام');
  const discoveredLinkIds = [...new Set((settings.discoveredLinkIds || settings.discovered_link_ids || []).map(String).filter(Boolean))];
  const requestedIds = discoveredLinkIds.length ? await materializeDiscoveredLinks(userId, discoveredLinkIds, isAdmin) : [...new Set((linkIds || []).map(String))];
  if (!requestedIds.length) throw new Error('اختر رابطًا واحدًا على الأقل');
  const links = await queryAll(`SELECT id,canonical_url FROM link_import_links WHERE user_id=$1 AND id=ANY($2::uuid[]) AND validation_status='valid'`, [userId, requestedIds]);
  if (links.length !== requestedIds.length) throw new Error('بعض الروابط غير صالحة أو لا تنتمي للمستخدم الحالي');

  const adLibraryIds = [...new Set((settings.adLibraryIds || settings.ad_library_ids || []).map(String).filter(Boolean))];
  const workflowMode = adLibraryIds.length ? 'staged' : 'join_only';
  const adPayloads = workflowMode === 'staged' ? await resolveAdPayloads(accounts[0].id, adLibraryIds) : [];
  if (workflowMode === 'staged' && !adPayloads.length) throw new Error('اختر إعلانًا فعالًا من مكتبة الإعلانات');

  const minDelay = clampSeconds(settings.minDelaySeconds ?? 60, 60);
  const maxDelay = Math.max(minDelay, clampSeconds(settings.maxDelaySeconds ?? 180, 180));
  const maxRetries = Math.max(0, Math.min(5, Number(settings.maxRetries ?? settings.retryCount ?? 2)));
  const retryBackoffSeconds = Math.max(1, Math.min(3600, Number(settings.retryBackoffSeconds ?? 15)));
  const queuePriority = Math.max(1, Math.min(10, Number(settings.queuePriority ?? 5)));
  const waitAfterJoin = clampSeconds(settings.waitAfterJoinSeconds ?? settings.wait_after_join_seconds, 0);
  const waitAfterPublish = clampSeconds(settings.waitAfterPublishSeconds ?? settings.wait_after_publish_seconds, 0);
  const waitAfterLeave = clampSeconds(settings.waitAfterLeaveSeconds ?? settings.wait_after_leave_seconds, 0);
  const leaveEnabled = Boolean(settings.leaveEnabled ?? settings.leave_enabled);
  const cycleLimit = Math.max(1, Math.min(30, Math.floor(Number(settings.cycleLimit ?? settings.cycle_limit ?? DEFAULT_CYCLE_LIMIT))));
  const cycleDurationMinutes = Math.max(1, Math.min(1440, Math.floor(Number(settings.cycleDurationMinutes ?? settings.cycle_duration_minutes ?? DEFAULT_CYCLE_DURATION_MINUTES))));
  const autoResume = settings.autoResume ?? settings.auto_resume ?? true;
  const applyAllLinks = settings.applyAllLinksToAllAccounts !== false && settings.apply_all_links_to_all_accounts !== false;
  const distributionMode = applyAllLinks ? 'all_accounts' : 'round_robin';
  const dailyOperationLimit = Math.max(1, Math.min(5000, Math.floor(Number(settings.dailyOperationLimit ?? settings.daily_operation_limit ?? 10))));
  const plannedPerAccount = new Map(accounts.map(account => [String(account.id), 0]));
  if (applyAllLinks) accounts.forEach(account => plannedPerAccount.set(String(account.id), links.length));
  else links.forEach((_, index) => { const account = accounts[index % accounts.length]; plannedPerAccount.set(String(account.id), Number(plannedPerAccount.get(String(account.id)) || 0) + 1); });
  const dailyCounts = await queryAll(`SELECT account_id,COUNT(*)::int count FROM link_import_operations WHERE account_id=ANY($1::uuid[]) AND created_at >= CURRENT_DATE GROUP BY account_id`, [accounts.map(account => account.id)]);
  const dailyCountMap = new Map(dailyCounts.map(row => [String(row.account_id), Number(row.count || 0)]));
  const exceeded = settings.dailyLimitProtectionEnabled === true
    ? accounts.find(account => Number(dailyCountMap.get(String(account.id)) || 0) + Number(plannedPerAccount.get(String(account.id)) || 0) > dailyOperationLimit)
    : null;
  if (exceeded) {
    const used = Number(dailyCountMap.get(String(exceeded.id)) || 0);
    throw new Error(`تم إيقاف المهمة لحماية الحساب ${exceeded.name || exceeded.id}: الحد اليومي ${dailyOperationLimit} عملية، والمستخدم ${used} عملية اليوم.`);
  }
  const totalOperations = applyAllLinks ? accounts.length * links.length : links.length;
  const pairs = applyAllLinks
    ? accounts.flatMap(account => links.map(link => ({ account, link })))
    : links.map((link, index) => ({ account: accounts[index % accounts.length], link }));
  const { task, operations } = await withTransaction(async (client) => {
    const taskResult = await client.query(`INSERT INTO link_import_tasks (user_id,status,min_delay_seconds,max_delay_seconds,max_retries,retry_backoff_seconds,queue_priority,ad_library_ids,ad_payloads,workflow_mode,distribution_mode,source_link_ids,wait_after_join_seconds,wait_after_publish_seconds,wait_after_leave_seconds,leave_enabled,total_operations,request_id,cycle_limit,cycle_duration_minutes,auto_resume) VALUES ($1,'pending',$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9,$10,$11::jsonb,$12,$13,$14,$15,$16,$17,$18,$19,$20) RETURNING *`, [userId, minDelay, maxDelay, maxRetries, retryBackoffSeconds, queuePriority, JSON.stringify(adLibraryIds), JSON.stringify(adPayloads), workflowMode, distributionMode, JSON.stringify(discoveredLinkIds), waitAfterJoin, waitAfterPublish, waitAfterLeave, leaveEnabled, totalOperations, stableRequestId, cycleLimit, cycleDurationMinutes, Boolean(autoResume)]);
    const task = taskResult.rows[0];
    const operations = [];
    for (const { account, link } of pairs) {
      const idempotencyKey = `join:${userId}:${task.id}:${account.id}:${link.id}`;
      const opResult = await client.query(`INSERT INTO link_import_operations (task_id,user_id,account_id,link_id,idempotency_key,status,current_stage,leave_status) VALUES ($1,$2,$3,$4,$5,'pending','pending',$6) ON CONFLICT (task_id,account_id,link_id) DO NOTHING RETURNING id`, [task.id, userId, account.id, link.id, idempotencyKey, leaveEnabled ? 'pending' : 'skipped']);
      if (opResult.rows[0]) operations.push({ operationId: opResult.rows[0].id, accountId: account.id, linkId: link.id });
    }
    const linkResult = await client.query(`UPDATE whatsapp_links SET processing_status='queued',status=CASE WHEN status IN ('new','valid') THEN 'queued' ELSE status END,next_operation_at=NOW(),updated_at=NOW() WHERE id IN (SELECT discovered_link_id FROM link_import_links WHERE id=ANY($1::uuid[]) AND discovered_link_id IS NOT NULL)`, [links.map(link => link.id)]);
    if (linkResult.rowCount !== links.length) throw new Error('تعذر تحديث كل الروابط قبل جدولة المهمة');
    if (operations[0]) {
      await client.query(`INSERT INTO link_import_outbox(user_id,aggregate_type,aggregate_id,event_type,payload) VALUES($1,'operation',$2,'enqueue_operation',$3::jsonb) ON CONFLICT(aggregate_type,aggregate_id,event_type) DO NOTHING`, [userId, operations[0].operationId, JSON.stringify({ taskId: task.id, operationId: operations[0].operationId, accountId: operations[0].accountId, linkId: operations[0].linkId, delaySeconds: 0, priority: queuePriority })]);
    }
    return { task, operations };
  });
  await recordEvent({ userId, taskId: task.id, eventType: 'task_created', payload: { workflowMode, distributionMode, accounts: accounts.length, links: links.length, operations: operations.length, discoveredLinkIds, adLibraryIds, waitAfterJoin, waitAfterPublish, waitAfterLeave, leaveEnabled, queuePriority, retryBackoffSeconds, outbox: true } });
  await scheduleNextOperation(task.id, 0);
  return { task, accountsCount: accounts.length, linksCount: links.length, totalOperations: operations.length, distributionMode };
}

async function taskDashboard(userId, taskId) {
  const task = await queryOne(`SELECT * FROM link_import_tasks WHERE id=$1 AND user_id=$2`, [taskId, userId]);
  if (!task) return null;
  task.ad_library_ids = parseJSON(task.ad_library_ids, []);
  task.ad_payloads = parseJSON(task.ad_payloads, []);
  const operations = await queryAll(`SELECT o.*, a.name account_name, l.canonical_url url FROM link_import_operations o JOIN accounts a ON a.id=o.account_id JOIN link_import_links l ON l.id=o.link_id WHERE o.task_id=$1 ORDER BY a.name,l.created_at`, [taskId]);
  const cycles = await queryAll(`SELECT c.*,a.name account_name,a.phone_number account_phone FROM link_import_cycles c JOIN accounts a ON a.id=c.account_id WHERE c.task_id=$1 ORDER BY c.account_id,c.cycle_number DESC`, [taskId]).catch(() => []);
  let events = [];
  try { events = await queryAll(`SELECT * FROM link_import_events WHERE task_id=$1 ORDER BY created_at DESC LIMIT 100`, [taskId]); }
  catch (error) { console.warn(`[LinkImport] event history unavailable for task ${taskId}: ${error.message}`); }
  const stats = operations.reduce((acc, item) => { acc.total++; acc[item.status] = (acc[item.status] || 0) + 1; return acc; }, { total: 0, pending: 0, processing: 0, success: 0, failed: 0, retry: 0, paused: 0, skipped: 0, review: 0 });
  const terminal = stats.success + stats.failed + stats.skipped + stats.review;
  return { task, operations, cycles, events, stats, progress: stats.total ? Math.round((terminal / stats.total) * 100) : 0 };
}

async function stopAccountOperations(accountId, reason = 'تم إيقاف العملية لحماية الحساب') {
  await QueueManager.cancelAccountLinkImportJobs(accountId).catch(error => console.warn(`[LinkImport] queue cancellation skipped: ${error.message}`));
  await query(`UPDATE link_import_outbox SET status='CANCELLED',processed_at=COALESCE(processed_at,NOW()),lease_expires_at=NULL,last_error=$1,updated_at=NOW() WHERE aggregate_type='operation' AND aggregate_id IN (SELECT id FROM link_import_operations WHERE account_id=$2) AND status IN ('PENDING','PROCESSING')`, [reason, accountId]).catch(error => console.warn(`[LinkImport] outbox cancellation skipped: ${error.message}`));
  const affected = await queryAll(`UPDATE link_import_operations SET status='review',current_stage='failed',last_error=$1,error_code='ACCOUNT_BANNED',completed_at=NOW(),lease_expires_at=NULL,heartbeat_at=NOW(),updated_at=NOW() WHERE account_id=$2 AND status IN ('pending','processing','retry','paused') RETURNING id operation_id,task_id,user_id,account_id,link_id`, [reason, accountId]);
  const taskIds = [...new Set(affected.map(item => String(item.task_id)))];
  for (const operation of affected) {
    await updateDiscoveredLinkState(operation.link_id, 'review', 'review', operation.operation_id, reason).catch(error => console.warn(`[LinkImport] banned link state update skipped: ${error.message}`));
    await countCycleOperation(operation.operation_id, 'FAILED').catch(() => {});
    await recordEvent({ userId: operation.user_id, taskId: operation.task_id, operationId: operation.operation_id, accountId, linkId: operation.link_id, eventType: 'account_banned', payload: { reason } }).catch(() => {});
  }
  for (const taskId of taskIds) {
    await maybeCompleteTask(taskId).catch(error => console.warn(`[LinkImport] banned task reconciliation skipped: ${error.message}`));
    await scheduleNextOperation(taskId, 0, null, accountId).catch(error => console.warn(`[LinkImport] next operation scheduling skipped: ${error.message}`));
  }
  if (affected.length) console.warn(`[LinkImport] stopped ${affected.length} operation(s) for banned account ${accountId}`);
  return affected.length;
}

async function recoverPendingOperations() {
  const stuck = await queryAll(`SELECT o.id operation_id,o.task_id task_id,o.account_id accountId,o.link_id linkId FROM link_import_operations o JOIN link_import_tasks t ON t.id=o.task_id WHERE t.status='pending' AND o.status='processing' AND o.current_stage NOT IN ('wait_after_join','wait_after_publish','wait_after_leave') AND (o.lease_expires_at IS NULL OR o.lease_expires_at < NOW())`);
  let recovered = 0;
  for (const operation of stuck) {
    metrics.recordRecovery(operation.accountId);
    const guard = await assertAccountCanSchedule(operation.accountId);
    if (!guard.ok) {
      const blocked = await queryOne(`UPDATE link_import_operations SET status='review',current_stage='failed',last_error='تم إيقاف الاستعادة لأن الحساب محمي أو محظور',error_code=$1,completed_at=NOW(),lease_expires_at=NULL,heartbeat_at=NOW(),updated_at=NOW() WHERE id=$2 AND status='processing' RETURNING id,task_id,user_id,account_id,link_id`, [guard.account?.status === 'banned' ? 'ACCOUNT_BANNED' : 'ACCOUNT_PROTECTED', operation.operation_id]);
      if (blocked) {
        await recordEvent({ userId: blocked.user_id, taskId: blocked.task_id, operationId: blocked.id, accountId: blocked.account_id, linkId: blocked.link_id, eventType: 'recovery_blocked', payload: { reason: 'account_protected' } }).catch(() => {});
        await maybeCompleteTask(blocked.task_id).catch(() => {});
      }
      continue;
    }
    let membership = null;
    try {
      const sock = getWhatsAppManager().getSession(operation.accountId);
      if (sock && getWhatsAppManager().isReady(operation.accountId)) {
        const row = await queryOne(`SELECT l.canonical_url url,o.group_id FROM link_import_operations o JOIN link_import_links l ON l.id=o.link_id WHERE o.id=$1`, [operation.operation_id]);
        const code = getGroupJoinerService()._extractInviteCode(row?.url);
        membership = row?.group_id ? await getGroupJoinerService()._confirmMembership(sock, row.group_id) : (code ? await getGroupJoinerService()._confirmInviteMembership(sock, code) : null);
      }
    } catch (_) { membership = null; }
    if (membership?.confirmed) {
      const recoveredResult = await queryOne(`UPDATE link_import_operations SET status='success',current_stage='completed',join_status='success',membership_state='ALREADY_MEMBER',result=jsonb_build_object('status','already_joined','success',true,'confirmed',true,'membership_state','ALREADY_MEMBER','recovered',true,'group_id',COALESCE(group_id,$2::text)),completed_at=NOW(),lease_expires_at=NULL,heartbeat_at=NOW(),updated_at=NOW() WHERE id=$1 AND status='processing' RETURNING id,task_id,user_id,account_id,link_id`, [operation.operation_id, membership.groupId || null]);
      if (recoveredResult) {
        await query(`UPDATE whatsapp_links SET joined=true,status='joined',processing_status='completed',last_status='success',last_error=NULL,last_operation_id=$1,updated_at=NOW() WHERE id=(SELECT discovered_link_id FROM link_import_links WHERE id=$2)`, [recoveredResult.id, recoveredResult.link_id]).catch(() => {});
        await recordEvent({ userId: recoveredResult.user_id, taskId: recoveredResult.task_id, operationId: recoveredResult.id, accountId: recoveredResult.account_id, linkId: recoveredResult.link_id, eventType: 'operation_recovered_as_already_member', payload: { membershipState: 'ALREADY_MEMBER' } });
        await countCycleOperation(recoveredResult.id, 'JOINED').catch(() => {});
        await maybeCompleteTask(recoveredResult.task_id);
        recovered += 1;
        continue;
      }
    }
    const claimed = await queryOne(`UPDATE link_import_operations SET status='retry',last_error='استعادة بعد إعادة تشغيل العامل أو انتهاء lease',error_code='STALE_LEASE_RECOVERED',next_retry_at=NULL,lease_expires_at=NULL,heartbeat_at=NOW(),updated_at=NOW(),recovery_count=recovery_count+1 WHERE id=$1 AND status='processing' AND (lease_expires_at IS NULL OR lease_expires_at < NOW()) RETURNING id`, [operation.operation_id]);
    if (!claimed) continue;
    await scheduleNextOperation(operation.task_id, 5, null, operation.accountId);
    recovered += 1;
  }

  const dueCycles = await queryAll(`SELECT c.id cycle_id,c.task_id,c.account_id FROM link_import_cycles c JOIN link_import_tasks t ON t.id=c.task_id WHERE t.status='pending' AND c.status='RUNNING' AND c.cycle_end IS NOT NULL AND c.cycle_end<=NOW()`);
  for (const cycle of dueCycles) {
    const task = await getCycleSettings(cycle.task_id);
    if (!task) continue;
    await maybeCloseCycle(task, cycle.cycle_id).catch(error => console.warn(`[LinkImport] due cycle recovery skipped for ${cycle.cycle_id}: ${error.message}`));
    recovered += 1;
  }

  // A task can be persisted before the process finishes booting. In that case
  // createTask has already written the DB rows but the first BullMQ job may not
  // have been enqueued. Reconcile only the next persisted operation; do not
  // create new DB operations and do not touch paused/stopped tasks.
  const pendingTasks = await queryAll(`
    SELECT DISTINCT ON (t.id) t.id task_id, o.scheduled_at
      FROM link_import_tasks t
      JOIN link_import_operations o ON o.task_id=t.id
     WHERE t.status='pending'
       AND o.status IN ('pending','retry','paused')
       AND (o.scheduled_at IS NULL OR o.scheduled_at <= NOW())
     ORDER BY t.id, COALESCE(o.scheduled_at,o.created_at) ASC
  `);
  for (const task of pendingTasks) {
    const guardUntil = recoveryGuards.get(task.task_id) || 0;
    if (guardUntil > Date.now()) continue;
    recoveryGuards.set(task.task_id, Date.now() + 15000);
    try {
      const operation = await queryOne(`SELECT id FROM link_import_operations WHERE task_id=$1 AND status IN ('pending','retry','paused') ORDER BY COALESCE(scheduled_at,created_at) ASC LIMIT 1`, [task.task_id]);
      await scheduleNextOperation(task.task_id, task.scheduled_at ? 0 : null, `link-import-recovery-${task.task_id}-${operation?.id || 'unknown'}-${Date.now()}`);
      recovered += 1;
    } catch (error) {
      console.warn(`[LinkImport] pending task recovery skipped for ${task.task_id}: ${error.message}`);
    } finally {
      recoveryGuards.delete(task.task_id);
    }
  }
  return recovered;
}

function startRecoveryWorker() {
  if (recoveryTimer) return;
  recoveryTimer = setInterval(() => {
    recoverPendingOperations().catch(error => console.warn(`[LinkImport] recovery watchdog failed: ${error.message}`));
    dispatchOutboxBatch().catch(error => console.warn(`[LinkImport] outbox dispatcher failed: ${error.message}`));
  }, RECOVERY_INTERVAL_MS);
  recoveryTimer.unref?.();
  recoverPendingOperations().catch(() => {});
  dispatchOutboxBatch().catch(() => {});
}

function stopRecoveryWorker() {
  if (!recoveryTimer) return;
  clearInterval(recoveryTimer);
  recoveryTimer = null;
}

async function updateTaskStatus(userId, taskId, status) {
  if (!['pending', 'paused', 'stopped'].includes(status)) throw new Error('حالة المهمة غير مدعومة');
  const current = await queryOne(`SELECT id,status FROM link_import_tasks WHERE id=$1 AND user_id=$2`, [taskId, userId]);
  if (!current) throw new Error('المهمة غير موجودة');
  const allowed = { pending: new Set(['pending', 'paused', 'stopped']), paused: new Set(['pending', 'paused', 'stopped']), stopped: new Set(['stopped']) };
  if (!allowed[current.status]?.has(status)) throw new Error(`انتقال المهمة من ${current.status} إلى ${status} غير مسموح`);
  const task = await queryOne(`UPDATE link_import_tasks SET status=$1,updated_at=NOW() WHERE id=$2 AND user_id=$3 RETURNING *`, [status, taskId, userId]);
  if (status === 'stopped') await query(`UPDATE link_import_operations SET status='skipped',current_stage='failed',completed_at=NOW(),lease_expires_at=NULL,heartbeat_at=NOW(),updated_at=NOW(),last_error='تم إيقاف المهمة يدويًا',error_code='TASK_STOPPED' WHERE task_id=$1 AND status IN ('pending','retry','paused')`, [taskId]);
  await recordEvent({ userId, taskId, eventType: `task_${status}`, payload: {} });
  if (status === 'pending') await scheduleNextOperation(taskId);
  await maybeCompleteTask(taskId);
  return task;
}

async function processOperationCore({ operationId, accountId, linkId, jobId = null, workerId = null }) {
  const operation = await queryOne(`SELECT o.id operation_id,o.task_id,o.user_id,o.account_id,o.link_id,o.status operation_status,o.current_stage,o.join_status,o.membership_state,o.verification_evidence,o.publish_status,o.leave_status,o.group_id,o.joined_by_operation,o.cycle_id,o.attempt_count,o.last_error,o.join_started_at,o.join_completed_at,o.publish_started_at,o.publish_completed_at,o.leave_started_at,o.leave_completed_at,o.wait_started_at,o.wait_completed_at,t.status task_status,COALESCE(s.automation_enabled,TRUE) automation_enabled,t.workflow_mode,t.ad_library_ids,t.ad_payloads,t.wait_after_join_seconds,t.wait_after_publish_seconds,t.wait_after_leave_seconds,t.leave_enabled,t.max_retries,t.retry_backoff_seconds,t.min_delay_seconds,t.cycle_limit,t.cycle_duration_minutes,t.auto_resume,l.canonical_url url FROM link_import_operations o JOIN link_import_tasks t ON t.id=o.task_id LEFT JOIN join_automation_settings s ON s.user_id=t.user_id JOIN link_import_links l ON l.id=o.link_id WHERE o.id=$1`, [operationId]);
  if (!operation) {
    console.warn(`[LinkImport] JOB_RECEIVED but operation not found: job=${jobId || 'unknown'} operation=${operationId}`);
    return;
  }
  if (['success','failed','skipped','review'].includes(operation.operation_status)) return;
  await recordEvent({ userId: operation.user_id, taskId: operation.task_id, operationId, accountId, linkId, eventType: 'job_received', payload: { jobId, workerId } });
  await query(`UPDATE link_import_operations SET queue_job_id=COALESCE($1,queue_job_id),worker_id=$2,heartbeat_at=NOW(),updated_at=NOW() WHERE id=$3 AND status NOT IN ('success','failed','skipped','review')`, [jobId, workerId, operationId]).catch(() => {});
  await recordEvent({ userId: operation.user_id, taskId: operation.task_id, operationId, accountId, linkId, eventType: 'job_started', payload: { jobId, workerId } });
  if (operation.task_status === 'stopped') {       await query(`UPDATE link_import_operations SET status='skipped',current_stage='failed',completed_at=NOW(),updated_at=NOW() WHERE id=$1`, [operationId]); await updateDiscoveredLinkState(linkId, 'review', 'review', operationId, 'تم إيقاف المهمة يدويًا'); await maybeCompleteTask(operation.task_id); return { outcome: 'cancelled', reason: 'task_stopped', operationId }; }
  if (operation.task_status === 'paused' || operation.automation_enabled === false) { await query(`UPDATE link_import_operations SET status='paused',next_run_at=NULL,updated_at=NOW() WHERE id=$1 AND status IN ('pending','retry','processing')`, [operationId]); await recordEvent({ userId: operation.user_id, taskId: operation.task_id, operationId, accountId, linkId, eventType: 'operation_paused', payload: { reason: operation.automation_enabled === false ? 'emergency_stop' : 'task_paused' } }).catch(() => {}); return { outcome: 'paused', reason: operation.automation_enabled === false ? 'emergency_stop' : 'task_paused', operationId }; }

  await recordEvent({ userId: operation.user_id, taskId: operation.task_id, operationId, accountId, linkId, eventType: 'account_selected', payload: { accountId } });
  const account = await queryOne(`SELECT a.id,a.status,a.health_status,a.task_status,COALESCE(g.circuit_state,'CLOSED') AS circuit_state,g.reason_code,g.reason FROM accounts a LEFT JOIN link_import_account_guards g ON g.account_id=a.id WHERE a.id=$1 AND a.user_id=$2`, [accountId, operation.user_id]);
  const accountUnavailable = !account || account.status !== 'connected' || ['protected','blocked'].includes(account.health_status) || account.task_status === 'stopped' || account.circuit_state === 'OPEN';
  if (accountUnavailable) {
    const reason = !account ? 'الحساب غير موجود' : account.status === 'banned' || account.circuit_state === 'OPEN'
      ? `الحساب محمي/محظور (${account.reason_code || 'CIRCUIT_OPEN'}) ويحتاج مراجعة`
      : ['protected','blocked'].includes(account.health_status) || account.task_status === 'stopped'
        ? 'الحساب محمي أو موقوف ويحتاج مراجعة'
        : 'الحساب غير متصل ويحتاج مراجعة';
    await query(`UPDATE link_import_operations SET status='review',current_stage='failed',join_status='review',last_error=$1,error_code=$2,completed_at=NOW(),lease_expires_at=NULL,heartbeat_at=NOW(),updated_at=NOW() WHERE task_id=$3 AND account_id=$4 AND status IN ('pending','retry','processing')`, [reason, account?.status === 'banned' ? 'ACCOUNT_BANNED' : account?.circuit_state === 'OPEN' ? 'ACCOUNT_CIRCUIT_OPEN' : 'ACCOUNT_UNAVAILABLE', operation.task_id, accountId]);
    await updateDiscoveredLinkState(linkId, 'review', 'review', operationId, reason);
    await recordEvent({ userId: operation.user_id, taskId: operation.task_id, operationId, accountId, linkId, eventType: 'account_unavailable', payload: { reason } });
    await maybeCompleteTask(operation.task_id);
    await scheduleNextOperation(operation.task_id, 0, null, accountId);
    return;
  }
  const lock = await acquireAccountLock(accountId);
  if (!lock) {
    await requestReschedule({ operationId, accountId, taskId: operation.task_id, linkId, delaySeconds: Math.max(30, Number(operation.min_delay_seconds || 60)), reason: 'account_lock', eventType: 'lock_deferred', jobId: `link-import-op-${operationId}` });
    return;
  }
  try {
    const startsJoin = !operation.current_stage || ['pending', 'joining'].includes(operation.current_stage);
    if (startsJoin) {
      const accountCooldown = await getAccountJoinCooldown(accountId, operation.min_delay_seconds);
      if (accountCooldown > 0) {
        await deferForAccountPacing({ operation, delaySeconds: accountCooldown });
        return;
      }
    }
    await query(`UPDATE link_import_operations SET heartbeat_at=NOW(),lease_expires_at=NOW()+INTERVAL '2 minutes',next_run_at=NULL,updated_at=NOW() WHERE id=$1 AND status NOT IN ('success','failed','skipped','review')`, [operationId]);
    const adPayloads = parseJSON(operation.ad_payloads, []);
    const workflowMode = operation.workflow_mode || 'join_only';
    const waitAfterJoin = clampSeconds(operation.wait_after_join_seconds, 0);
    const waitAfterPublish = clampSeconds(operation.wait_after_publish_seconds, 0);
    const waitAfterLeave = clampSeconds(operation.wait_after_leave_seconds, 0);
    const leaveEnabled = Boolean(operation.leave_enabled);

    if (!operation.current_stage || operation.current_stage === 'pending' || operation.current_stage === 'joining') {
      const inviteCode = getGroupJoinerService()._extractInviteCode(operation.url);
      if (!inviteCode) {
        await failOperation(operation, 'link', 'رابط دعوة واتساب غير صالح', 'failed');
        return;
      }
      await recordEvent({ userId: operation.user_id, taskId: operation.task_id, operationId, accountId, linkId, eventType: 'link_resolved', payload: { inviteCodeLength: inviteCode.length } });
      await setStage(operationId, 'joining', { status: 'processing', join_started_at: new Date(), attempt_count: Number(operation.attempt_count || 0) + 1 });
      await updateDiscoveredLinkState(linkId, 'processing', 'processing', operationId);
      metrics.recordJoinStarted(accountId);
      await recordEvent({ userId: operation.user_id, taskId: operation.task_id, operationId, accountId, linkId, eventType: 'join_started', payload: { url: operation.url } });
      await recordEvent({ userId: operation.user_id, taskId: operation.task_id, operationId, accountId, linkId, eventType: 'join_request_started', payload: { jobId, workerId } });
      let result;
      try { result = await withOperationHeartbeat(operationId, withTimeout(getGroupJoinerService()._doJoin(accountId, operation.url), 90_000, 'انتهت مهلة تنفيذ طلب الانضمام من WhatsApp')); } catch (error) { result = { success: false, status: 'retry', retryable: error.retryable !== false, error: error.message, errorCode: error.code || 'JOIN_EXECUTION_ERROR' }; }
      await query(`UPDATE link_import_operations SET result=$1::jsonb,updated_at=NOW() WHERE id=$2`, [JSON.stringify({ status: result.status || null, success: Boolean(result.success), confirmed: Boolean(result.confirmed), verificationPending: Boolean(result.verificationPending), verificationReason: result.verificationReason || null, groupId: result.groupId || null, errorCode: result.errorCode || null, error: result.error || null }), operationId]).catch(() => {});
      if (result.success || result.status === 'pending_approval') metrics.recordJoinCompleted(accountId, result.status === 'pending_approval' ? 'PENDING_APPROVAL' : result.status === 'already_joined' ? 'ALREADY_MEMBER' : result.confirmed ? 'JOINED' : 'JOINED_UNVERIFIED');
      else metrics.recordJoinFailed(accountId, result.errorCode || result.status || 'UNKNOWN');
      await recordEvent({ userId: operation.user_id, taskId: operation.task_id, operationId, accountId, linkId, eventType: 'join_result_received', payload: { status: result.status, success: Boolean(result.success), confirmed: Boolean(result.confirmed), verificationPending: Boolean(result.verificationPending), errorCode: result.errorCode || null, error: result.error || null } });
      const membershipState = result.status === 'already_joined'
        ? 'ALREADY_MEMBER'
        : result.status === 'pending_approval'
          ? 'JOIN_PENDING'
          : result.success
            ? (result.confirmed ? 'JOINED' : 'JOINED_UNVERIFIED')
            : 'UNKNOWN';
      const verificationEvidence = {
        confirmed: Boolean(result.confirmed),
        verificationPending: Boolean(result.verificationPending),
        verificationReason: result.verificationReason || null,
        groupId: result.groupId || null,
        selfJid: result.selfJid || null,
        verifiedAt: new Date().toISOString(),
        source: result.confirmed ? 'whatsapp_group_metadata' : 'whatsapp_accept_invite',
      };
      await query(`UPDATE link_import_operations SET membership_state=$1,verification_evidence=$2::jsonb,result=jsonb_set(COALESCE(result,'{}'::jsonb),'{membership_state}',$3::jsonb,true),updated_at=NOW() WHERE id=$4`, [membershipState, JSON.stringify(verificationEvidence), JSON.stringify(membershipState), operationId]).catch(() => {});
      const joinedByOperation = result.success && result.status !== 'already_joined';
      await countCycleOperation(operationId, JoinCyclePolicy.resultBucket({ success: result.success, status: result.status }));
      // A successful groupAcceptInvite response is authoritative for the join.
      // Metadata confirmation is retained as evidence, but must not turn a real
      // WhatsApp join into a failed dashboard operation when metadata lags.
      if (result.success) {
        await query(`UPDATE whatsapp_links SET joined=true,status='joined',processing_status='completed',last_status='success',last_error=NULL,last_operation_id=$1,membership_state=$2,joined_by_accounts=(SELECT COALESCE(jsonb_agg(DISTINCT value),'[]'::jsonb) FROM (SELECT value FROM jsonb_array_elements(COALESCE(joined_by_accounts,'[]'::jsonb)) ids(value) UNION ALL SELECT to_jsonb($3::text)) values_list),updated_at=NOW() WHERE id=(SELECT discovered_link_id FROM link_import_links WHERE id=$4)`, [operationId, membershipState, String(accountId), linkId]).catch(() => {});
      }
      if (!result.success) {
        const resultErrorText = `${result.error || ''} ${result.rawError || ''} ${result.status || ''}`.toLowerCase();
        const restrictionDetected = result.status === 'account_restricted'
          || /account[_ -]?reachout[_ -]?restricted|reachout[_ -]?restricted|forbidden|not-authorized|unauthorized|permission|blocked|banned/.test(resultErrorText);
        const classified = restrictionDetected
          ? { status: 'account_restricted', errorCode: result.errorCode || 'ACCOUNT_RESTRICTED', retryable: false }
          : LinkUrlProcessingService.classifyJoinError(result.error || result.status);
        const protectedAccount = ['account_restricted', 'account_error', 'rate_limited'].includes(classified.status || result.status) && classified.retryable === false;
        if (protectedAccount) {
          const protectionCode = (classified.status || result.status) === 'rate_limited' ? 'ACCOUNT_RATE_LIMITED' : 'ACCOUNT_RESTRICTED';
          await query(`UPDATE accounts SET health_status='protected',task_status='stopped',updated_at=NOW() WHERE id=$1`, [accountId]);
          await query(`UPDATE link_import_operations SET status='review',current_stage='failed',join_status='review',last_error=$1,error_code=$2,completed_at=NOW(),lease_expires_at=NULL,heartbeat_at=NOW(),updated_at=NOW() WHERE task_id=$3 AND account_id=$4 AND status IN ('pending','retry','processing')`, [result.error || 'تم إيقاف الحساب للحماية', protectionCode, operation.task_id, accountId]);
          await updateDiscoveredLinkState(linkId, 'review', 'review', operationId, result.error || 'تم إيقاف الحساب للحماية');
          await countCycleOperation(operationId, 'FAILED').catch(() => {});
          metrics.recordProtection(accountId, protectionCode);
          await recordEvent({ userId: operation.user_id, taskId: operation.task_id, operationId, accountId, linkId, eventType: 'account_protection_triggered', payload: { reason: result.error || 'account_restricted', protectionCode } });
          await maybeCompleteTask(operation.task_id);
          await scheduleNextOperation(operation.task_id, 0, null, accountId);
          return;
        }
        if (result.retryable && Number(operation.attempt_count || 0) < Number(operation.max_retries || 0)) {
          const retryBackoffSeconds = Math.max(1, Math.min(3600, Number(operation.retry_backoff_seconds || 15)));
          await query(`UPDATE link_import_operations SET status='retry',current_stage='joining',last_error=$1,error_code=$2,next_retry_at=NOW()+($3 * INTERVAL '1 second'),lease_expires_at=NULL,heartbeat_at=NOW(),updated_at=NOW() WHERE id=$4`, [result.error || 'خطأ مؤقت أثناء الانضمام', classified.errorCode || 'TRANSIENT_JOIN_ERROR', retryBackoffSeconds, operationId]);
          await updateDiscoveredLinkState(linkId, 'deferred', 'deferred', operationId, result.error || 'خطأ مؤقت أثناء الانضمام');
          metrics.recordRetry(accountId, classified.errorCode || 'TRANSIENT_JOIN_ERROR');
          await recordEvent({ userId: operation.user_id, taskId: operation.task_id, operationId, accountId, linkId, eventType: 'join_retry', payload: { error: result.error } });
          await requestReschedule({ operationId, accountId, taskId: operation.task_id, linkId, delaySeconds: retryBackoffSeconds, reason: 'transient_join_error', eventType: 'retry_scheduled', jobId: `link-import-op-${operationId}` });
          return;
        }
        if (result.status === 'pending_approval') {
          await query(`UPDATE link_import_operations SET status='success',current_stage='completed',join_status='pending_approval',last_error=$1,error_code='JOIN_REQUEST_SENT',result=jsonb_build_object('status','JOIN_REQUEST_SENT','success',true,'error',$1),completed_at=NOW(),lease_expires_at=NULL,heartbeat_at=NOW(),updated_at=NOW() WHERE id=$2 AND status NOT IN ('success','failed','skipped','review')`, [result.error || 'تم إرسال طلب الانضمام بانتظار موافقة المشرف', operationId]);
          await updateDiscoveredLinkState(linkId, 'completed', 'pending_approval', operationId, result.error || 'تم إرسال طلب الانضمام بانتظار موافقة المشرف');
          await recordEvent({ userId: operation.user_id, taskId: operation.task_id, operationId, accountId, linkId, eventType: 'join_request_sent', payload: { result: 'JOIN_REQUEST_SENT', error: result.error || null } });
          await countCycleOperation(operationId, JoinCyclePolicy.resultBucket({ success: false, status: result.status }));
          await maybeCompleteTask(operation.task_id);
          await scheduleNextOperation(operation.task_id, null, null, accountId);
          return;
        }
        await failOperation(operation, 'join', result.error || 'فشل الانضمام', 'failed');
        return;
      }
      const nextAfterJoin = workflowMode === 'staged' ? 'publishing' : (leaveEnabled && joinedByOperation ? 'leaving' : 'completed');
      const joinStage = waitAfterJoin ? 'wait_after_join' : nextAfterJoin;
      await query(`UPDATE link_import_operations SET status='processing',current_stage=$1,join_status='success',group_id=$2,joined_by_operation=$3,join_completed_at=NOW(),stage_updated_at=NOW(),updated_at=NOW() WHERE id=$4`, [joinStage, result.groupId || null, joinedByOperation, operationId]);
      await recordEvent({ userId: operation.user_id, taskId: operation.task_id, operationId, accountId, linkId, eventType: 'join_completed', payload: { status: result.status, groupId: result.groupId || null, joinedByOperation } });
      operation.current_stage = joinStage;
      operation.group_id = result.groupId || null;
      operation.joined_by_operation = joinedByOperation;
      if (waitAfterJoin) {
        await waitAndContinue({ ...operation, operation_id: operationId, task_id: operation.task_id, user_id: operation.user_id, account_id: accountId, link_id: linkId }, 'wait_after_join', waitAfterJoin, nextAfterJoin);
        return;
      }
    }

    if (await pauseIfRequested({ ...operation, operation_status: 'processing' })) return;

    if (operation.current_stage === 'wait_after_join') {
      const nextAfterJoin = workflowMode === 'staged' ? 'publishing' : (leaveEnabled && operation.joined_by_operation ? 'leaving' : 'completed');
      await query(`UPDATE link_import_operations SET wait_completed_at=NOW(),current_stage=$1,stage_updated_at=NOW(),updated_at=NOW() WHERE id=$2`, [nextAfterJoin, operationId]);
      await recordEvent({ userId: operation.user_id, taskId: operation.task_id, operationId, accountId, linkId, eventType: 'wait_completed', payload: { stage: 'after_join' } });
      operation.current_stage = nextAfterJoin;
    }

    if (operation.current_stage === 'publishing') {
      if (workflowMode !== 'staged') {
        operation.current_stage = leaveEnabled && operation.joined_by_operation ? 'leaving' : 'completed';
      } else if (!operation.group_id) {
        await failOperation(operation, 'publish', 'تعذر تحديد المجموعة بعد الانضمام', 'review');
        return;
      } else {
        await query(`UPDATE link_import_operations SET publish_started_at=NOW(),publish_status='processing',status='processing',updated_at=NOW() WHERE id=$1`, [operationId]);
        await recordEvent({ userId: operation.user_id, taskId: operation.task_id, operationId, accountId, linkId, eventType: 'publish_started', payload: { adCount: adPayloads.length } });
        const result = await publishAds({ accountId, groupId: operation.group_id, adPayloads, taskId: operation.task_id });
        if (!result.success) {
          const publishError = result.results.find(item => item.status === 'failed')?.error || 'فشل نشر الإعلان';
          const nextAfterPublishFailure = leaveEnabled && operation.joined_by_operation ? 'leaving' : 'failed';
          await query(`UPDATE link_import_operations SET publish_status='failed',current_stage=$1,last_error=$2,updated_at=NOW() WHERE id=$3`, [nextAfterPublishFailure, publishError, operationId]);
          await recordEvent({ userId: operation.user_id, taskId: operation.task_id, operationId, accountId, linkId, eventType: 'publish_failed', payload: { results: result.results } });
          operation.current_stage = nextAfterPublishFailure;
          if (nextAfterPublishFailure === 'failed') { await failOperation(operation, 'publish', publishError, 'review'); return; }
        } else {
          const nextAfterPublish = leaveEnabled && operation.joined_by_operation ? 'leaving' : 'completed';
          const publishStage = waitAfterPublish ? 'wait_after_publish' : nextAfterPublish;
          await query(`UPDATE link_import_operations SET publish_status='success',publish_completed_at=NOW(),current_stage=$1,stage_updated_at=NOW(),updated_at=NOW() WHERE id=$2`, [publishStage, operationId]);
          await recordEvent({ userId: operation.user_id, taskId: operation.task_id, operationId, accountId, linkId, eventType: 'publish_completed', payload: { results: result.results } });
          operation.current_stage = publishStage;
          if (waitAfterPublish) {
            await waitAndContinue({ ...operation, operation_id: operationId, task_id: operation.task_id, user_id: operation.user_id, account_id: accountId, link_id: linkId }, 'wait_after_publish', waitAfterPublish, nextAfterPublish);
            return;
          }
        }
      }
    }

    if (await pauseIfRequested({ ...operation, operation_status: 'processing' })) return;

    if (operation.current_stage === 'wait_after_publish') {
      const nextAfterPublish = leaveEnabled && operation.joined_by_operation ? 'leaving' : 'completed';
      await query(`UPDATE link_import_operations SET wait_completed_at=NOW(),current_stage=$1,stage_updated_at=NOW(),updated_at=NOW() WHERE id=$2`, [nextAfterPublish, operationId]);
      await recordEvent({ userId: operation.user_id, taskId: operation.task_id, operationId, accountId, linkId, eventType: 'wait_completed', payload: { stage: 'after_publish' } });
      operation.current_stage = nextAfterPublish;
    }

    if (operation.current_stage === 'leaving') {
      if (!leaveEnabled || !operation.joined_by_operation || !operation.group_id) {
        await query(`UPDATE link_import_operations SET leave_status='skipped',current_stage='completed',updated_at=NOW() WHERE id=$1`, [operationId]);
        operation.current_stage = 'completed';
      } else {
        await query(`UPDATE link_import_operations SET leave_status='processing',leave_started_at=NOW(),status='processing',updated_at=NOW() WHERE id=$1`, [operationId]);
        await recordEvent({ userId: operation.user_id, taskId: operation.task_id, operationId, accountId, linkId, eventType: 'leave_started', payload: { groupId: operation.group_id } });
        try {
          const result = await getGroupJoinerService().leaveGroup(accountId, operation.group_id);
          if (!result.success) throw new Error(result.error || 'تعذر الخروج من المجموعة');
          const leaveStage = waitAfterLeave ? 'wait_after_leave' : 'completed';
          await query(`UPDATE link_import_operations SET leave_status='success',leave_completed_at=NOW(),current_stage=$1,stage_updated_at=NOW(),updated_at=NOW() WHERE id=$2`, [leaveStage, operationId]);
          await recordEvent({ userId: operation.user_id, taskId: operation.task_id, operationId, accountId, linkId, eventType: 'leave_completed', payload: { groupId: operation.group_id } });
          operation.current_stage = leaveStage;
          if (waitAfterLeave) {
            await waitAndContinue({ ...operation, operation_id: operationId, task_id: operation.task_id, user_id: operation.user_id, account_id: accountId, link_id: linkId }, 'wait_after_leave', waitAfterLeave, 'completed');
            return;
          }
        } catch (error) {
          await query(`UPDATE link_import_operations SET leave_status='failed',last_error=$1,updated_at=NOW() WHERE id=$2`, [error.message, operationId]);
          await recordEvent({ userId: operation.user_id, taskId: operation.task_id, operationId, accountId, linkId, eventType: 'leave_failed', payload: { error: error.message } });
          await failOperation(operation, 'leave', error.message, 'review');
          return;
        }
      }
    }

    if (operation.current_stage === 'wait_after_leave') {
      await query(`UPDATE link_import_operations SET wait_completed_at=NOW(),current_stage='completed',stage_updated_at=NOW(),updated_at=NOW() WHERE id=$1`, [operationId]);
      await recordEvent({ userId: operation.user_id, taskId: operation.task_id, operationId, accountId, linkId, eventType: 'wait_completed', payload: { stage: 'after_leave' } });
      operation.current_stage = 'completed';
    }

    if (operation.current_stage === 'completed') {
      const finalStatus = operation.join_status === 'failed' || operation.publish_status === 'failed' || operation.leave_status === 'failed' ? 'review' : 'success';
      await query(`UPDATE link_import_operations SET status=$1,current_stage='completed',completed_at=NOW(),next_run_at=NULL,lease_expires_at=NULL,heartbeat_at=NOW(),updated_at=NOW() WHERE id=$2 AND status NOT IN ('success','failed','skipped','review')`, [finalStatus, operationId]);
      await query(`UPDATE link_import_links SET last_status=$1,last_error=$2,updated_at=NOW() WHERE id=$3`, [finalStatus, finalStatus === 'success' ? null : (operation.last_error || 'تحتاج العملية إلى مراجعة'), linkId]);
      await recordEvent({ userId: operation.user_id, taskId: operation.task_id, operationId, accountId, linkId, eventType: 'operation_completed', payload: { workflowMode, finalStatus } });
      await maybeCompleteTask(operation.task_id);
      await scheduleNextOperation(operation.task_id, null, null, accountId);
    }
  } finally {
    await lock.release();
  }
}

async function processOperation(args) {
  const operationId = String(args?.operationId || '');
  if (!operationId) return;
  const lockKey = `whatsapp_join_account:${args.accountId || 'unknown'}`;
  const result = await withAdvisoryLock(lockKey, async () => processOperationCore(args), { wait: false });
  if (result && result.locked === false) {
    await requestReschedule({ operationId, accountId: args.accountId, taskId: args.taskId, linkId: args.linkId, delaySeconds: 30, reason: 'advisory_lock', eventType: 'lock_deferred', jobId: `link-import-op-${operationId}` });
    return { outcome: 'deferred', reason: 'advisory_lock', operationId };
  }
  return { outcome: 'handler_completed', operationId };
}

module.exports = {
  importFile,
  previewFile,
  saveImport,
  importDocx,
  listLinks,
  listImportSources,
  syncImportedLinksToDashboard,
  recordAudit,
  listAuditLogs,
  auditStats,
  getAuditLog,
  createTask,
  scheduleNextOperation,
  advanceCycle,
  taskDashboard,
  updateTaskStatus,
  recoverPendingOperations,
  dispatchOutbox,
  dispatchOutboxBatch,
  startRecoveryWorker,
  stopRecoveryWorker,
  stopAccountOperations,
  processOperation,
  parseDocx,
  parseImportFile,
  parseImportedLinks,
};
