'use strict';

const { queryOne, queryAll } = require('../../lib/postgres');
const QueueManager = require('../../lib/QueueManager');
const TelegramService = require('./TelegramService');

async function getHealth({ userId, isAdmin = false }) {
  const components = {};
  let critical = false;
  let degraded = false;
  try { await queryOne('SELECT 1 AS ok'); components.database = { status: 'healthy' }; } catch (error) { components.database = { status: 'critical', error: error.message }; critical = true; }
  try {
    const queueStats = await QueueManager.getStats();
    const queueError = Object.values(queueStats || {}).some(item => item?.error);
    components.queue = { status: queueError ? 'degraded' : 'healthy', running: Boolean(QueueManager._isRunning), stats: queueStats };
    if (queueError || !QueueManager._isRunning) degraded = true;
  } catch (error) { components.queue = { status: 'degraded', error: error.message }; degraded = true; }
  const workers = TelegramService.getAllWorkersStatus().filter(worker => isAdmin || String(worker.userId || '') === String(userId));
  const workerErrors = workers.filter(worker => worker.status === 'error');
  components.workers = { status: workerErrors.length ? 'degraded' : 'healthy', total: workers.length, active: workers.filter(worker => ['connecting', 'connected'].includes(worker.status)).length, errors: workerErrors.length };
  if (workerErrors.length) degraded = true;
  try {
    const accountScope = isAdmin ? 'TRUE' : 'a.user_id=$1';
    const accountParams = isAdmin ? [] : [userId];
    const account = await queryOne(`SELECT COUNT(*)::int total,COUNT(*) FILTER (WHERE a.status='connected')::int connected,COUNT(*) FILTER (WHERE a.health_status IN ('blocked','protected'))::int protected FROM accounts a WHERE ${accountScope}`, accountParams);
    const accountDetails = await queryAll(`SELECT a.id account_id,a.name account_name,a.phone_number account_phone,a.status account_status,a.health_status,COALESCE(h.status,CASE WHEN a.status='connected' THEN 'connected' ELSE 'disconnected' END) worker_status,h.last_heartbeat,h.last_event_at,h.last_error,COALESCE(h.updated_at,a.updated_at) updated_at FROM accounts a LEFT JOIN kw_service_health h ON h.account_id=a.id WHERE ${accountScope} ORDER BY a.created_at DESC`, accountParams);
    const now = Date.now();
    const details = accountDetails.map(item => {
      const heartbeatAt = item.last_heartbeat || item.updated_at;
      const heartbeatAgeSeconds = heartbeatAt ? Math.max(0, Math.floor((now - new Date(heartbeatAt).getTime()) / 1000)) : null;
      const heartbeatFresh = heartbeatAgeSeconds !== null && heartbeatAgeSeconds <= 30;
      return { ...item, heartbeat_age_seconds: heartbeatAgeSeconds, heartbeat_fresh: heartbeatFresh };
    });
    components.accounts = { status: Number(account?.protected || 0) > 0 ? 'degraded' : 'healthy', total: Number(account?.total || 0), connected: Number(account?.connected || 0), protected: Number(account?.protected || 0), details };
    if (Number(account?.protected || 0) > 0 || details.some(item => item.account_status === 'connected' && !item.heartbeat_fresh)) degraded = true;
  } catch (error) { components.accounts = { status: 'degraded', error: error.message, details: [] }; degraded = true; }
  const status = critical ? 'critical' : degraded ? 'degraded' : 'healthy';
  return { status, checkedAt: new Date().toISOString(), components };
}

module.exports = { getHealth };
