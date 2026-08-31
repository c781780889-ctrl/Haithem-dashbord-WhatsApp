'use strict';

const { query, queryOne, queryAll } = require('../../lib/postgres');
const SocketBridge = require('../../core/SocketBridge');
const TelegramService = require('./TelegramService');
const QueueManager = require('../../lib/QueueManager');
const GeminiAIService = require('./GeminiAIService');

const MAX_LIMIT = 100;
const DEFAULT_SCORE = 70;
const normalizeTelegramId = value => { const raw = String(value ?? '').trim().replace(/n$/, ''); if (!raw) return ''; try { return String(BigInt(raw)); } catch { return raw; } };
const DEFAULT_RULE_NAME = 'الخدمات الأكاديمية والتقنية المتكاملة';
const DEFAULT_RULE_INSTRUCTIONS = `اكتشف المحادثات التي يطلب فيها المستخدم خدمة تعليمية أو أكاديمية أو تقنية أو تنظيمية من الخدمات التالية: حل وشرح الواجبات والتكاليف، إعداد ومراجعة Assignments، البحوث والدراسات وخطط البحث والمراجع، مشاريع التخرج والتقارير والعروض والمناقشة، التحليل الإحصائي وSPSS وتنظيف البيانات والاختبارات الإحصائية، البرمجة وعلوم الحاسب Python وJava وC++ وMATLAB وSQL وHTML وCSS وJavaScript والخوارزميات وقواعد البيانات وتطوير الويب وتطبيقات الجوال، الذكاء الاصطناعي والتعلم الآلي وتحليل البيانات، تصميم قواعد البيانات وERD ونظم المعلومات، الشبكات والأمن السيبراني التعليمي والمحاكاة، PowerPoint وPresentations والإنفوجرافيك والخرائط الذهنية، التلخيص والترجمة والتدقيق والتنسيق وWord وPDF، التقارير ودراسات الحالة، إعداد CV والسيرة الذاتية وATS، الشرح والمراجعة والاستعداد للمناقشة، أو تنظيم المستندات والخدمات الطبية النظامية الرسمية فقط. أعطِ أولوية للمحادثة إذا احتوت على طلب واضح أو سؤال عن السعر أو التسليم أو المراجعة أو التنفيذ. لا تعتبر التحية العامة أو النقاش غير المرتبط بالخدمات مطابقة. استبعد صراحة طلبات المستندات أو الأعذار الطبية المزورة، انتحال صفة جهة صحية، تزوير الشهادات أو المراجع، الاختراق أو إساءة استخدام الأمن السيبراني، وأي طلب غير قانوني أو ضار.`;
async function ensureDefaultRule(userId) {
  await query(`INSERT INTO telegram_smart_rules(user_id,name,description,instructions,match_mode,min_score,priority,account_ids,group_mode,group_ids,exclude_group_ids,is_active) SELECT $1,$2,$3,$4,'wide',65,'high','[]','all','[]','[]',TRUE WHERE NOT EXISTS (SELECT 1 FROM telegram_smart_rules WHERE user_id=$1 AND name=$2)`, [userId, DEFAULT_RULE_NAME, 'قاعدة شاملة لاكتشاف طلبات الخدمات الأكاديمية والتقنية والتنظيمية وفق مواصفات الخدمات المرفقة.', DEFAULT_RULE_INSTRUCTIONS]);
}
const STOP_WORDS = new Set('من في عن على إلى الى هذا هذه ذلك التي الذي و أو ثم مع هو هي any the and or for from with that this'.split(/\s+/));
const CONCEPT_GROUPS = [
  ['academic', ['طالب', 'طلاب', 'طالبا', 'جامعة', 'جامعي', 'بحث', 'ابحاث', 'واجب', 'مشروع', 'تخرج', 'تقرير', 'عرض', 'أكاديمي', 'اكاديمي', 'دراسي', 'مقرر', 'رسالة', 'student', 'university', 'research', 'assignment', 'thesis', 'academic']],
  ['help', ['مساعدة', 'ساعد', 'يساعد', 'محتاج', 'احتاج', 'أحتاج', 'ابغى', 'اريد', 'أريد', 'مطلوب', 'خدمة', 'help', 'need', 'looking']],
  ['job', ['وظيفة', 'وظائف', 'توظيف', 'عمل', 'دوام', 'سيرة', 'cv', 'راتب', 'job', 'career', 'hiring']],
  ['buying', ['شراء', 'اشتري', 'بيع', 'سعر', 'أسعار', 'متوفر', 'طلب', 'اطلب', 'buy', 'sell', 'price', 'available']],
  ['programming', ['برمجة', 'بايثون', 'python', 'java', 'جافا', 'c++', 'matlab', 'sql', 'javascript', 'html', 'css', 'خوارزميات', 'قواعد بيانات', 'تطبيق', 'ويب', 'كود', 'تصحيح', 'برمجي']],
  ['data', ['بيانات', 'تحليل البيانات', 'تعلم آلي', 'machine learning', 'تصنيف', 'تنبؤ', 'ذكاء اصطناعي', 'ai', 'إحصاء', 'احصاء', 'spss', 'انحدار', 'ارتباط', 'anova', 't-test', 'فرضيات']],
  ['research', ['بحث', 'بحوث', 'دراسة', 'دراسات', 'منهجية', 'مشكلة البحث', 'فرضية', 'مراجع', 'مصادر', 'توثيق', 'إطار نظري', 'دراسة حالة']],
  ['presentation', ['عرض', 'بوربوينت', 'powerpoint', 'presentation', 'شرائح', 'انفوجرافيك', 'infographic', 'خريطة ذهنية', 'خريطة مفاهيم', 'ملصق']],
  ['writing', ['تقرير', 'تقارير', 'تلخيص', 'ملخص', 'ترجمة', 'مترجم', 'صياغة', 'تدقيق لغوي', 'تنسيق', 'word', 'pdf', 'فهرس', 'مراجع']],
  ['career', ['سيرة ذاتية', 'سيره ذاتيه', 'cv', 'resume', 'ats', 'وظيفة', 'خبرات', 'مهارات', 'نبذة مهنية']],
  ['medical_admin', ['ملف طبي', 'مستندات طبية', 'خدمة صحية', 'موعد طبي', 'تقرير طبي رسمي', 'جهة صحية', 'medical document']],
  ['urgent', ['عاجل', 'ضروري', 'الان', 'الآن', 'سريع', 'urgent', 'asap']],
];

let tablesReady;
let blockedUsersReady;
let blockedGroupsReady;
async function ensureBlockedGroupsTable() {
  if (!blockedGroupsReady) blockedGroupsReady = query(`CREATE TABLE IF NOT EXISTS telegram_smart_blocked_groups (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), user_id UUID NOT NULL, group_id TEXT NOT NULL, group_title TEXT, group_username TEXT, group_type VARCHAR(30), blocked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), blocked_by UUID, reason TEXT, is_active BOOLEAN NOT NULL DEFAULT TRUE, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), UNIQUE (user_id, group_id))`).then(() => query(`CREATE INDEX IF NOT EXISTS idx_tg_smart_blocked_groups_active ON telegram_smart_blocked_groups(user_id,is_active,group_id)`).catch(() => {})).catch(error => { blockedGroupsReady = undefined; throw error; });
  return blockedGroupsReady;
}
async function isGroupBlocked(userId, groupId) {
  const id = normalizeTelegramId(groupId);
  if (!id) return false;
  await ensureBlockedGroupsTable();
  const row = await queryOne(`SELECT 1 FROM telegram_smart_blocked_groups WHERE user_id=$1 AND group_id=$2 AND is_active=true LIMIT 1`, [userId, id]);
  return Boolean(row);
}
async function ensureBlockedUsersTable() {
  if (!blockedUsersReady) blockedUsersReady = query(`CREATE TABLE IF NOT EXISTS telegram_keyword_blocked_users (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), user_id UUID NOT NULL, telegram_user_id TEXT NOT NULL, telegram_username TEXT, display_name TEXT, blocked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), blocked_by UUID, reason TEXT, is_active BOOLEAN NOT NULL DEFAULT TRUE, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), UNIQUE (user_id, telegram_user_id))`).then(() => query(`CREATE INDEX IF NOT EXISTS idx_tg_blocked_users_active ON telegram_keyword_blocked_users(user_id,is_active,telegram_user_id)`).catch(() => {})).catch(error => { blockedUsersReady = undefined; throw error; });
  return blockedUsersReady;
}
async function isUserBlocked(userId, telegramUserId) {
  const id = String(telegramUserId ?? '').trim();
  if (!id) return false;
  await ensureBlockedUsersTable();
  const row = await queryOne(`SELECT 1 FROM telegram_keyword_blocked_users WHERE user_id=$1 AND telegram_user_id=$2 AND is_active=true LIMIT 1`, [userId, id]);
  return Boolean(row);
}
let cleanupTimer = null;
async function purgeSmartConversationDataOnce() {
  const marker = await queryOne(`SELECT 1 FROM system_migrations WHERE version = 901 LIMIT 1`).catch(() => null);
  if (marker) return { skipped: true };

  const targets = [
    'telegram_smart_notifications',
    'telegram_smart_logs',
    'telegram_smart_results',
    'telegram_smart_rules',
    'telegram_smart_blocked_groups',
  ];
  const removed = {};
  for (const table of targets) {
    const result = await query(`DELETE FROM ${table}`).catch(() => ({ rowCount: 0 }));
    removed[table] = result.rowCount || 0;
  }
  await query(`INSERT INTO system_migrations(version,name) VALUES (901,'purge_smart_conversation_data') ON CONFLICT (version) DO NOTHING`).catch(() => {});
  console.warn('[TelegramSmart] One-time smart conversation data purge completed:', removed);
  return { skipped: false, removed };
}

async function ensureTables() {
  if (!tablesReady) {
    tablesReady = (async () => {
      await query(`CREATE TABLE IF NOT EXISTS telegram_smart_rules (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), user_id UUID NOT NULL, name TEXT NOT NULL, description TEXT, instructions TEXT NOT NULL, match_mode VARCHAR(20) NOT NULL DEFAULT 'balanced', min_score INT NOT NULL DEFAULT 70, priority VARCHAR(20) NOT NULL DEFAULT 'medium', account_ids JSONB NOT NULL DEFAULT '[]', group_mode VARCHAR(20) NOT NULL DEFAULT 'all', group_ids JSONB NOT NULL DEFAULT '[]', exclude_group_ids JSONB NOT NULL DEFAULT '[]', is_active BOOLEAN NOT NULL DEFAULT TRUE, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
      await query(`CREATE TABLE IF NOT EXISTS telegram_smart_results (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), user_id UUID NOT NULL, rule_id UUID NOT NULL REFERENCES telegram_smart_rules(id) ON DELETE CASCADE, telegram_account_id UUID NOT NULL REFERENCES telegram_accounts(id) ON DELETE CASCADE, chat_id TEXT NOT NULL, chat_title TEXT, chat_username TEXT, chat_type VARCHAR(30), message_id TEXT NOT NULL, sender_id TEXT, sender_username TEXT, sender_name TEXT, message_text TEXT NOT NULL, context JSONB NOT NULL DEFAULT '{}'::jsonb, match_score NUMERIC(5,2) NOT NULL DEFAULT 0, is_match BOOLEAN NOT NULL DEFAULT FALSE, reason TEXT, status VARCHAR(30) NOT NULL DEFAULT 'new', is_saved BOOLEAN NOT NULL DEFAULT FALSE, is_pinned BOOLEAN NOT NULL DEFAULT FALSE, deleted_in_telegram BOOLEAN NOT NULL DEFAULT FALSE, deleted_at TIMESTAMPTZ, detected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), analyzed_at TIMESTAMPTZ, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), UNIQUE (telegram_account_id, chat_id, message_id, rule_id))`);
      await query(`CREATE TABLE IF NOT EXISTS telegram_smart_settings (user_id UUID PRIMARY KEY, enabled BOOLEAN NOT NULL DEFAULT TRUE, default_min_score INT NOT NULL DEFAULT 70, context_before INT NOT NULL DEFAULT 2, context_after INT NOT NULL DEFAULT 2, analysis_language VARCHAR(10) NOT NULL DEFAULT 'ar', retention_days INT NOT NULL DEFAULT 90, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
      await query(`CREATE TABLE IF NOT EXISTS telegram_smart_logs (id BIGSERIAL PRIMARY KEY, user_id UUID NOT NULL, rule_id UUID, result_id UUID, telegram_account_id UUID, chat_id TEXT, message_id TEXT, decision VARCHAR(30) NOT NULL, match_score NUMERIC(5,2), reason TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
      for (const statement of [
        `ALTER TABLE telegram_smart_results ADD COLUMN IF NOT EXISTS ai_model TEXT`,
        `ALTER TABLE telegram_smart_results ADD COLUMN IF NOT EXISTS ai_request_id TEXT`,
        `ALTER TABLE telegram_smart_results ADD COLUMN IF NOT EXISTS ai_api_version TEXT`,
        `ALTER TABLE telegram_smart_results ADD COLUMN IF NOT EXISTS category TEXT`,
        `ALTER TABLE telegram_smart_results ADD COLUMN IF NOT EXISTS summary TEXT`,
        `ALTER TABLE telegram_smart_results ADD COLUMN IF NOT EXISTS ai_priority VARCHAR(20)`,
        `ALTER TABLE telegram_smart_results ADD COLUMN IF NOT EXISTS ai_confidence NUMERIC(5,4)`,
        `ALTER TABLE telegram_smart_results ADD COLUMN IF NOT EXISTS processing_time INT`,
        `ALTER TABLE telegram_smart_results ADD COLUMN IF NOT EXISTS retry_count INT NOT NULL DEFAULT 0`,
        `ALTER TABLE telegram_smart_results ADD COLUMN IF NOT EXISTS ai_status VARCHAR(30) NOT NULL DEFAULT 'not_requested'`,
        `ALTER TABLE telegram_smart_results ADD COLUMN IF NOT EXISTS ai_error TEXT`,
        `ALTER TABLE telegram_smart_results ADD COLUMN IF NOT EXISTS message_timestamp TIMESTAMPTZ`,
      ]) await query(statement).catch(() => {});
      await query(`CREATE INDEX IF NOT EXISTS idx_tg_smart_rules_user_active ON telegram_smart_rules(user_id,is_active,priority)`).catch(() => {});
      await query(`CREATE INDEX IF NOT EXISTS idx_tg_smart_results_user_detected ON telegram_smart_results(user_id,detected_at DESC)`).catch(() => {});
      await query(`CREATE INDEX IF NOT EXISTS idx_tg_smart_results_user_state ON telegram_smart_results(user_id,status,is_match,is_pinned,is_saved)`).catch(() => {});
      await query(`CREATE INDEX IF NOT EXISTS idx_tg_smart_results_chat ON telegram_smart_results(user_id,telegram_account_id,chat_id,detected_at DESC)`).catch(() => {});
      await query(`CREATE INDEX IF NOT EXISTS idx_tg_smart_logs_user_created ON telegram_smart_logs(user_id,created_at DESC)`).catch(() => {});
    })().catch(error => { tablesReady = undefined; throw error; });
  }
  return tablesReady;
}

function normalize(value) {
  return String(value || '').normalize('NFKC').toLocaleLowerCase('ar').replace(/[إأآٱ]/g, 'ا').replace(/ى/g, 'ي').replace(/[ًٌٍَُِّْـ]/g, '').replace(/[^\p{L}\p{N}_@-]+/gu, ' ').replace(/\s+/g, ' ').trim();
}
function tokens(value) {
  return new Set(normalize(value).split(' ').filter(token => token.length > 1 && !STOP_WORDS.has(token)));
}
function concepts(value) {
  const source = normalize(value);
  return new Set(CONCEPT_GROUPS.filter(([, terms]) => terms.some(term => source.includes(normalize(term)))).map(([id]) => id));
}
function asArray(value) {
  if (Array.isArray(value)) return value.map(item => String(item)).filter(Boolean);
  if (typeof value === 'string') { try { return asArray(JSON.parse(value)); } catch { return value ? [value] : []; } }
  return [];
}
function clampScore(value) { return Math.max(0, Math.min(100, Math.round(Number(value) || 0))); }
function scoreLabel(score) { return score >= 85 ? 'مطابقة قوية' : score >= 70 ? 'مطابقة محتملة' : score >= 40 ? 'احتمال ضعيف' : 'غير مطابقة'; }
function analyzeText(instructions, messageText, minScore = DEFAULT_SCORE, mode = 'balanced') {
  const instructionTokens = tokens(instructions);
  const messageTokens = tokens(messageText);
  const overlap = [...instructionTokens].filter(token => messageTokens.has(token)).length;
  const overlapRatio = instructionTokens.size ? Math.min(1, overlap / Math.min(instructionTokens.size, 8)) : 0;
  const instructionConcepts = concepts(instructions);
  const messageConcepts = concepts(messageText);
  const conceptOverlap = [...instructionConcepts].filter(item => messageConcepts.has(item)).length;
  const actionSignal = /اريد|أريد|محتاج|احتاج|أحتاج|ابغى|مطلوب|ساعد|طلب|need|help|looking|want/i.test(String(messageText || '')) ? 1 : 0;
  const modeBonus = mode === 'strict' ? 0 : mode === 'wide' ? 8 : mode === 'precise' ? 3 : 0;
  const conceptSignal = conceptOverlap > 0 ? 55 : 0;
  const score = clampScore(overlapRatio * 35 + conceptSignal + actionSignal * 15 + modeBonus);
  const isMatch = score >= Math.max(0, Math.min(100, Number(minScore) || DEFAULT_SCORE));
  const reason = isMatch
    ? `تمت المطابقة بدرجة ${score}% لأن نص الرسالة يشارك القاعدة في ${conceptOverlap ? 'المعنى والسياق' : 'مصطلحات أساسية'}${actionSignal ? ' ويتضمن إشارة إلى طلب أو حاجة' : ''}.`
    : `لم تتجاوز الرسالة حد المطابقة؛ درجة التشابه الدلالي ${score}%، والحد الأدنى المحدد ${Math.max(0, Math.min(100, Number(minScore) || DEFAULT_SCORE))}%.`;
  return { score, isMatch, reason, confidence_label: scoreLabel(score), engine: 'local-semantic-v1' };
}
function safeJson(value, fallback = {}) { if (!value) return fallback; if (typeof value === 'object') return value; try { return JSON.parse(value); } catch { return fallback; } }
function telegramMessageLink(chatId, chatUsername, messageId, chatType) {
  const id = String(messageId || '').trim();
  if (!id || id.startsWith('derived:')) return null;
  const username = String(chatUsername || '').replace(/^@+/, '').trim();
  if (username) return `https://t.me/${encodeURIComponent(username)}/${encodeURIComponent(id)}?single`;
  const raw = String(chatId || '').replace(/n$/, '').trim();
  if (!raw) return null;
  if (['channel', 'supergroup'].includes(String(chatType || '').toLowerCase())) {
    const channelId = raw.match(/^-100(\d+)$/)?.[1] || raw.match(/^\d+$/)?.[0];
    if (channelId) return `https://t.me/c/${channelId}/${encodeURIComponent(id)}?single`;
  }
  return `tg://openmessage?chat_id=${encodeURIComponent(raw)}&message_id=${encodeURIComponent(id)}`;
}
function decorate(result) {
  return { ...result, context: safeJson(result.context), message_link: telegramMessageLink(result.chat_id, result.chat_username, result.message_id, result.chat_type) };
}
function accountAllowed(rule, accountId) {
  // القائمة الفارغة تعني جميع الحسابات، أما القائمة المحددة فتقيّد
  // المعالجة بالحسابات التي اختارها المستخدم فقط.
  const selected = asArray(rule.account_ids);
  return selected.length === 0 || selected.includes(String(accountId));
}
function groupAllowed(rule, chatId) {
  const id = String(chatId || '');
  const include = asArray(rule.group_ids);
  const exclude = asArray(rule.exclude_group_ids);
  if (exclude.includes(id)) return false;
  return rule.group_mode !== 'selected' || include.length === 0 || include.includes(id);
}

const Service = {
  DEFAULT_SCORE,
  analyzeText,
  _accountAllowed: accountAllowed,
  aiStatus: () => GeminiAIService.status(),
  async geminiHealth() { return GeminiAIService.healthCheck(); },
  async testGemini(body = {}) { return GeminiAIService.analyze({ rule: { name: body.rule_name || 'اختبار Gemini', instructions: body.instructions || 'حلل النص وحدد هل يطابق القاعدة.' }, message: { text: body.text || '', chat_title: 'اختبار Dashboard' }, context: body.context || [] }); },
  async dashboard(userId, filters = {}) {
    await ensureTables();
    await ensureBlockedUsersTable();
    await ensureBlockedGroupsTable();
    await ensureDefaultRule(userId);
    const accountRows = await queryAll(`SELECT id,name,phone_number,username,status,last_activity_at,created_at FROM telegram_accounts WHERE user_id=$1 ORDER BY created_at DESC`, [userId]);
    await query(`INSERT INTO telegram_smart_settings(user_id) VALUES($1) ON CONFLICT(user_id) DO NOTHING`, [userId]);
    const [rules, settings, stats, logs, notifications, resultRows] = await Promise.all([
      queryAll(`SELECT * FROM telegram_smart_rules WHERE user_id=$1 ORDER BY CASE priority WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END,created_at DESC`, [userId]),
      queryOne(`SELECT * FROM telegram_smart_settings WHERE user_id=$1`, [userId]),
      queryOne(`SELECT COUNT(*)::int AS discovered,COUNT(*) FILTER(WHERE is_match AND NOT EXISTS (SELECT 1 FROM telegram_keyword_blocked_users bu WHERE bu.user_id=telegram_smart_results.user_id AND bu.telegram_user_id=telegram_smart_results.sender_id AND bu.is_active=true AND telegram_smart_results.detected_at >= bu.blocked_at) AND NOT EXISTS (SELECT 1 FROM telegram_smart_blocked_groups bg WHERE bg.user_id=telegram_smart_results.user_id AND bg.group_id=regexp_replace(telegram_smart_results.chat_id,'n$','') AND bg.is_active=true AND telegram_smart_results.detected_at >= bg.blocked_at))::int AS matched,COUNT(*) FILTER(WHERE status='new' AND NOT EXISTS (SELECT 1 FROM telegram_keyword_blocked_users bu WHERE bu.user_id=telegram_smart_results.user_id AND bu.telegram_user_id=telegram_smart_results.sender_id AND bu.is_active=true AND telegram_smart_results.detected_at >= bu.blocked_at) AND NOT EXISTS (SELECT 1 FROM telegram_smart_blocked_groups bg WHERE bg.user_id=telegram_smart_results.user_id AND bg.group_id=regexp_replace(telegram_smart_results.chat_id,'n$','') AND bg.is_active=true AND telegram_smart_results.detected_at >= bg.blocked_at))::int AS new_count,COUNT(*) FILTER(WHERE is_saved OR is_pinned)::int AS saved,COUNT(*) FILTER(WHERE deleted_in_telegram)::int AS deleted,COUNT(*) FILTER(WHERE status='review')::int AS review FROM telegram_smart_results WHERE user_id=$1`, [userId]),
      queryAll(`SELECT l.*,r.name AS rule_name,a.name AS account_name FROM telegram_smart_logs l LEFT JOIN telegram_smart_rules r ON r.id=l.rule_id LEFT JOIN telegram_accounts a ON a.id=l.telegram_account_id WHERE l.user_id=$1 ORDER BY l.created_at DESC LIMIT 20`, [userId]),
      this.notifications(userId, 30),
      this.results(userId, filters),
    ]);
    const workers = accountRows.map(account => { const worker = TelegramService.getWorker?.(account.id); return { accountId: account.id, status: account.status, worker: worker?.status || 'stopped', lastCheck: worker?.lastCheck || null, error: worker?.error || null }; });
    const activeAccounts = workers.filter(item => item.status === 'connected' || item.worker === 'running').length;
    const activeRules = rules.filter(rule => rule.is_active).length;
    const erroredAccounts = workers.filter(item => item.status === 'error' || item.worker === 'error').length;
    const systemStatus = settings?.enabled === false ? 'stopped' : erroredAccounts > 0 ? 'degraded' : activeAccounts > 0 && activeRules > 0 ? 'running' : 'degraded';
    return { accounts: accountRows, rules, settings, stats: stats || { discovered: 0, matched: 0, new_count: 0, saved: 0, deleted: 0, review: 0 }, results: resultRows, logs, notifications, workers, engine: 'local-semantic-v1', system: { status: systemStatus, activeRules, linkedAccounts: accountRows.length, accountsRunningRules: settings?.enabled === false ? 0 : activeAccounts, lastProcessedAt: resultRows[0]?.analyzed_at || null, lastConversation: resultRows[0] || null, errors: erroredAccounts }, monitoring: { activeAccounts, totalAccounts: accountRows.length, aiOnline: settings?.enabled !== false } };
  },
  async results(userId, filters = {}) {
    await ensureTables();
    await ensureBlockedUsersTable();
    await ensureBlockedGroupsTable();
    const conditions = ['r.user_id=$1', `(NOT EXISTS (SELECT 1 FROM telegram_keyword_blocked_users bu WHERE bu.user_id=r.user_id AND bu.telegram_user_id=r.sender_id AND bu.is_active=true AND r.detected_at >= bu.blocked_at) AND NOT EXISTS (SELECT 1 FROM telegram_smart_blocked_groups bg WHERE bg.user_id=r.user_id AND bg.group_id=regexp_replace(r.chat_id,'n$','') AND bg.is_active=true AND r.detected_at >= bg.blocked_at))`]; const params = [userId]; let n = 2;
    if (filters.search) { conditions.push(`(r.message_text ILIKE $${n} OR r.sender_name ILIKE $${n} OR r.sender_username ILIKE $${n} OR r.chat_id ILIKE $${n} OR r.reason ILIKE $${n} OR a.name ILIKE $${n} OR sr.name ILIKE $${n})`); params.push(`%${filters.search}%`); n++; }
    if (filters.account_id) { conditions.push(`r.telegram_account_id=$${n++}`); params.push(filters.account_id); }
    if (filters.rule_id) { conditions.push(`r.rule_id=$${n++}`); params.push(filters.rule_id); }
    if (filters.status) { conditions.push(`r.status=$${n++}`); params.push(filters.status); }
    if (filters.saved === 'true') conditions.push('r.is_saved=true');
    if (filters.pinned === 'true') conditions.push('r.is_pinned=true');
    if (filters.min_score !== undefined && filters.min_score !== '') { conditions.push(`r.match_score >= $${n++}`); params.push(Math.max(0, Math.min(100, Number(filters.min_score) || 0))); }
    const limit = Math.min(Math.max(Number(filters.limit || 50), 1), MAX_LIMIT); const offset = Math.max(Number(filters.offset || 0), 0); params.push(limit, offset);
    return (await queryAll(`SELECT r.*,sr.name AS rule_name,sr.min_score AS rule_min_score,a.name AS account_name,a.username AS account_username,(bu.id IS NOT NULL) AS blocked_user_active,(bg.id IS NOT NULL) AS blocked_group_active FROM telegram_smart_results r JOIN telegram_smart_rules sr ON sr.id=r.rule_id JOIN telegram_accounts a ON a.id=r.telegram_account_id LEFT JOIN telegram_keyword_blocked_users bu ON bu.user_id=r.user_id AND bu.telegram_user_id=r.sender_id AND bu.is_active=true LEFT JOIN telegram_smart_blocked_groups bg ON bg.user_id=r.user_id AND bg.group_id=regexp_replace(r.chat_id,'n$','') AND bg.is_active=true WHERE ${conditions.join(' AND ')} ORDER BY r.is_pinned DESC,r.is_saved DESC,r.detected_at DESC LIMIT $${n++} OFFSET $${n}`, params)).map(decorate);
  },
  async notifications(userId, limit = 30) {
    await ensureTables();
    return (await queryAll(`SELECT n.*,r.message_text,r.chat_username,r.chat_type,r.message_id,a.name AS account_name FROM telegram_smart_notifications n LEFT JOIN telegram_smart_results r ON r.id=n.result_id LEFT JOIN telegram_accounts a ON a.id=n.telegram_account_id WHERE n.user_id=$1 ORDER BY n.created_at DESC LIMIT $2`, [userId, Math.min(100, Math.max(1, Number(limit) || 30))])).map(item => ({ ...item, payload: safeJson(item.payload), message_link: telegramMessageLink(item.chat_id, item.chat_username, item.message_id, item.chat_type) }));
  },
  async markNotificationRead(userId, id) {
    await ensureTables();
    const row = await queryOne(`UPDATE telegram_smart_notifications SET is_read=true,read_at=COALESCE(read_at,NOW()) WHERE id=$1 AND user_id=$2 RETURNING *`, [id, userId]);
    if (!row) throw new Error('الإشعار غير موجود');
    return row;
  },
  async markAllNotificationsRead(userId) {
    await ensureTables();
    const result = await query(`UPDATE telegram_smart_notifications SET is_read=true,read_at=COALESCE(read_at,NOW()) WHERE user_id=$1 AND is_read=false`, [userId]);
    return { updated: result.rowCount || 0 };
  },
  async createRule(userId, body = {}) {
    await ensureTables();
    const name = String(body.name || '').trim(); const instructions = String(body.instructions || body.description || '').trim();
    if (!name) throw Object.assign(new Error('اسم القاعدة مطلوب'), { code: 'RULE_NAME_REQUIRED' });
    if (!instructions) throw Object.assign(new Error('تعليمات الذكاء الاصطناعي مطلوبة'), { code: 'RULE_INSTRUCTIONS_REQUIRED' });
    const row = await queryOne(`INSERT INTO telegram_smart_rules(user_id,name,description,instructions,match_mode,min_score,priority,account_ids,group_mode,group_ids,exclude_group_ids,is_active) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`, [userId, name, body.description || '', instructions, body.match_mode || 'balanced', Math.max(0, Math.min(100, Number(body.min_score) || DEFAULT_SCORE)), body.priority || 'medium', JSON.stringify(asArray(body.account_ids)), body.group_mode || 'all', JSON.stringify(asArray(body.group_ids)), JSON.stringify(asArray(body.exclude_group_ids)), body.is_active !== false]);
    await this.log(userId, row, null, 'rule.created', null, `تم إنشاء القاعدة ${row.name}`);
    return row;
  },
  async updateRule(userId, id, body = {}) {
    await ensureTables();
    const current = await queryOne(`SELECT * FROM telegram_smart_rules WHERE id=$1 AND user_id=$2`, [id, userId]); if (!current) throw new Error('القاعدة غير موجودة');
    const row = await queryOne(`UPDATE telegram_smart_rules SET name=$1,description=$2,instructions=$3,match_mode=$4,min_score=$5,priority=$6,account_ids=$7,group_mode=$8,group_ids=$9,exclude_group_ids=$10,is_active=$11,updated_at=NOW() WHERE id=$12 AND user_id=$13 RETURNING *`, [String(body.name ?? current.name).trim(), body.description ?? current.description, String(body.instructions ?? current.instructions).trim(), body.match_mode || current.match_mode, Math.max(0, Math.min(100, Number(body.min_score ?? current.min_score) || DEFAULT_SCORE)), body.priority || current.priority, JSON.stringify(asArray(body.account_ids ?? current.account_ids)), body.group_mode || current.group_mode, JSON.stringify(asArray(body.group_ids ?? current.group_ids)), JSON.stringify(asArray(body.exclude_group_ids ?? current.exclude_group_ids)), body.is_active ?? current.is_active, id, userId]);
    if (row) await this.log(userId, row, null, 'rule.updated', null, `تم تعديل القاعدة ${row.name}`);
    return row;
  },
  async toggleRule(userId, id, active) { const row = await queryOne(`UPDATE telegram_smart_rules SET is_active=$1,updated_at=NOW() WHERE id=$2 AND user_id=$3 RETURNING *`, [Boolean(active), id, userId]); if (!row) throw new Error('القاعدة غير موجودة'); await this.log(userId, row, null, 'rule.status_changed', null, row.is_active ? 'تم تفعيل القاعدة' : 'تم إيقاف القاعدة'); return row; },
  async deleteRule(userId, id) { const rule = await queryOne(`SELECT * FROM telegram_smart_rules WHERE id=$1 AND user_id=$2`, [id, userId]); if (!rule) throw new Error('القاعدة غير موجودة'); const result = await query(`DELETE FROM telegram_smart_rules WHERE id=$1 AND user_id=$2`, [id, userId]); if (!result.rowCount) throw new Error('القاعدة غير موجودة'); await this.log(userId, rule, null, 'rule.deleted', null, `تم حذف القاعدة ${rule.name}`); return { deleted: true }; },
  async unblockGroup(userId, groupId) {
    await ensureTables(); await ensureBlockedGroupsTable();
    const id = normalizeTelegramId(groupId);
    if (!id) throw Object.assign(new Error('معرف المجموعة مطلوب لإلغاء الحظر'), { code: 'GROUP_ID_REQUIRED' });
    const row = await queryOne(`UPDATE telegram_smart_blocked_groups SET is_active=false,updated_at=NOW() WHERE user_id=$1 AND group_id=$2 AND is_active=true RETURNING *`, [userId, id]);
    if (!row) throw Object.assign(new Error('المجموعة غير موجودة في قائمة الحظر'), { code: 'BLOCKED_GROUP_NOT_FOUND' });
    await query(`UPDATE telegram_smart_results SET status=CASE WHEN is_match THEN 'new' ELSE 'dismissed' END,updated_at=NOW() WHERE user_id=$1 AND chat_id=$2 AND status='blocked'`, [userId, id]);
    SocketBridge.to(`user:${userId}`).emit('telegram:smart:group_unblocked', { group_id: id, blockedGroup: row });
    return { unblocked: true, group: row };
  },
  async blockGroup(userId, resultId, body = {}) {
    await ensureTables(); await ensureBlockedGroupsTable();
    const result = await queryOne(`SELECT chat_id,chat_title,chat_username,chat_type FROM telegram_smart_results WHERE id=$1 AND user_id=$2`, [resultId, userId]);
    if (!result || !String(result.chat_id || '').trim()) throw Object.assign(new Error('لا يوجد Telegram Chat ID موثوق لهذه المجموعة'), { code: 'GROUP_ID_REQUIRED' });
    const group = await queryOne(`INSERT INTO telegram_smart_blocked_groups(user_id,group_id,group_title,group_username,group_type,blocked_by,reason,is_active,blocked_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,true,NOW(),NOW()) ON CONFLICT(user_id,group_id) DO UPDATE SET group_title=COALESCE(EXCLUDED.group_title,telegram_smart_blocked_groups.group_title),group_username=COALESCE(EXCLUDED.group_username,telegram_smart_blocked_groups.group_username),group_type=COALESCE(EXCLUDED.group_type,telegram_smart_blocked_groups.group_type),blocked_by=EXCLUDED.blocked_by,reason=EXCLUDED.reason,is_active=true,blocked_at=NOW(),updated_at=NOW() RETURNING *`, [userId, normalizeTelegramId(result.chat_id), result.chat_title || null, result.chat_username || null, result.chat_type || null, userId, body.reason || 'حظر من المحادثات الذكية']);
    await query(`UPDATE telegram_smart_results SET status='blocked',updated_at=NOW() WHERE user_id=$1 AND regexp_replace(chat_id,'n$','')=$2`, [userId, normalizeTelegramId(result.chat_id)]);
    SocketBridge.to(`user:${userId}`).emit('telegram:smart:group_blocked', { group_id: normalizeTelegramId(result.chat_id), blockedGroup: group });
    return { blocked: true, group };
  },
  async unblockUser(userId, telegramUserId) {
    await ensureTables(); await ensureBlockedUsersTable();
    const id = String(telegramUserId ?? '').trim();
    if (!id) throw Object.assign(new Error('معرف Telegram مطلوب لإلغاء الحظر'), { code: 'SENDER_ID_MISSING' });
    const row = await queryOne(`UPDATE telegram_keyword_blocked_users SET is_active=false,updated_at=NOW() WHERE user_id=$1 AND telegram_user_id=$2 AND is_active=true RETURNING *`, [userId, id]);
    if (!row) throw Object.assign(new Error('المستخدم غير موجود في قائمة الحظر'), { code: 'BLOCKED_USER_NOT_FOUND' });
    await query(`UPDATE telegram_smart_results SET status=CASE WHEN is_match THEN 'new' ELSE 'dismissed' END,updated_at=NOW() WHERE user_id=$1 AND sender_id=$2 AND status='blocked'`, [userId, id]);
    await query(`UPDATE telegram_keyword_blocked_users SET updated_at=NOW() WHERE id=$1`, [row.id]).catch(() => {});
    SocketBridge.to(`user:${userId}`).emit('telegram:smart:user_unblocked', { telegram_user_id: id, blockedUser: row });
    return { unblocked: true, user: row };
  },
  async blockUser(userId, resultId, body = {}) {
    await ensureTables(); await ensureBlockedUsersTable();
    const result = await queryOne(`SELECT sender_id,sender_username,sender_name FROM telegram_smart_results WHERE id=$1 AND user_id=$2`, [resultId, userId]);
    if (!result || !result.sender_id) throw Object.assign(new Error('لا يوجد Telegram User ID موثوق لهذه المحادثة'), { code: 'SENDER_ID_MISSING' });
    const blocked = await queryOne(`INSERT INTO telegram_keyword_blocked_users(user_id,telegram_user_id,telegram_username,display_name,blocked_by,reason,is_active,blocked_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,true,NOW(),NOW()) ON CONFLICT(user_id,telegram_user_id) DO UPDATE SET telegram_username=COALESCE(EXCLUDED.telegram_username,telegram_keyword_blocked_users.telegram_username),display_name=COALESCE(EXCLUDED.display_name,telegram_keyword_blocked_users.display_name),blocked_by=EXCLUDED.blocked_by,reason=EXCLUDED.reason,is_active=true,updated_at=NOW() RETURNING *`, [userId, String(result.sender_id), result.sender_username || null, result.sender_name || null, userId, body.reason || 'حظر من المحادثات الذكية']);
    await query(`UPDATE telegram_smart_results SET status='blocked',updated_at=NOW() WHERE user_id=$1 AND sender_id=$2`, [userId, String(result.sender_id)]);
    await query(`UPDATE telegram_keyword_results SET ignored=true WHERE user_id=$1 AND sender_id=$2`, [userId, String(result.sender_id)]).catch(() => {});
    SocketBridge.to(`user:${userId}`).emit('telegram:smart:user_blocked', { telegram_user_id: String(result.sender_id), blockedUser: blocked });
    return { blocked: true, user: blocked };
  },
  async updateResult(userId, id, body = {}) {
    const fields = []; const values = []; let n = 1;
    if (body.status && ['new', 'review', 'important', 'completed', 'dismissed'].includes(body.status)) { fields.push(`status=$${n++}`); values.push(body.status); }
    for (const key of ['is_saved', 'is_pinned']) if (body[key] !== undefined) { fields.push(`${key}=$${n++}`); values.push(Boolean(body[key])); }
    if (!fields.length) throw new Error('لا يوجد تحديث صالح'); fields.push('updated_at=NOW()'); values.push(id, userId);
    const row = await queryOne(`UPDATE telegram_smart_results SET ${fields.join(',')} WHERE id=$${n++} AND user_id=$${n} RETURNING *`, values); if (!row) throw new Error('نتيجة المحادثة غير موجودة');
    await this.log(userId, null, row.id, 'result.updated', null, `تحديث: ${Object.keys(body).join(', ')}`, row);
    return decorate(row);
  },
  async ignoreMessage(userId, id) { await ensureTables(); const row = await queryOne(`UPDATE telegram_smart_results SET status='dismissed',updated_at=NOW() WHERE id=$1 AND user_id=$2 RETURNING *`, [id, userId]); if (!row) throw Object.assign(new Error('الرسالة غير موجودة'), { code:'RESULT_NOT_FOUND' }); await this.log(userId, null, id, 'message.ignored', null, 'تم تجاهل الرسالة من المحادثات الذكية', row); SocketBridge.to(`user:${userId}`).emit('telegram:smart:message_ignored', { result: decorate(row) }); return { ignored:true, result:decorate(row) }; },
  async openMessage(userId, id) { await ensureTables(); const row = await queryOne(`SELECT * FROM telegram_smart_results WHERE id=$1 AND user_id=$2`, [id, userId]); if (!row) throw Object.assign(new Error('الرسالة غير موجودة'), { code:'RESULT_NOT_FOUND' }); const link = telegramMessageLink(row.chat_id, row.chat_username, row.message_id, row.chat_type); if (!link) throw Object.assign(new Error('لا يتوفر رابط مباشر موثوق لهذه الرسالة'), { code:'MESSAGE_LINK_UNAVAILABLE' }); await this.log(userId, null, id, 'message.opened', null, 'تم طلب فتح الرسالة في Telegram', row); return { opened:true, message_link:link }; },
  async openPrivateChat(userId, id) { await ensureTables(); const row = await queryOne(`SELECT * FROM telegram_smart_results WHERE id=$1 AND user_id=$2`, [id, userId]); if (!row || !row.sender_id) throw Object.assign(new Error('لا يتوفر معرف مستخدم موثوق'), { code:'SENDER_ID_MISSING' }); const worker = TelegramService.getWorker?.(row.telegram_account_id); if (!worker?.client || worker.status !== 'running') throw Object.assign(new Error('الحساب المصدر غير متصل'), { code:'ACCOUNT_OFFLINE' }); try { const { Api } = require('telegram'); const userIdValue = BigInt(String(row.sender_id).replace(/n$/,'')); const accessHash = row.sender_access_hash ? BigInt(String(row.sender_access_hash).replace(/n$/,'')) : null; const peer = accessHash === null ? await worker.client.getInputEntity(userIdValue) : new Api.InputPeerUser({ userId:userIdValue, accessHash }); await worker.client.getEntity(peer); const username = String(row.sender_username || '').replace(/^@+/, '').trim(); return { opened:true, telegram_user_id:String(row.sender_id), direct_link: username ? `https://t.me/${encodeURIComponent(username)}` : `tg://openmessage?user_id=${encodeURIComponent(String(row.sender_id))}` }; } catch (error) { throw Object.assign(new Error('تعذر التحقق من صلاحية فتح المحادثة الخاصة'), { code:'SENDER_RESOLVE_FAILED', cause:error }); } },
  async deleteMessage(userId, id) { await ensureTables(); const row = await queryOne(`SELECT * FROM telegram_smart_results WHERE id=$1 AND user_id=$2`, [id, userId]); if (!row) throw Object.assign(new Error('الرسالة غير موجودة'), { code:'RESULT_NOT_FOUND' }); const worker = TelegramService.getWorker?.(row.telegram_account_id); if (!worker?.client || worker.status !== 'running') throw Object.assign(new Error('الحساب المصدر غير متصل'), { code:'ACCOUNT_OFFLINE' }); const messageId = Number(row.message_id); if (!Number.isSafeInteger(messageId) || messageId <= 0) throw Object.assign(new Error('معرف الرسالة غير صالح للحذف عبر Telegram'), { code:'MESSAGE_ID_INVALID' }); try { const entity = await worker.client.getInputEntity(String(row.chat_id)); await worker.client.deleteMessages(entity, [messageId], { revoke:true }); } catch (error) { throw Object.assign(new Error('تعذر حذف الرسالة من Telegram؛ تحقق من صلاحيات الحساب'), { code:'TELEGRAM_DELETE_FAILED', cause:error }); } const updated = await queryOne(`UPDATE telegram_smart_results SET deleted_in_telegram=true,deleted_at=NOW(),status='deleted',updated_at=NOW() WHERE id=$1 AND user_id=$2 RETURNING *`, [id, userId]); await this.log(userId, null, id, 'message.deleted', null, 'تم حذف الرسالة من Telegram', updated); SocketBridge.to(`user:${userId}`).emit('telegram:smart:message_deleted', { result:decorate(updated) }); return { deleted:true, result:decorate(updated) }; },
  async deleteResult(userId, id) { const result = await query(`DELETE FROM telegram_smart_results WHERE id=$1 AND user_id=$2`, [id, userId]); if (!result.rowCount) throw new Error('نتيجة المحادثة غير موجودة'); await this.log(userId, null, id, 'result.deleted', null, 'تم حذف نتيجة محادثة ذكية'); return { deleted: true }; },
  async testRule(userId, body = {}) { const result = analyzeText(body.instructions || body.description, body.text, body.min_score, body.match_mode); return { ...result, text: String(body.text || '') }; },
  async updateSettings(userId, body = {}) { await ensureTables(); return queryOne(`INSERT INTO telegram_smart_settings(user_id,enabled,default_min_score,context_before,context_after,analysis_language,retention_days,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,NOW()) ON CONFLICT(user_id) DO UPDATE SET enabled=EXCLUDED.enabled,default_min_score=EXCLUDED.default_min_score,context_before=EXCLUDED.context_before,context_after=EXCLUDED.context_after,analysis_language=EXCLUDED.analysis_language,retention_days=EXCLUDED.retention_days,updated_at=NOW() RETURNING *`, [userId, body.enabled !== false, Math.max(0, Math.min(100, Number(body.default_min_score) || DEFAULT_SCORE)), Math.max(0, Math.min(10, Number(body.context_before) || 2)), Math.max(0, Math.min(10, Number(body.context_after) || 2)), body.analysis_language || 'ar', Math.max(1, Math.min(3650, Number(body.retention_days) || 90))]); },
  async log(userId, rule, resultId, decision, score, reason, message = {}) { return query(`INSERT INTO telegram_smart_logs(user_id,rule_id,result_id,telegram_account_id,chat_id,message_id,decision,match_score,reason) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [userId, rule?.id || null, resultId, message.telegram_account_id || null, message.chat_id || null, message.message_id || null, decision, score, reason]); },
  async ingest(accountId, message = {}) {
    await ensureTables(); await ensureBlockedUsersTable(); await ensureBlockedGroupsTable();
    const account = await queryOne(`SELECT id,user_id,name FROM telegram_accounts WHERE id=$1`, [accountId]); if (!account) return { analyzed: 0, matched: 0 };
    if (await isUserBlocked(account.user_id, message.sender_id) || await isGroupBlocked(account.user_id, message.chat_id)) return { analyzed: 0, matched: 0, blocked: true };
    const settings = await queryOne(`SELECT * FROM telegram_smart_settings WHERE user_id=$1`, [account.user_id]); if (settings && settings.enabled === false) return { analyzed: 0, matched: 0, disabled: true };
    const rules = await queryAll(`SELECT * FROM telegram_smart_rules WHERE user_id=$1 AND is_active=true ORDER BY CASE priority WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END,created_at ASC`, [account.user_id]);
    let analyzed = 0; let matched = 0; const output = [];
    for (const rule of rules) {
      if (!accountAllowed(rule, accountId) || !groupAllowed(rule, message.chat_id)) continue;
      if (await isUserBlocked(account.user_id, message.sender_id) || await isGroupBlocked(account.user_id, message.chat_id)) continue;
      const gemini = GeminiAIService.status();
      if (gemini.enabled && gemini.configured) {
        const row = await queryOne(`INSERT INTO telegram_smart_results(user_id,rule_id,telegram_account_id,chat_id,chat_title,chat_username,chat_type,message_id,sender_id,sender_username,sender_name,message_text,message_timestamp,context,match_score,is_match,reason,status,ai_status,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,0,false,'بانتظار تحليل Gemini','new','pending',NOW()) ON CONFLICT(telegram_account_id,chat_id,message_id,rule_id) DO UPDATE SET chat_title=EXCLUDED.chat_title,chat_username=EXCLUDED.chat_username,chat_type=EXCLUDED.chat_type,sender_id=EXCLUDED.sender_id,sender_username=EXCLUDED.sender_username,sender_name=EXCLUDED.sender_name,message_text=EXCLUDED.message_text,message_timestamp=EXCLUDED.message_timestamp,context=EXCLUDED.context,ai_status=CASE WHEN telegram_smart_results.ai_status='completed' THEN telegram_smart_results.ai_status ELSE 'pending' END,updated_at=NOW() RETURNING *`, [account.user_id, rule.id, accountId, String(message.chat_id || ''), message.chat_title || null, message.chat_username || null, message.chat_type || null, String(message.message_id || ''), message.sender_id || null, message.sender_username || null, message.sender_name || null, String(message.text || message.message || '').trim(), message.date ? new Date(message.date) : (message.timestamp ? new Date(message.timestamp) : new Date()), JSON.stringify(message.context || {})]);
        if (!row) continue;
        analyzed++;
        await this.log(account.user_id, rule, row.id, 'gemini.queued', null, 'تم وضع الرسالة في Queue لتحليل Gemini', message);
        let enqueueSucceeded = true;
        try {
          await QueueManager.enqueueGeminiAnalysis({ resultId: row.id, userId: account.user_id, accountId, accountName: account.name, rule, message }, { jobId: `gemini-analysis-${accountId}-${message.chat_id}-${message.message_id}-${rule.id}`.replace(/[^a-zA-Z0-9_-]/g, '_') });
        } catch (queueError) {
          enqueueSucceeded = false;
          await query(`UPDATE telegram_smart_results SET ai_status='failed',status='analysis_failed',ai_error=$1,updated_at=NOW() WHERE id=$2 AND user_id=$3`, ['تعذر وضع المهمة في Queue', row.id, account.user_id]).catch(() => {});
          SocketBridge.to(`user:${account.user_id}`).emit('telegram:smart:analyzed', { result: { ...decorate(row), ai_status: 'failed', status: 'analysis_failed', ai_error: 'تعذر وضع المهمة في Queue' }, analysis: { engine: 'gemini', status: 'failed', error: 'تعذر وضع المهمة في Queue' } });
          console.warn(`[Gemini] queue enqueue failed for ${row.id}: ${queueError.message}`);
        }
        if (!enqueueSucceeded) continue;
        const pending = decorate({ ...row, rule_name: rule.name, account_name: account.name, engine: 'gemini', ai_status: 'pending' });
        output.push(pending);
        SocketBridge.to(`user:${account.user_id}`).emit('telegram:smart:analyzed', { result: pending, analysis: { engine: 'gemini', status: 'pending' } });
        continue;
      }
      const analysis = analyzeText(rule.instructions, message.text || message.message, rule.min_score, rule.match_mode);
      const row = await queryOne(`INSERT INTO telegram_smart_results(user_id,rule_id,telegram_account_id,chat_id,chat_title,chat_username,chat_type,message_id,sender_id,sender_username,sender_name,message_text,message_timestamp,context,match_score,is_match,reason,status,analyzed_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,\'new\',NOW(),NOW()) ON CONFLICT(telegram_account_id,chat_id,message_id,rule_id) DO UPDATE SET chat_title=EXCLUDED.chat_title,chat_username=EXCLUDED.chat_username,chat_type=EXCLUDED.chat_type,sender_id=EXCLUDED.sender_id,sender_username=EXCLUDED.sender_username,sender_name=EXCLUDED.sender_name,message_text=EXCLUDED.message_text,message_timestamp=EXCLUDED.message_timestamp,context=EXCLUDED.context,match_score=EXCLUDED.match_score,is_match=EXCLUDED.is_match,reason=EXCLUDED.reason,analyzed_at=NOW(),updated_at=NOW() RETURNING *`, [account.user_id, rule.id, accountId, String(message.chat_id || ''), message.chat_title || null, message.chat_username || null, message.chat_type || null, String(message.message_id || ''), message.sender_id || null, message.sender_username || null, message.sender_name || null, String(message.text || message.message || '').trim(), message.date ? new Date(message.date) : (message.timestamp ? new Date(message.timestamp) : new Date()), JSON.stringify(message.context || {}), analysis.score, analysis.isMatch, analysis.reason]);
      if (!row) continue; analyzed++; if (analysis.isMatch) matched++;
      await this.log(account.user_id, rule, row.id, analysis.isMatch ? 'matched' : 'not_matched', analysis.score, analysis.reason, message);
      const decorated = decorate({ ...row, rule_name: rule.name, account_name: account.name, ...analysis }); output.push(decorated);
      if (analysis.isMatch && rule.priority === 'high') {
        const notification = await queryOne(`INSERT INTO telegram_smart_notifications(user_id,result_id,rule_id,telegram_account_id,severity,title,sender_name,sender_username,chat_title,chat_id,message_id,message_excerpt,rule_name,match_score,payload) SELECT $1,$2,$3,$4,'high','أولوية عالية',$5,$6,$7,$8,$9,$10,$11,$12,$13 WHERE NOT EXISTS (SELECT 1 FROM telegram_smart_notifications WHERE user_id=$1 AND result_id=$2) RETURNING *`, [account.user_id, row.id, rule.id, accountId, message.sender_name || null, message.sender_username || null, message.chat_title || message.chat_username || message.chat_id || null, message.chat_id || null, message.message_id || null, String(message.text || message.message || '').slice(0, 240), rule.name, analysis.score, JSON.stringify({ reason: analysis.reason, message_id: message.message_id, chat_id: message.chat_id })]);
        if (notification) SocketBridge.to(`user:${account.user_id}`).emit('telegram:smart:high_priority', { notification: { ...notification, message_link: telegramMessageLink(message.chat_id, message.chat_username, message.message_id, message.chat_type) }, result: decorated });
      }
      SocketBridge.to(`user:${account.user_id}`).emit('telegram:smart:analyzed', { result: decorated, analysis });
    }
    return { analyzed, matched, results: output };
  },
  async processGeminiJob(job) {
    await ensureTables(); await ensureBlockedUsersTable(); await ensureBlockedGroupsTable();
    const { resultId, userId, accountId, accountName, rule, message } = job.data || {};
    if (await isUserBlocked(userId, message?.sender_id) || await isGroupBlocked(userId, message?.chat_id)) {
      await query(`UPDATE telegram_smart_results SET ai_status='blocked',status='blocked',ai_error=NULL,updated_at=NOW() WHERE id=$1 AND user_id=$2`, [resultId, userId]);
      await this.log(userId, rule, resultId, 'gemini.blocked', null, 'تم تجاوز المهمة لأن المستخدم محظور', message || {}).catch(() => {});
      return { blocked: true, resultId };
    }
    await query(`UPDATE telegram_smart_results SET ai_status='processing',ai_error=NULL,updated_at=NOW() WHERE id=$1 AND user_id=$2`, [resultId, userId]);
    SocketBridge.to(`user:${userId}`).emit('telegram:smart:analyzed', { result: { id: resultId, user_id: userId, ai_status: 'processing', status: 'new' }, analysis: { engine: 'gemini', status: 'processing' } });
    try {
      const analysis = await GeminiAIService.analyze({ rule, message, context: message?.context || [] });
      if (await isUserBlocked(userId, message?.sender_id) || await isGroupBlocked(userId, message?.chat_id)) {
        await query(`UPDATE telegram_smart_results SET ai_status='blocked',status='blocked',ai_error=NULL,updated_at=NOW() WHERE id=$1 AND user_id=$2`, [resultId, userId]);
        await this.log(userId, rule, resultId, 'gemini.blocked_after_analysis', null, 'تم تجاوز نتيجة التحليل لأن الحظر أصبح فعالًا أثناء التنفيذ', message || {}).catch(() => {});
        return { blocked: true, resultId };
      }
      const isMatch = Boolean(analysis.matched) && analysis.score >= Math.max(0, Math.min(100, Number(rule.min_score) || DEFAULT_SCORE));
      const status = isMatch ? 'new' : 'dismissed';
      const row = await queryOne(`UPDATE telegram_smart_results SET match_score=$1,is_match=$2,reason=$3,summary=$4,category=$5,ai_priority=$6,ai_confidence=$7,ai_model=$8,ai_request_id=$9,ai_api_version=$10,processing_time=$11,retry_count=$12,ai_status='completed',ai_error=NULL,analyzed_at=NOW(),status=$13,updated_at=NOW() WHERE id=$14 AND user_id=$15 RETURNING *`, [analysis.score, isMatch, analysis.reason, analysis.summary, analysis.category, analysis.priority, analysis.confidence, analysis.ai_model, analysis.ai_request_id, analysis.ai_api_version, analysis.processing_time, job.attemptsMade || analysis.retry_count || 0, status, resultId, userId]);
      if (!row) throw new Error('نتيجة المحادثة غير موجودة');
      await this.log(userId, rule, row.id, isMatch ? 'gemini.matched' : 'gemini.not_matched', analysis.score, analysis.reason, message);
      const decorated = decorate({ ...row, rule_name: rule.name, account_name: accountName, ...analysis, is_match: isMatch, ai_status: 'completed' });
      if (isMatch && analysis.priority === 'high') {
        const notification = await queryOne(`INSERT INTO telegram_smart_notifications(user_id,result_id,rule_id,telegram_account_id,severity,title,sender_name,sender_username,chat_title,chat_id,message_id,message_excerpt,rule_name,match_score,payload) SELECT $1,$2,$3,$4,'high','أولوية عالية',$5,$6,$7,$8,$9,$10,$11,$12,$13 WHERE NOT EXISTS (SELECT 1 FROM telegram_smart_notifications WHERE user_id=$1 AND result_id=$2) RETURNING *`, [userId, row.id, rule.id, accountId, message.sender_name || null, message.sender_username || null, message.chat_title || message.chat_username || message.chat_id || null, message.chat_id || null, message.message_id || null, analysis.summary, rule.name, analysis.score, JSON.stringify({ reason: analysis.reason, ai_request_id: analysis.ai_request_id })]);
        if (notification) SocketBridge.to(`user:${userId}`).emit('telegram:smart:high_priority', { notification, result: decorated });
      }
      SocketBridge.to(`user:${userId}`).emit('telegram:smart:analyzed', { result: decorated, analysis });
      return decorated;
    } catch (error) {
      const retryCount = Number(job.attemptsMade || 0);
      const errorMessage = String(error.message || 'فشل تحليل Gemini').slice(0, 500);
      const quotaExhausted = error?.status === 429 || error?.code === 429 || error?.code === 'RESOURCE_EXHAUSTED' || /RESOURCE_EXHAUSTED|quota exceeded|status code: 429|\b429\b/i.test(errorMessage);
      const terminalFailure = quotaExhausted || retryCount >= Math.max(0, Number(job.opts?.attempts || 3) - 1);
      const failureStatus = terminalFailure ? 'failed' : 'retrying';
      await query(`UPDATE telegram_smart_results SET ai_status=$1::varchar,status=CASE WHEN $1::varchar='failed' THEN 'analysis_failed' ELSE status END,ai_error=$2::text,retry_count=$3::int,updated_at=NOW() WHERE id=$4::uuid AND user_id=$5::uuid`, [failureStatus, errorMessage, retryCount, resultId, userId]).catch(() => {});
      await this.log(userId, rule, resultId, terminalFailure ? 'gemini.failed' : 'gemini.retrying', null, errorMessage, message).catch(() => {});
      SocketBridge.to(`user:${userId}`).emit('telegram:smart:analyzed', { result: { id: resultId, user_id: userId, ai_status: failureStatus, status: terminalFailure ? 'analysis_failed' : 'new', ai_error: errorMessage }, analysis: { engine: 'gemini', status: failureStatus, error: errorMessage, retry_count: retryCount } });
      if (quotaExhausted) return { id: resultId, user_id: userId, ai_status: 'failed', status: 'analysis_failed', ai_error: errorMessage, quota_exhausted: true };
      throw error;
    }
  },
  async startBackground() {
    await ensureTables();
    await purgeSmartConversationDataOnce();
    if (cleanupTimer) return;
    await this.cleanupRetention();
    cleanupTimer = setInterval(() => this.cleanupRetention().catch(error => console.warn(`[TelegramSmart] retention cleanup failed: ${error.message}`)), 60 * 60 * 1000);
    cleanupTimer.unref?.();
  },
  stopBackground() { if (cleanupTimer) clearInterval(cleanupTimer); cleanupTimer = null; },
  async cleanupRetention() {
    await ensureTables();
    const removedResults = await query(`DELETE FROM telegram_smart_results r USING telegram_smart_settings s WHERE r.user_id=s.user_id AND r.detected_at < NOW() - make_interval(days => GREATEST(1, s.retention_days))`, []);
    await query(`DELETE FROM telegram_smart_notifications n WHERE n.result_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM telegram_smart_results r WHERE r.id=n.result_id)`, []).catch(() => {});
    return { removedResults: removedResults.rowCount || 0 };
  },
  async markDeleted(accountId, messageIds, chatId) { const ids = (Array.isArray(messageIds) ? messageIds : [messageIds]).map(id => String(id)).filter(Boolean); if (!ids.length) return { updated: 0 }; const result = await query(`UPDATE telegram_smart_results SET deleted_in_telegram=true,deleted_at=COALESCE(deleted_at,NOW()),status='deleted',updated_at=NOW() WHERE telegram_account_id=$1 AND message_id=ANY($2::text[])${chatId ? ' AND chat_id=$3' : ''} RETURNING *`, chatId ? [accountId, ids, String(chatId)] : [accountId, ids]); return { updated: result.rowCount || 0, results: (result.rows || []).map(decorate) }; },
  async updateMessage(accountId, messageId, text, chatId) { const result = await query(`UPDATE telegram_smart_results SET message_text=$1,updated_at=NOW() WHERE telegram_account_id=$2 AND message_id=$3${chatId ? ' AND chat_id=$4' : ''} RETURNING *`, chatId ? [String(text || ''), accountId, String(messageId), String(chatId)] : [String(text || ''), accountId, String(messageId)]); return { updated: result.rowCount || 0, results: (result.rows || []).map(decorate) }; },
};

Service._normalizeTelegramId = normalizeTelegramId;
module.exports = Service;
