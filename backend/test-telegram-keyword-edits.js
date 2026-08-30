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
        return { rows: [{ id: 'result-1', user_id: 'user-1', telegram_account_id: 'account-1', chat_id: '-10042', message_id: '9', message_text: params[0], chat_type: 'supergroup' }] };
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
    const result = await TelegramKeywordService.updateEditedMessage('account-1', 9, 'النص النهائي بعد التعديل', { channelId: 42 });
    assert.strictEqual(result.updated, 1);
    assert.strictEqual(result.results[0].message_text, 'النص النهائي بعد التعديل');
    assert.ok(calls[0].sql.includes('SET message_text=$1'));
    assert.deepStrictEqual(calls[0].params, ['النص النهائي بعد التعديل', 'account-1', '42', ['9']]);
    assert.strictEqual(emitted[0].event, 'telegram:keyword:message_updated');
    assert.strictEqual(emitted[0].payload.result.message_text, 'النص النهائي بعد التعديل');
    console.log('telegram keyword edited message regression: PASS');
  } finally {
    SocketBridge.to = originalTo;
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
