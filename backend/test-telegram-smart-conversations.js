'use strict';
const assert = require('assert');
const Service = require('./src/api/services/TelegramSmartConversationService');

const academic = Service.analyzeText(
  'اكتشف الطالب الذي يطلب مساعدة في بحث جامعي أو مشروع تخرج أو واجب',
  'يا شباب محتاج أحد يساعدني في بحث التخرج وتسليم المشروع',
  70,
  'balanced',
);
assert.strictEqual(academic.isMatch, true, 'يجب أن تفهم القاعدة المعنى الأكاديمي للرسالة');
assert.ok(academic.score >= 70 && academic.score <= 100, 'يجب أن تكون الدرجة ضمن 0-100');
assert.ok(academic.reason.includes('المطابقة') || academic.reason.includes('درجة'), 'يجب حفظ سبب واضح للتحليل');

const unrelated = Service.analyzeText(
  'اكتشف طلبات المساعدة الأكاديمية',
  'صباح الخير، ما أخباركم اليوم؟',
  70,
  'balanced',
);
assert.strictEqual(unrelated.isMatch, false, 'لا يجب اعتبار الرسالة العامة مطابقة تلقائيًا');
assert.ok(unrelated.score < 70, 'يجب أن تبقى الرسالة العامة تحت الحد');

const programming = Service.analyzeText('اكتشف طلبات البرمجة وقواعد البيانات وتصحيح الأكواد ومشاريع الذكاء الاصطناعي', 'محتاج مساعدة في مشروع Python وقاعدة بيانات SQL وتصحيح الكود', 65, 'wide');
assert.strictEqual(programming.isMatch, true, 'يجب اكتشاف الطلبات البرمجية والتقنية');

const cv = Service.analyzeText('اكتشف طلبات السيرة الذاتية CV وATS وتحسين الخبرات والمهارات', 'هل يمكن تحسين السيرة الذاتية وتجهيزها لنظام ATS؟', 65, 'wide');
assert.strictEqual(cv.isMatch, true, 'يجب اكتشاف طلبات CV وATS');

const forgedMedical = Service.analyzeText('اكتشف الخدمات الطبية النظامية وتنظيم المستندات الرسمية فقط واستبعد الأعذار الطبية المزورة', 'أحتاج عذر طبي مزور بسرعة للجامعة', 65, 'wide');
assert.strictEqual(forgedMedical.isMatch, false, 'يجب ألا تعتبر الطلبات الطبية المزورة مطابقة آمنة');

console.log('telegram smart conversations semantic regression: PASS');
