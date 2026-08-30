'use strict';

const assert = require('assert');
const postgresPath = require.resolve('./src/lib/postgres');
const calls = [];
let updateMode = false;

require.cache[postgresPath] = {
  id: postgresPath,
  filename: postgresPath,
  loaded: true,
  children: [],
  paths: [],
  exports: {
    query: async (sql, params = []) => {
      calls.push({ method: 'query', sql, params });
      return { rows: [], rowCount: 1 };
    },
    queryOne: async (sql, params = []) => {
      calls.push({ method: 'queryOne', sql, params });
      if (sql.startsWith('SELECT * FROM telegram_keywords WHERE id=')) {
        return { id: 'keyword-1', user_id: 'user-1', keyword: 'قديم', match_mode: 'contains', case_sensitive: false, normalize_arabic: true, search_groups: true, search_channels: true, account_ids: ['old-account'], is_active: true };
      }
      if (sql.startsWith('UPDATE telegram_keywords')) return { id: 'keyword-1', account_ids: [] };
      return { id: 'keyword-new', account_ids: [] };
    },
    queryAll: async () => [],
  },
};

const TelegramKeywordService = require('./src/api/services/TelegramKeywordService');

(async () => {
  await TelegramKeywordService.createKeyword('user-1', { keyword: 'جديدة', account_ids: ['account-a', 'account-b'] });
  const createCall = calls.find(call => call.sql.startsWith('INSERT INTO telegram_keywords'));
  assert.deepStrictEqual(createCall.params[7], '[]', 'الكلمة الجديدة يجب أن تكون عامة حتى لو أرسل العميل حسابات محددة');

  await TelegramKeywordService.updateKeyword('user-1', 'keyword-1', { keyword: 'محدثة', account_ids: ['account-c'] });
  const updateCall = calls.find(call => call.sql.startsWith('UPDATE telegram_keywords'));
  assert.deepStrictEqual(updateCall.params[6], '[]', 'تحديث كلمة قديمة يجب أن يحولها إلى النطاق العام');

  const serviceSource = require('fs').readFileSync(require.resolve('./src/api/services/TelegramKeywordService'), 'utf8');
  assert.ok(serviceSource.includes('WHERE user_id=$1 AND is_active=true`, [account.user_id]'), 'المراقبة يجب أن تجلب كل الكلمات النشطة دون فلترة account_ids');
  console.log('telegram keyword global scope regression: PASS');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
