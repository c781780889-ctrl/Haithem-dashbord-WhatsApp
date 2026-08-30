const DatabaseManager = require('../../database/DatabaseManager');

const ADMIN_ROLES = new Set(['super_admin', 'superadmin', 'admin', 'owner']);

function currentUserId(req) {
  return req.user?.id || req.user?.userId || null;
}

function isAdmin(req) {
  return ADMIN_ROLES.has(req.user?.role);
}

/**
 * Authorize access to /accounts/:accountId resources.
 * Admins may inspect accounts explicitly; regular users may only access
 * accounts owned by their authenticated identity. The account id is never
 * trusted from the client without this database check.
 */
async function requireAccountOwnership(req, res, next) {
  const accountId = req.params.accountId || req.params.id;
  const userId = currentUserId(req);

  if (!accountId) {
    return res.status(400).json({ success: false, error: 'معرف الحساب مطلوب.' });
  }
  if (!userId) {
    return res.status(401).json({ success: false, error: 'غير مصرح.' });
  }

  try {
    const account = await DatabaseManager.systemDB.get(
      'SELECT id, user_id, status FROM accounts WHERE id = $1',
      [accountId]
    );
    if (!account) {
      return res.status(404).json({ success: false, error: 'الحساب غير موجود.' });
    }

    if (!isAdmin(req) && account.user_id !== userId) {
      return res.status(403).json({ success: false, error: 'غير مصرح بالوصول لهذا الحساب.' });
    }

    req.account = account;
    req.accountOwnerId = account.user_id;
    return next();
  } catch (error) {
    console.error('[AccountOwnership] authorization failed:', error.message);
    return res.status(500).json({ success: false, error: 'تعذر التحقق من ملكية الحساب.' });
  }
}

function userScope(req) {
  const userId = currentUserId(req);
  return { userId, admin: isAdmin(req) };
}


async function requireTelegramAccountOwnership(req, res, next) {
  const accountId = req.params.id || req.params.accountId;
  const userId = currentUserId(req);
  if (!accountId) return res.status(400).json({ success: false, error: 'معرف حساب Telegram مطلوب.' });
  if (!userId) return res.status(401).json({ success: false, error: 'غير مصرح.' });
  try {
    const account = await DatabaseManager.systemDB.get(
      'SELECT id, user_id, status FROM telegram_accounts WHERE id = $1',
      [accountId]
    );
    if (!account) return res.status(404).json({ success: false, error: 'حساب Telegram غير موجود.' });
    if (!isAdmin(req) && account.user_id !== userId) {
      return res.status(403).json({ success: false, error: 'غير مصرح بالوصول إلى حساب Telegram هذا.' });
    }
    req.telegramAccount = account;
    return next();
  } catch (error) {
    console.error('[TelegramAccountOwnership] authorization failed:', error.message);
    return res.status(500).json({ success: false, error: 'تعذر التحقق من ملكية حساب Telegram.' });
  }
}

module.exports = { ADMIN_ROLES, currentUserId, isAdmin, userScope, requireAccountOwnership, requireTelegramAccountOwnership };
