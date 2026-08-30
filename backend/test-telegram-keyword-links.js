'use strict';

const assert = require('assert');
const TelegramKeywordService = require('./src/api/services/TelegramKeywordService');

assert.strictEqual(
  TelegramKeywordService.directChatLink('123456789', '@alice'),
  'https://t.me/alice',
  'يجب تنظيف @ من username وبناء رابط HTTPS صالح'
);
assert.strictEqual(
  TelegramKeywordService.directChatLink('123456789', 'alice'),
  'https://t.me/alice',
  'يجب بناء رابط HTTPS للمستخدم ذي username'
);
assert.strictEqual(
  TelegramKeywordService.directChatLink('123456789', ''),
  'tg://openmessage?user_id=123456789',
  'يجب استخدام openmessage للمستخدم الذي لا يملك username'
);
assert.strictEqual(
  TelegramKeywordService.directChatLink('123456789', null),
  'tg://openmessage?user_id=123456789',
  'يجب استخدام openmessage عند غياب username'
);
assert.strictEqual(
  TelegramKeywordService.senderProfileLink('123456789', '@alice'),
  'https://t.me/alice?profile',
  'يجب أن يفتح زر حساب المستخدم ملفه الشخصي'
);
assert.strictEqual(
  TelegramKeywordService.telegramMessageLink('-100987654321', 'news_group', '77', 'supergroup'),
  'https://t.me/news_group/77?single',
  'يجب بناء رابط الرسالة العامة باستخدام username المجموعة'
);
assert.strictEqual(
  TelegramKeywordService.telegramMessageLink('-100987654321', '', '77', 'supergroup'),
  'https://t.me/c/987654321/77?single',
  'يجب بناء رابط الرسالة الخاصة بصيغة t.me/c'
);
assert.strictEqual(
  TelegramKeywordService.telegramMessageLink('-456', '', '77', 'group'),
  'tg://openmessage?chat_id=-456&message_id=77',
  'يجب استخدام deep link للمجموعة العادية'
);
assert.strictEqual(
  TelegramKeywordService.telegramMessageLink('-456', '', 'derived:hash', 'group'),
  null,
  'لا يمكن بناء رابط لرسالة بمعرّف مشتق غير حقيقي'
);

console.log('telegram keyword direct links regression: PASS');
