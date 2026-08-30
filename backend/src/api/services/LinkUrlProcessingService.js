const crypto = require('crypto');

const URL_TOKEN_RE = /https?:\/\/[^\s<>()\[\]{}"'«»]+/gi;
const TRAILING_PUNCTUATION_RE = /[),.;!?؟،؛]+$/g;
const INVITE_CODE_RE = /^[A-Za-z0-9_-]{6,}$/;

function cleanCandidate(value) {
  return String(value || '')
    .trim()
    .replace(/^["'«»()[\]{}<>]+|["'«»()[\]{}<>]+$/g, '')
    .replace(TRAILING_PUNCTUATION_RE, '');
}

function parseSupportedUrl(value) {
  const candidate = cleanCandidate(value);
  if (!candidate) return { ok: false, code: 'EMPTY_INPUT', reason: 'لم يتم إدخال رابط' };
  let parsed;
  try { parsed = new URL(candidate); } catch { return { ok: false, code: 'INVALID_FORMAT', reason: 'صيغة الرابط غير صحيحة' }; }
  const hostname = parsed.hostname.toLowerCase().replace(/^www\./, '');
  if (!['http:', 'https:'].includes(parsed.protocol)) return { ok: false, code: 'UNSUPPORTED_LINK', reason: 'بروتوكول الرابط غير مدعوم' };
  if (hostname !== 'chat.whatsapp.com') return { ok: false, code: 'UNSUPPORTED_LINK', reason: 'نوع الرابط غير مدعوم في نظام الانضمام' };
  const inviteCode = parsed.pathname.replace(/^\/+|\/+$/g, '').split('/')[0] || '';
  if (!INVITE_CODE_RE.test(inviteCode)) return { ok: false, code: 'INVALID_LINK', reason: 'رابط دعوة واتساب غير مكتمل' };
  const canonicalUrl = `https://${hostname}/${inviteCode}`;
  return { ok: true, type: 'whatsapp_group', inviteCode, originalUrl: value, normalizedUrl: canonicalUrl, canonicalUrl, urlHash: crypto.createHash('sha256').update(canonicalUrl).digest('hex') };
}

function extractUrls(text) {
  if (!text || typeof text !== 'string') return [];
  return [...text.matchAll(URL_TOKEN_RE)].map(m => cleanCandidate(m[0]));
}

function parseMany(values) {
  const parsed = [], seen = new Set();
  for (const raw of values || []) {
    const candidates = typeof raw === 'string' ? extractUrls(raw) : [];
    for (const input of (candidates.length ? candidates : [raw])) {
      const result = parseSupportedUrl(input);
      const key = result.ok ? result.canonicalUrl : `invalid:${cleanCandidate(input).toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      parsed.push(result.ok ? result : { ...result, originalUrl: input, normalizedUrl: null, canonicalUrl: null, urlHash: null });
    }
  }
  return parsed;
}

function classifyJoinError(error) {
  const technicalMessage = String(error?.message || error || 'خطأ غير معروف');
  const lower = technicalMessage.toLowerCase();
  const numericCode = Number(error?.output?.statusCode || error?.statusCode || error?.status || error?.code);
  if (/already|already.?participant|already.?member|is.?participant|member.?already/.test(lower) || numericCode === 409) return { status: 'already_joined', errorCode: 'ALREADY_MEMBER', category: 'membership', retryable: false, severity: 'info', userMessage: 'الحساب منضم مسبقًا إلى المجموعة', technicalMessage };
  if (/not.?authenticated|unauth|logged.?out|session|qr|connection.?closed|connection.?reset|stream.?error/.test(lower)) return { status: 'account_error', errorCode: 'ACCOUNT_NOT_READY', category: 'account', retryable: true, severity: 'warning', userMessage: 'جلسة الحساب غير جاهزة أو انقطعت', technicalMessage };
  if (/restrict|forbidden|not.?allowed|permission|blocked|banned/.test(lower) || numericCode === 403) return { status: 'account_restricted', errorCode: 'ACCOUNT_RESTRICTED', category: 'account', retryable: false, severity: 'error', userMessage: 'الحساب مقيد ولا يستطيع تنفيذ الانضمام', technicalMessage };
  if (/rate.?limit|too.?many|flood/.test(lower) || numericCode === 429) return { status: 'rate_limited', errorCode: 'RATE_LIMIT', category: 'temporary', retryable: true, severity: 'warning', userMessage: 'تم تقييد الطلبات مؤقتًا، ستتم إعادة المحاولة لاحقًا', technicalMessage };
  if (/timeout|timed out|network|socket|econn|temporar|502|503|504|disconnect/.test(lower) || [502, 503, 504].includes(numericCode)) return { status: 'temporary_error', errorCode: 'TEMPORARY_NETWORK_ERROR', category: 'temporary', retryable: true, severity: 'warning', userMessage: 'تعذر تنفيذ العملية مؤقتًا بسبب الشبكة أو الخدمة', technicalMessage };
  if (/expired|revoked|invite.?not.?found|not.?found|invalid.?invite|group.?not.?found/.test(lower) || numericCode === 404) return { status: 'expired_link', errorCode: 'LINK_EXPIRED_OR_UNAVAILABLE', category: 'link', retryable: false, severity: 'error', userMessage: 'رابط الدعوة منتهي أو غير متاح', technicalMessage };
  return { status: 'join_failed', errorCode: 'JOIN_FAILED', category: 'join', retryable: false, severity: 'error', userMessage: 'تعذر الانضمام بعد تنفيذ الطلب الفعلي', technicalMessage };
}

module.exports = { cleanCandidate, parseSupportedUrl, extractUrls, parseMany, classifyJoinError };
