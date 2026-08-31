'use strict';

const { query, queryOne, queryAll, withAdvisoryLock } = require('../../lib/postgres');
const TelegramService = require('./TelegramService');
const os = require('os');

const WORKER_ID = `${os.hostname()}:${process.pid}`;
const ROLE = 'JOIN_ROLE';
const limit = () => Math.min(10000, Math.max(100, Number(process.env.TELEGRAM_MEMBERSHIP_RECOVERY_DIALOG_LIMIT || 10000)));
const groupKey = dialog => String(dialog?.id || dialog?.entity?.id || dialog?.entity?.channelId || '');
const isGroup = dialog => Boolean(dialog?.isGroup || (dialog?.isChannel && dialog?.entity?.megagroup === true));
const titleOf = dialog => dialog?.title || dialog?.name || dialog?.entity?.title || dialog?.entity?.username || groupKey(dialog);
const isPrivateInvite = link => /\/\+|\/joinchat\//i.test(String(link || ''));

async function audit(row) {
  await query(`INSERT INTO telegram_membership_recovery_audit(user_id,former_account_id,replacement_account_id,group_id,action,status,reason,details,worker_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9)`, [row.userId, row.formerAccountId || null, row.replacementAccountId || null, row.groupId || null, row.action, row.status, row.reason || null, JSON.stringify(row.details || {}), WORKER_ID]).catch(() => {});
}

async function verify(client, entity) {
  try {
    const participant = typeof client.getParticipant === 'function' ? await client.getParticipant(entity, 'me') : await client.invoke(new (require('telegram').Api.channels.GetParticipant)({ channel: entity, participant: await client.getInputEntity('me') }));
    return Boolean(participant);
  } catch { return false; }
}

const Service = {
  async snapshotAndRecover({ userId, accountId }) {
    const former = await queryOne(`SELECT id,name FROM telegram_accounts WHERE id=$1 AND user_id=$2`, [accountId, userId]);
    if (!former) return { skipped: true, reason: 'ACCOUNT_NOT_FOUND' };
    const stored = await queryAll(`SELECT id,group_id,group_title,group_username,source_link FROM telegram_account_group_memberships WHERE user_id=$1 AND former_account_id=$2 AND status IN ('ACTIVE','SNAPSHOTTED','REJOIN_FAILED') ORDER BY discovered_at ASC`, [userId, accountId]);
    const memberships = stored.map(row => ({ id: row.id, groupId: String(row.group_id), title: row.group_title || String(row.group_id), username: row.group_username || null, sourceLink: row.source_link || null }));
    const formerWorker = TelegramService.getWorker(accountId);
    if (!memberships.length) {
      if (!formerWorker?.client || String(formerWorker.status).toLowerCase() !== 'running') return { skipped: true, reason: 'FORMER_ACCOUNT_WORKER_NOT_READY' };
      const dialogs = await formerWorker.client.getDialogs({ limit: limit() });
      for (const dialog of dialogs || []) {
        if (!isGroup(dialog)) continue;
        const groupId = groupKey(dialog); if (!groupId) continue;
        const global = await queryOne(`SELECT normalized_url,telegram_username,telegram_chat_id FROM telegram_global_join_links WHERE telegram_chat_id=$1 ORDER BY joined_at DESC NULLS LAST LIMIT 1`, [groupId]);
        const row = await queryOne(`INSERT INTO telegram_account_group_memberships(user_id,former_account_id,group_id,group_title,group_username,source_link,status,discovered_at) VALUES($1,$2,$3,$4,$5,$6,'SNAPSHOTTED',NOW()) ON CONFLICT(user_id,former_account_id,group_id) DO UPDATE SET group_title=EXCLUDED.group_title,group_username=COALESCE(EXCLUDED.group_username,telegram_account_group_memberships.group_username),source_link=COALESCE(EXCLUDED.source_link,telegram_account_group_memberships.source_link),updated_at=NOW() RETURNING id`, [userId, accountId, groupId, titleOf(dialog), dialog?.entity?.username || global?.telegram_username || null, global?.normalized_url || null]);
        memberships.push({ id: row?.id || null, groupId, title: titleOf(dialog), username: dialog?.entity?.username || global?.telegram_username || null, sourceLink: global?.normalized_url || null });
      }
    }
    const replacements = await queryAll(`SELECT id,name FROM telegram_accounts WHERE user_id=$1 AND id<>$2 AND status='connected' AND automation_role=$3 AND automation_enabled=true ORDER BY created_at ASC,id ASC`, [userId, accountId, ROLE]);
    const results = [];
    for (const membership of memberships) {
      const result = await withAdvisoryLock(`telegram-membership-recovery:${userId}:${membership.groupId}`, async () => {
        for (const replacement of replacements) {
          const worker = TelegramService.getWorker(replacement.id); if (!worker?.client || String(worker.status).toLowerCase() !== 'running') continue;
          try {
            const { Api } = require('telegram'); let entity;
            if (membership.sourceLink && isPrivateInvite(membership.sourceLink)) await worker.client.invoke(new Api.messages.ImportChatInvite({ hash: membership.sourceLink.match(/(?:\+|joinchat\/)([^/?#]+)/i)?.[1] }));
            else { const identifier = membership.username || membership.sourceLink?.match(/t\.me\/([^/?#]+)/i)?.[1]; if (!identifier) continue; entity = await worker.client.getInputEntity(identifier.replace(/^@/, '')); await worker.client.invoke(new Api.channels.JoinChannel({ channel: entity })); }
            entity = entity || await worker.client.getInputEntity(membership.username || membership.groupId);
            if (!await verify(worker.client, entity)) throw Object.assign(new Error('REJOIN_NOT_VERIFIED'), { code: 'REJOIN_NOT_VERIFIED' });
            await query(`UPDATE telegram_account_group_memberships SET replacement_account_id=$1,status='REJOINED',rejoined_at=NOW(),last_error=NULL,updated_at=NOW() WHERE id=$2`, [replacement.id, membership.id]);
            await audit({ userId, formerAccountId: accountId, replacementAccountId: replacement.id, groupId: membership.groupId, action: 'REJOIN', status: 'REJOINED', reason: 'FORMER_ACCOUNT_REMOVAL', details: { title: membership.title, replacementAccountName: replacement.name } });
            return { groupId: membership.groupId, title: membership.title, replacementAccountId: replacement.id, replacementAccountName: replacement.name, status: 'REJOINED' };
          } catch (error) { await audit({ userId, formerAccountId: accountId, replacementAccountId: replacement.id, groupId: membership.groupId, action: 'REJOIN', status: 'FAILED', reason: error.code || error.message, details: { title: membership.title } }); }
        }
        await query(`UPDATE telegram_account_group_memberships SET status='FAILED',last_error='NO_AVAILABLE_REPLACEMENT_OR_INVITE',updated_at=NOW() WHERE id=$1`, [membership.id]);
        await audit({ userId, formerAccountId: accountId, groupId: membership.groupId, action: 'REJOIN', status: 'FAILED', reason: 'NO_AVAILABLE_REPLACEMENT_OR_INVITE', details: { title: membership.title } });
        return { groupId: membership.groupId, title: membership.title, status: 'FAILED', reason: 'NO_AVAILABLE_REPLACEMENT_OR_INVITE' };
      }, { wait: true });
      results.push(result);
    }
    return { formerAccountId: accountId, formerAccountName: former.name, groupsFound: memberships.length, rejoined: results.filter(item => item.status === 'REJOINED').length, failed: results.filter(item => item.status === 'FAILED').length, results };
  },
};

module.exports = Service;
