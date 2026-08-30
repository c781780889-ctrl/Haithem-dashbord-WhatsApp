'use strict';
const Service = require('../services/TelegramSmartConversationService');

function statusFor(error) {
  return ['RULE_NAME_REQUIRED', 'RULE_INSTRUCTIONS_REQUIRED'].includes(error.code) ? 400 : error.code === 'NOT_FOUND' ? 404 : 500;
}
function handle(method, fallback) {
  return async (req, res) => {
    try { return res.json({ success: true, ...(await method(req.user.id, req)) }); }
    catch (error) { console.error(`[TelegramSmartConversationController] ${fallback}`, error.message); return res.status(statusFor(error)).json({ success: false, error: error.message || fallback, code: error.code || 'TELEGRAM_SMART_FAILED' }); }
  };
}

module.exports = {
  dashboard: handle((userId, req) => Service.dashboard(userId, req.query || {}), 'تعذر تحميل المحادثات الذكية'),
  results: handle((userId, req) => Service.results(userId, req.query || {}), 'تعذر تحميل النتائج'),
  createRule: handle((userId, req) => Service.createRule(userId, req.body || {}), 'تعذر إنشاء القاعدة'),
  updateRule: handle((userId, req) => Service.updateRule(userId, req.params.id, req.body || {}), 'تعذر تعديل القاعدة'),
  toggleRule: handle((userId, req) => Service.toggleRule(userId, req.params.id, req.body?.is_active), 'تعذر تغيير حالة القاعدة'),
  deleteRule: handle(async (userId, req) => { await Service.deleteRule(userId, req.params.id); return { deleted: true }; }, 'تعذر حذف القاعدة'),
  updateResult: handle((userId, req) => Service.updateResult(userId, req.params.id, req.body || {}), 'تعذر تحديث نتيجة المحادثة'),
  deleteResult: handle((userId, req) => Service.deleteResult(userId, req.params.id), 'تعذر حذف النتيجة'),
  ignoreMessage: handle((userId, req) => Service.ignoreMessage(userId, req.params.id), 'تعذر تجاهل الرسالة'),
  openMessage: handle((userId, req) => Service.openMessage(userId, req.params.id), 'تعذر فتح الرسالة'),
  deleteMessage: handle((userId, req) => Service.deleteMessage(userId, req.params.id), 'تعذر حذف الرسالة من Telegram'),
  openPrivateChat: handle((userId, req) => Service.openPrivateChat(userId, req.params.id), 'تعذر فتح المحادثة الخاصة'),
  blockUser: handle((userId, req) => Service.blockUser(userId, req.params.id, req.body || {}), 'تعذر حظر المستخدم'),
  unblockUser: handle((userId, req) => Service.unblockUser(userId, req.params.telegramUserId), 'تعذر إلغاء حظر المستخدم'),
  blockGroup: handle((userId, req) => Service.blockGroup(userId, req.params.id, req.body || {}), 'تعذر حظر المجموعة'),
  unblockGroup: handle((userId, req) => Service.unblockGroup(userId, req.params.groupId), 'تعذر إلغاء حظر المجموعة'),
  testRule: handle((userId, req) => Service.testRule(userId, req.body || {}), 'تعذر اختبار القاعدة'),
  geminiHealth: handle(() => Service.geminiHealth(), 'تعذر فحص Gemini'),
  geminiStatus: handle(() => Promise.resolve(Service.aiStatus()), 'تعذر تحميل حالة Gemini'),
  testGemini: handle((userId, req) => Service.testGemini(req.body || {}), 'تعذر اختبار Gemini'),
  updateSettings: handle((userId, req) => Service.updateSettings(userId, req.body || {}), 'تعذر تحديث الإعدادات'),
  notifications: handle((userId, req) => Service.notifications(userId, req.query?.limit || 30), 'تعذر تحميل الإشعارات'),
  markNotificationRead: handle((userId, req) => Service.markNotificationRead(userId, req.params.id), 'تعذر تحديث الإشعار'),
  markAllNotificationsRead: handle((userId) => Service.markAllNotificationsRead(userId), 'تعذر تحديث الإشعارات'),
};
