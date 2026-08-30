'use strict';

const assert = require('assert');
const postgresPath = require.resolve('./src/lib/postgres');
const calls = [];

require.cache[postgresPath] = {
  id: postgresPath,
  filename: postgresPath,
  loaded: true,
  children: [],
  paths: [],
  exports: {
    query: async (sql, params = []) => {
      calls.push({ sql, params });
      if (sql.startsWith('UPDATE telegram_keyword_results')) {
        return {
          rows: [{
            id: 'result-1',
            user_id: 'user-1',
            telegram_account_id: 'account-1',
            chat_id: 'chat-1',
            message_id: '42',
            message_text: 'رسالة محفوظة كاملة',
            sender_id: 'original-user-99',
            sender_username: 'original_user',
            deleted_in_telegram: true,
            deleted_at: '2026-08-30T10:00:00.000Z',
          }],
        };
      }
      return { rows: [] };
    },
    queryOne: async () => null,
    queryAll: async () => [],
  },
};

const TelegramKeywordService = require('./src/api/services/TelegramKeywordService');
const SocketBridge = require('./src/core/SocketBridge');
const emitted = [];
const originalTo = SocketBridge.to;
SocketBridge.to = () => ({ emit: (event, payload) => emitted.push({ event, payload }) });

(async () => {
  try {
    const result = await TelegramKeywordService.markMessagesDeleted('account-1', [42, '42'], { channelId: 1 });
    assert.strictEqual(result.marked, 1);
    assert.strictEqual(result.results[0].message_text, 'رسالة محفوظة كاملة');
    assert.ok(calls[0].sql.includes('deleted_in_telegram=true'));
    assert.deepStrictEqual(calls[0].params, ['account-1', '1', ['42']]);
    assert.strictEqual(emitted[0].event, 'telegram:keyword:message_deleted');
    assert.strictEqual(emitted[0].payload.result.deleted_in_telegram, true);
    assert.strictEqual(emitted[0].payload.result.sender_id, 'original-user-99');
    assert.strictEqual(emitted[0].payload.result.sender_username, 'original_user');
    assert.strictEqual(emitted[0].payload.result.sender_link, 'https://t.me/original_user?profile');
    assert.ok(!('deleted_by' in emitted[0].payload.result), 'لا يجب أن تستبدل بيانات المرسل بهوية منفذ الحذف');
    console.log('telegram keyword deletion marking regression: PASS');
  } finally {
    SocketBridge.to = originalTo;
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
