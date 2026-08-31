'use strict';

const crypto = require('crypto');
const Service = require('../services/TelegramJoinAutomationService');
const GlobalJoinRegistry = require('../services/GlobalJoinRegistry');

const ADMIN_ROLES = new Set(['super_admin', 'superadmin', 'admin', 'owner']);
const READ_ONLY_ROLES = new Set(['viewer', 'view_only']);
const userId = req => req.user?.id || req.user?.userId;
const isAdmin = req => ADMIN_ROLES.has(String(req.user?.role || '').toLowerCase());
const canOperate = req => !READ_ONLY_ROLES.has(String(req.user?.role || '').toLowerCase());
const requestId = req => req.get?.('x-request-id') || crypto.randomUUID();
const idempotencyKey = req => req.body?.requestId || req.get?.('idempotency-key') || requestId(req);
const errorResponse = (res, error, fallback = 'AUTOMATION_ERROR') => res.status(error.statusCode || 400).json({ success: false, error: { code: error.code || fallback, message: error.message || 'حدث خطأ غير متوقع' } });

const Controller = {
  async dashboard(req, res) {
    try { return res.json({ success: true, data: await Service.dashboard(userId(req), isAdmin(req)), requestId: requestId(req) }); }
    catch (error) { return errorResponse(res, error, 'DASHBOARD_ERROR'); }
  },
  async globalStatus(req, res) {
    try { return res.json({ success: true, data: await GlobalJoinRegistry.getStatus(req.body?.url || req.query?.url || ''), requestId: requestId(req) }); }
    catch (error) { return errorResponse(res, error, 'GLOBAL_STATUS_ERROR'); }
  },
  async globalDashboard(req, res) {
    try { if (!isAdmin(req)) { const error = new Error('هذا التقرير متاح للمدير فقط'); error.statusCode = 403; throw error; } return res.json({ success: true, data: await GlobalJoinRegistry.dashboard(), requestId: requestId(req) }); }
    catch (error) { return errorResponse(res, error, 'GLOBAL_DASHBOARD_ERROR'); }
  },
  async health(req, res) {
    try { return res.json({ success: true, data: await Service.health(userId(req), isAdmin(req)), requestId: requestId(req) }); }
    catch (error) { return errorResponse(res, error, 'HEALTH_ERROR'); }
  },
  async settings(req, res) {
    try { return res.json({ success: true, data: await Service.getSettings(userId(req)), requestId: requestId(req) }); }
    catch (error) { return errorResponse(res, error, 'SETTINGS_READ_ERROR'); }
  },
  async updateSettings(req, res) {
    try {
      if (!canOperate(req)) { const error = new Error('صلاحية المشاهدة فقط لا تسمح بتعديل إعدادات أتمتة الانضمام'); error.code = 'PERMISSION_REQUIRED'; throw error; }
      return res.json({ success: true, data: await Service.updateSettings({ userId: userId(req), settings: req.body || {} }), requestId: requestId(req) });
    } catch (error) { return errorResponse(res, error, 'SETTINGS_UPDATE_ERROR'); }
  },
  async links(req, res) {
    try { return res.json({ success: true, data: await Service.getLinks({ userId: userId(req), isAdmin: isAdmin(req), ...req.query }), requestId: requestId(req) }); }
    catch (error) { return errorResponse(res, error, 'LINKS_ERROR'); }
  },
  async report(req, res) {
    try { return res.json({ success: true, data: await Service.report(userId(req), isAdmin(req)), requestId: requestId(req) }); }
    catch (error) { return errorResponse(res, error, 'REPORT_ERROR'); }
  },
  async search(req, res) {
    try {
      if (!canOperate(req)) { const error = new Error('صلاحية المشاهدة فقط لا تسمح ببدء البحث'); error.code = 'PERMISSION_REQUIRED'; throw error; }
      const result = await Service.createDiscoveryJob({ userId: userId(req), accountIds: req.body?.accountIds, isAdmin: isAdmin(req), requestId: idempotencyKey(req), req });
      return res.status(202).json({ success: true, data: result, requestId: requestId(req) });
    } catch (error) { return errorResponse(res, error, 'DISCOVERY_ERROR'); }
  },
  async setAccountRole(req, res) {
    try {
      if (!canOperate(req)) { const error = new Error('صلاحية المشاهدة فقط لا تسمح بتغيير دور الحساب'); error.code = 'PERMISSION_REQUIRED'; throw error; }
      const account = await Service.setAccountRole({ userId: userId(req), accountId: req.params.accountId, role: req.body?.role, enabled: req.body?.enabled, requestId: idempotencyKey(req), isAdmin: isAdmin(req), req });
      return res.json({ success: true, data: { account }, requestId: requestId(req) });
    } catch (error) { return errorResponse(res, error, 'ACCOUNT_ROLE_ERROR'); }
  },
  async createJob(req, res) {
    try {
      if (!canOperate(req)) { const error = new Error('صلاحية المشاهدة فقط لا تسمح بتشغيل الانضمام'); error.code = 'PERMISSION_REQUIRED'; throw error; }
      const result = await Service.createJob({ userId: userId(req), accountIds: req.body?.accountIds, linkIds: req.body?.linkIds, allPending: req.body?.allPending === true, settings: req.body?.settings, requestId: req.body?.requestId || idempotencyKey(req), isAdmin: isAdmin(req), req });
      return res.status(201).json({ success: true, data: result, requestId: requestId(req) });
    } catch (error) { return errorResponse(res, error, 'JOB_CREATE_ERROR'); }
  },
  async job(req, res) {
    try { const data = await Service.jobDashboard(userId(req), req.params.jobId, isAdmin(req)); if (!data) return res.status(404).json({ success: false, error: { code: 'JOB_NOT_FOUND', message: 'المهمة غير موجودة' }, requestId: requestId(req) }); return res.json({ success: true, data, requestId: requestId(req) }); }
    catch (error) { return errorResponse(res, error, 'JOB_ERROR'); }
  },
  async controlJob(req, res) {
    try {
      if (!canOperate(req)) { const error = new Error('صلاحية المشاهدة فقط لا تسمح بالتحكم بالمهمة'); error.code = 'PERMISSION_REQUIRED'; throw error; }
      const data = await Service.controlJob(userId(req), req.params.jobId, req.body?.status, isAdmin(req), req);
      return res.json({ success: true, data, requestId: requestId(req) });
    } catch (error) { return errorResponse(res, error, 'JOB_CONTROL_ERROR'); }
  },
  async archiveLink(req, res) {
    try {
      if (!canOperate(req)) { const error = new Error('صلاحية المشاهدة فقط لا تسمح بأرشفة الرابط'); error.code = 'PERMISSION_REQUIRED'; throw error; }
      return res.json({ success: true, data: await Service.archiveLink(userId(req), req.params.linkId, isAdmin(req), req), requestId: requestId(req) });
    } catch (error) { return errorResponse(res, error, 'LINK_ARCHIVE_ERROR'); }
  },
  async archiveAllLinks(req, res) {
    try {
      if (!canOperate(req)) { const error = new Error('صلاحية المشاهدة فقط لا تسمح بحذف الروابط'); error.code = 'PERMISSION_REQUIRED'; throw error; }
      return res.json({ success: true, data: await Service.archiveAllLinks(userId(req), isAdmin(req), req), requestId: requestId(req) });
    } catch (error) { return errorResponse(res, error, 'LINK_ARCHIVE_ALL_ERROR'); }
  },
  async previewLinks(req, res) {
    try {
      return res.json({ success: true, data: await Service.previewLinks({ userId: userId(req), contentBase64: req.body?.contentBase64, filename: req.body?.filename }), requestId: requestId(req) });
    } catch (error) { return errorResponse(res, error, 'LINK_PREVIEW_ERROR'); }
  },
  async importLinks(req, res) {
    try {
      if (!canOperate(req)) { const error = new Error('صلاحية المشاهدة فقط لا تسمح بالاستيراد'); error.code = 'PERMISSION_REQUIRED'; throw error; }
      return res.status(201).json({ success: true, data: await Service.importLinks({ userId: userId(req), links: req.body?.links, content: req.body?.content, contentBase64: req.body?.contentBase64, filename: req.body?.filename, format: req.body?.format, requestId: idempotencyKey(req), req }), requestId: requestId(req) });
    } catch (error) { return errorResponse(res, error, 'LINK_IMPORT_ERROR'); }
  },
  async exportData(req, res) {
    try { return res.json({ success: true, data: await Service.exportData({ userId: userId(req), isAdmin: isAdmin(req), entity: req.query?.entity, format: req.query?.format, req }), requestId: requestId(req) }); }
    catch (error) { return errorResponse(res, error, 'EXPORT_ERROR'); }
  },
  async notifications(req, res) {
    try { return res.json({ success: true, data: await Service.notifications(userId(req), { unreadOnly: req.query?.unreadOnly === 'true' }), requestId: requestId(req) }); }
    catch (error) { return errorResponse(res, error, 'NOTIFICATION_ERROR'); }
  },
  async markNotificationRead(req, res) {
    try { return res.json({ success: true, data: await Service.markNotificationRead(userId(req), req.params.notificationId), requestId: requestId(req) }); }
    catch (error) { return errorResponse(res, error, 'NOTIFICATION_ERROR'); }
  },
};

module.exports = Controller;
