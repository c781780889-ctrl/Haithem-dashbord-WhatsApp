'use strict';

const os = require('os');
const { query, queryOne, queryAll, withTransaction, withAdvisoryLock } = require('../../lib/postgres');
const TelegramService = require('./TelegramService');
const SocketBridge = require('../../core/SocketBridge');

const WORKER_ID = `${os.hostname()}:${process.pid}`;
const JOIN_ROLE = 'JOIN_ROLE';

function asString(value) { return value === undefined || value === null ? null : String(value); }
function isGroupDialog(dialog) { return Boolean(dialog?.isGroup || (dialog?.isChannel && dialog?.entity?.megagroup === true)); }
function groupKey(dialog) { return asString(dialog?.id || dialog?.entity?.id || dialog?.entity?.channelId); }
function publicName(dialog) { return dialog?.title || dialog?.name || dialog?.entity?.title || dialog?.entity?.username || groupKey(dialog); }
function auditPayload(value) { return JSON.stringify(value || {}, (_, item) => /session|token|secret|password|api_hash/i.test(_) ? '[REDACTED]' : item); }
function emit(userId, event, payload) { try { SocketBridge.to(`user:${userId}`).emit(`telegram:membership-review:${event}`, payload); } catch {} }

async function audit({ reviewId, userId, accountId, groupId, action, status, reason, details = {} }) {
  await query(`INSERT INTO telegram_membership_review_audit(review_id,user_id,account_id,group_id,action,status,reason,details,worker_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9)`, [reviewId, userId, accountId || null, groupId || null, action, status, reason || null, auditPayload(details), WORKER_ID]).catch(() => {});
}

const Service = {
  async connectedAccounts(userId) { return queryAll(`SELECT id,name,username,status,automation_role,automation_enabled,created_at FROM telegram_accounts WHERE user_id=$1 AND status='connected' AND automation_role=$2 AND automation_enabled=true ORDER BY created_at ASC,id ASC`, [userId, JOIN_ROLE]); },

  async review({ userId, keepAccountId = null }) {
    const accounts = await this.connectedAccounts(userId);
    const memberships = new Map(); const errors = [];
    for (const account of accounts) {
      const worker = TelegramService.getWorker(account.id);
      if (!worker?.client || String(worker.status).toLowerCase() !== 'running') { errors.push({ accountId: account.id, accountName: account.name, code: 'ACCOUNT_WORKER_NOT_READY' }); continue; }
      try {
        const dialogs = await worker.client.getDialogs({ limit: Number(process.env.TELEGRAM_MEMBERSHIP_REVIEW_DIALOG_LIMIT || 10000) });
        for (const dialog of dialogs || []) {
          if (!isGroupDialog(dialog)) continue;
          const id = groupKey(dialog); if (!id) continue;
          if (!memberships.has(id)) memberships.set(id, { groupId: id, title: publicName(dialog), username: dialog?.entity?.username || null, isSupergroup: Boolean(dialog?.isChannel), accounts: [] });
          memberships.get(id).accounts.push({ accountId: account.id, accountName: account.name, accountCreatedAt: account.created_at });
        }
      } catch (error) { errors.push({ accountId: account.id, accountName: account.name, code: 'DIALOGS_READ_FAILED', message: error.message }); }
    }
    const groups = [...memberships.values()].map(group => {
      const accountsForGroup = [...new Map(group.accounts.map(item => [String(item.accountId), item])).values()];
      const keep = accountsForGroup.find(item => String(item.accountId) === String(keepAccountId)) || accountsForGroup[0];
      return { ...group, accounts: accountsForGroup, duplicate: accountsForGroup.length > 1, keepAccountId: keep?.accountId || null, leaveAccountIds: accountsForGroup.filter(item => String(item.accountId) !== String(keep?.accountId)).map(item => item.accountId) };
    });
    return { generatedAt: new Date().toISOString(), workerId: WORKER_ID, accountsScanned: accounts.length, accountsReady: accounts.length - errors.length, groupsFound: groups.length, duplicateGroups: groups.filter(group => group.duplicate).length, errors, groups };
  },

  async execute({ userId, keepAccountId = null, reviewId = null, confirm = false }) {
    if (!confirm) { const error = new Error('يلزم تأكيد صريح قبل تنفيذ الخروج؛ استخدم المعاينة أولًا'); error.code = 'CONFIRMATION_REQUIRED'; error.statusCode = 400; throw error; }
    const review = await this.review({ userId, keepAccountId });
    const created = await queryOne(`INSERT INTO telegram_membership_reviews(user_id,status,keep_account_id,summary,started_at,worker_id) VALUES($1,'RUNNING',$2,$3::jsonb,NOW(),$4) RETURNING id`, [userId, keepAccountId || null, auditPayload({ accountsScanned: review.accountsScanned, groupsFound: review.groupsFound, duplicateGroups: review.duplicateGroups })]);
    const reviewIdValue = reviewId || created?.id;
    const results = [];
    for (const group of review.groups.filter(item => item.duplicate)) {
      await withAdvisoryLock(`telegram-membership-review:${group.groupId}`, async () => {
        for (const accountId of group.leaveAccountIds) {
          const worker = TelegramService.getWorker(accountId); const account = review.groups.find(item => item.groupId === group.groupId)?.accounts.find(item => String(item.accountId) === String(accountId));
          if (!worker?.client || String(worker.status).toLowerCase() !== 'running') { results.push({ groupId: group.groupId, accountId, status: 'FAILED', reason: 'ACCOUNT_WORKER_NOT_READY' }); await audit({ reviewId: reviewIdValue, userId, accountId, groupId: group.groupId, action: 'LEAVE', status: 'FAILED', reason: 'ACCOUNT_WORKER_NOT_READY' }); continue; }
          try {
            const dialogs = await worker.client.getDialogs({ limit: Number(process.env.TELEGRAM_MEMBERSHIP_REVIEW_DIALOG_LIMIT || 10000) });
            const dialog = (dialogs || []).find(item => groupKey(item) === String(group.groupId) && isGroupDialog(item));
            if (!dialog) { results.push({ groupId: group.groupId, accountId, status: 'SKIPPED', reason: 'GROUP_NOT_FOUND' }); continue; }
            const { Api } = require('telegram');
            if (dialog.isChannel && dialog.entity?.megagroup === true) await worker.client.invoke(new Api.channels.LeaveChannel({ channel: await worker.client.getInputEntity(dialog.entity) }));
            else if (dialog.isGroup) await worker.client.invoke(new Api.messages.DeleteChatUser({ chatId: BigInt(String(dialog.id)), userId: await worker.client.getInputEntity('me') }));
            else { results.push({ groupId: group.groupId, accountId, status: 'SKIPPED', reason: 'NOT_SUPPORTED_GROUP_TYPE' }); continue; }
            results.push({ groupId: group.groupId, title: group.title, accountId, accountName: account?.accountName || null, status: 'LEFT' });
            await audit({ reviewId: reviewIdValue, userId, accountId, groupId: group.groupId, action: 'LEAVE', status: 'LEFT', reason: 'DUPLICATE_MEMBERSHIP', details: { title: group.title, keptAccountId: group.keepAccountId } });
            emit(userId, 'left', { reviewId: reviewIdValue, groupId: group.groupId, accountId, keptAccountId: group.keepAccountId });
          } catch (error) { results.push({ groupId: group.groupId, accountId, status: 'FAILED', reason: error.message }); await audit({ reviewId: reviewIdValue, userId, accountId, groupId: group.groupId, action: 'LEAVE', status: 'FAILED', reason: error.message }); }
        }
      }, { wait: false });
    }
    const summary = { ...review, results, left: results.filter(item => item.status === 'LEFT').length, failed: results.filter(item => item.status === 'FAILED').length, skipped: results.filter(item => item.status === 'SKIPPED').length };
    await query(`UPDATE telegram_membership_reviews SET status=$1,summary=$2::jsonb,completed_at=NOW() WHERE id=$3`, [summary.failed ? 'PARTIAL' : 'COMPLETED', auditPayload(summary), reviewIdValue]).catch(() => {});
    return { reviewId: reviewIdValue, ...summary };
  },

  async history(userId, limit = 20) { return queryAll(`SELECT id,status,keep_account_id,summary,started_at,completed_at,worker_id FROM telegram_membership_reviews WHERE user_id=$1 ORDER BY started_at DESC LIMIT $2`, [userId, Math.min(100, Math.max(1, Number(limit) || 20))]); },
};

module.exports = Service;
