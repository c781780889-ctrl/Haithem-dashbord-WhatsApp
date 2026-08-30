'use strict';

const { query, queryOne, queryAll } = require('../../lib/postgres');
const TelegramService = require('./TelegramService');
const SocketBridge = require('../../core/SocketBridge');

const WA_LINK_PATTERN = /https?:\/\/(?:chat\.whatsapp\.com|wa\.me|api\.whatsapp\.com\/send)[^\s\])"'>]*/gi;

function extractText(message) {
  const body = message?.message || message || {};
  return String(body.conversation || body.extendedTextMessage?.text || body.imageMessage?.caption || body.videoMessage?.caption || body.documentMessage?.caption || body.buttonsResponseMessage?.selectedDisplayText || body.listResponseMessage?.title || '').trim();
}

function emitToUser(userId, event, payload = {}) {
  try { SocketBridge.to(`user:${userId}`).emit(event, { ...payload, userId }); } catch (_) {}
}

async function recordEvent({ userId, discoveryJobId, eventType, payload = {} }) {
  try {
    await query(
      `INSERT INTO link_import_events (user_id,event_type,payload) VALUES ($1,$2,$3::jsonb)`,
      [userId, eventType, JSON.stringify({ discoveryJobId, ...payload })],
    );
  } catch (error) {
    // Event logging is observability only. A missing/temporarily unavailable
    // event table must never cancel a real discovery job.
    console.warn(`[LinkDiscovery] event log skipped for job ${discoveryJobId}: ${error.message}`);
  }
}

async function updateJob(discoveryJobId, status, extra = {}) {
  const fields = ['status=$1', 'updated_at=NOW()'];
  const values = [status];
  let index = 2;
  if (extra.messagesScanned !== undefined) { fields.push(`messages_scanned=$${index++}`); values.push(extra.messagesScanned); }
  if (extra.foundCount !== undefined) { fields.push(`found_count=$${index++}`); values.push(extra.foundCount); }
  if (extra.error !== undefined) { fields.push(`error=$${index++}`); values.push(extra.error); }
  if (extra.completed) fields.push('completed_at=NOW()');
  values.push(discoveryJobId);
  await query(`UPDATE join_automation_discovery_jobs SET ${fields.join(',')} WHERE id=$${index}`, values);
}

async function isStopped(discoveryJobId) {
  if (!discoveryJobId) return false;
  const row = await queryOne(`SELECT status FROM join_automation_discovery_jobs WHERE id=$1`, [discoveryJobId]);
  return row?.status === 'stopped';
}

async function ownedSources({ userId, sourceAccountIds, isAdmin = false }) {
  const ids = [...new Set((sourceAccountIds || []).map(String).filter(Boolean))];
  if (!ids.length) throw new Error('حدد حساب واتساب واحدًا على الأقل للبحث');
  const sources = await queryAll(
    `SELECT id,name,phone_number,status,health_status,task_status,last_activity_at
       FROM accounts
      WHERE id=ANY($1::uuid[]) AND ($2::boolean OR user_id=$3)`,
    [ids, isAdmin, userId],
  );
  if (sources.length !== ids.length) throw new Error('يوجد حساب غير مملوك للمستخدم الحالي');
  return sources;
}

async function scanStoredMessages({ userId, source, isAdmin = false }) {
  const storedMessages = await queryAll(
    `SELECT message_id,message_text,remote_jid,chat_name,is_group,message_time
       FROM kw_messages
      WHERE account_id=$1 AND ($2::boolean OR user_id=$3)
        AND NULLIF(BTRIM(message_text),'') IS NOT NULL
      ORDER BY message_time ASC NULLS LAST, created_at ASC`,
    [source.id, isAdmin, userId],
  );
  // Include messages already accepted by the durable inbox but not processed
  // by KeywordMonitoringService yet. This closes the race where a search runs
  // immediately after delivery and kw_messages has not been populated.
  const queuedMessages = await queryAll(
    `SELECT message_id,payload FROM kw_event_queue
      WHERE account_id=$1 AND ($2::boolean OR user_id=$3)
        AND status IN ('received','retry','processing')
      ORDER BY created_at ASC`,
    [source.id, isAdmin, userId],
  );
  const seenIds = new Set(storedMessages.map(message => String(message.message_id || '')).filter(Boolean));
  const messages = [...storedMessages];
  for (const queued of queuedMessages) {
    let payload;
    try { payload = typeof queued.payload === 'string' ? JSON.parse(queued.payload) : queued.payload; }
    catch (error) { console.warn(`[LinkDiscovery] skipped malformed queued message ${queued.message_id}: ${error.message}`); continue; }
    const id = String(queued.message_id || payload?.key?.id || '');
    if (!id || seenIds.has(id)) continue;
    const remote = String(payload?.key?.remoteJid || '');
    messages.push({
      message_id: id,
      message_text: extractText(payload),
      remote_jid: remote,
      chat_name: payload?.pushName || null,
      is_group: remote.endsWith('@g.us'),
      message_time: payload?.messageTimestamp ? new Date(Number(payload.messageTimestamp) * 1000) : null,
    });
    seenIds.add(id);
  }

  let linksFound = 0;
  let linksSaved = 0;
  for (const message of messages) {
    const rawLinks = String(message.message_text || extractText(message.payload) || '').match(WA_LINK_PATTERN) || [];
    linksFound += rawLinks.length;
    const sourceGroup = message.is_group
      ? String(message.chat_name || message.remote_jid || 'مجموعة واتساب')
      : String(message.chat_name || 'محادثة خاصة');

    for (const raw of rawLinks) {
      const link = raw.trim().replace(/[.,;:!?'")\]}]+$/, '');
      if (!link) continue;
      const result = await TelegramService.saveLink({
        whatsapp_link: link,
        source_account_id: source.id,
        source_account_name: source.name,
        source_group: sourceGroup,
      });
      if (!result.isDuplicate && !result.ignored) linksSaved += 1;
    }
  }

  return {
    accountId: source.id,
    accountName: source.name,
    messagesScanned: messages.length,
    linksFound,
    linksSaved,
  };
}

async function scan({ userId, sourceAccountIds, isAdmin = false, discoveryJobId }) {
  const sources = await ownedSources({ userId, sourceAccountIds, isAdmin });
  const results = [];
  for (const source of sources) {
    if (await isStopped(discoveryJobId)) break;
    try {
      results.push({ ...(await scanStoredMessages({ userId, source, isAdmin })), status: 'completed' });
    } catch (error) {
      results.push({ accountId: source.id, accountName: source.name, status: 'failed', error: error.message });
    }
  }
  return results;
}

async function processJob({ discoveryJobId, userId, sourceAccountIds, isAdmin = false }) {
  await updateJob(discoveryJobId, 'running');
  await recordEvent({ userId, discoveryJobId, eventType: 'discovery_started', payload: { sourceAccountIds } });
  emitToUser(userId, 'join_automation:search_started', { discoveryJobId, sourceAccountIds });

  try {
    const results = await scan({ userId, sourceAccountIds, isAdmin, discoveryJobId });
    const messagesScanned = results.reduce((sum, item) => sum + Number(item.messagesScanned || 0), 0);
    const foundCount = results.reduce((sum, item) => sum + Number(item.linksFound || 0), 0);
    const stopped = await isStopped(discoveryJobId);
    const failed = results.filter(item => item.status === 'failed');
    const status = stopped ? 'stopped' : 'completed';
    const error = failed.length ? failed.map(item => `${item.accountName}: ${item.error}`).join(' | ').slice(0, 2000) : null;

    await updateJob(discoveryJobId, status, { messagesScanned, foundCount, error, completed: true });
    await recordEvent({ userId, discoveryJobId, eventType: stopped ? 'discovery_stopped' : 'discovery_completed', payload: { sourceAccountIds, messagesScanned, foundCount, results, error } });
    emitToUser(userId, 'join_automation:search_complete', { discoveryJobId, status, messagesScanned, foundCount, results, error });
    return { discoveryJobId, status, messagesScanned, foundCount, results, error };
  } catch (error) {
    await updateJob(discoveryJobId, 'failed', { error: error.message, completed: true }).catch(updateError => console.error(`[LinkDiscovery] failed to update job ${discoveryJobId}: ${updateError.message}`));
    await recordEvent({ userId, discoveryJobId, eventType: 'discovery_failed', payload: { error: error.message } });
    emitToUser(userId, 'join_automation:search_failed', { discoveryJobId, error: error.message });
    throw error;
  }
}

async function stop({ userId, sourceAccountIds, isAdmin = false }) {
  const ids = sourceAccountIds?.length
    ? [...new Set(sourceAccountIds.map(String).filter(Boolean))]
    : (await queryAll(`SELECT id FROM accounts ${isAdmin ? '' : 'WHERE user_id=$1'}`, isAdmin ? [] : [userId])).map(item => String(item.id));
  await ownedSources({ userId, sourceAccountIds: ids, isAdmin });
  const jobs = await queryAll(`SELECT id,source_account_ids FROM join_automation_discovery_jobs WHERE user_id=$1 AND status IN ('queued','running') ORDER BY created_at DESC`, [userId]);
  const selected = new Set(ids);
  let stopped = 0;
  for (const job of jobs) {
    const jobIds = Array.isArray(job.source_account_ids) ? job.source_account_ids.map(String) : [];
    if (!jobIds.length || jobIds.some(id => selected.has(id))) {
      await updateJob(job.id, 'stopped', { completed: true });
      await recordEvent({ userId, discoveryJobId: job.id, eventType: 'discovery_stop_requested', payload: { sourceAccountIds: ids } });
      stopped += 1;
    }
  }
  return { stopped };
}

module.exports = { ownedSources, scan, stop, scanStoredMessages, processJob, isStopped };
