'use strict';

const assert = require('assert');
const TelegramKeywordService = require('./src/api/services/TelegramKeywordService');

assert.deepStrictEqual(
  TelegramKeywordService.normalizeDeletedMessageIds([101, '102', 101, '', null]),
  ['101', '102'],
  'يجب تطبيع معرّفات الحذف وإزالة القيم المكررة والفارغة'
);
assert.strictEqual(
  TelegramKeywordService.deletionChatId({ channelId: 987654321n }),
  '987654321',
  'يجب استخراج معرّف القناة من peer الخاص بحذف الرسالة'
);
assert.strictEqual(
  TelegramKeywordService.deletionChatId({}),
  '',
  'يجب استخدام البحث بمعرّف الرسالة فقط عند غياب peer'
);

console.log('telegram keyword deletion helpers regression: PASS');
