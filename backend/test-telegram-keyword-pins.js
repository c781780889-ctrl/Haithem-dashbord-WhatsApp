'use strict';
const assert = require('assert');

const postgresPath = require.resolve('./src/lib/postgres');
const calls = [];
const pinned = new Map();

const makeChat = (userId, accountId, chatId, extra = {}) => ({
  id: `pin-${accountId}-${chatId}`,
  user_id: userId,
  telegram_account_id: accountId,
  chat_id: chatId,
  chat_title: extra.chat_title || 'مجموعة الاختبار',
  chat_username: extra.chat_username || null,
  chat_type: extra.chat_type || 'supergroup',
  pinned_at: '2026-08-30T10:00:00.000Z',
  updated_at: '2026-08-30T10:00:00.000Z',
});

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
      if (sql.startsWith('SELECT id FROM telegram_accounts') && params[0] !== 'account-missing') return { id: params[0] };
      if (sql.startsWith('DELETE FROM telegram_keyword_pinned_chats')) {
        const key = `${params[0]}:${params[1]}:${params[2]}`;
        const removed = pinned.get(key) || null;
        pinned.delete(key);
        return removed;
      }
      return null;
    },
    queryAll: async (sql, params = []) => {
      calls.push({ method: 'queryAll', sql, params });
      return [];
    },
    withAdvisoryLock: async (key, callback) => {
      assert.strictEqual(key, 'telegram-keyword-pins:user-1');
      return callback({
        query: async (sql, params = []) => {
          calls.push({ method: 'client.query', sql, params });
          if (sql.startsWith('SELECT * FROM telegram_keyword_pinned_chats')) {
            const current = pinned.get(`${params[0]}:${params[1]}:${params[2]}`);
            return { rows: current ? [current] : [] };
          }
          if (sql.startsWith('SELECT COUNT(*)')) return { rows: [{ count: String(pinned.size) }] };
          if (sql.startsWith('INSERT INTO telegram_keyword_pinned_chats')) {
            const row = makeChat(params[0], params[1], params[2], { chat_title: params[3], chat_username: params[4], chat_type: params[5] });
            pinned.set(`${params[0]}:${params[1]}:${params[2]}`, row);
            return { rows: [row] };
          }
          if (sql.startsWith('UPDATE telegram_keyword_pinned_chats')) {
            const key = `${params[0]}:${params[1]}:${params[2]}`;
            const row = { ...pinned.get(key), chat_title: params[3] || pinned.get(key).chat_title, chat_username: params[4] || pinned.get(key).chat_username, chat_type: params[5] || pinned.get(key).chat_type };
            pinned.set(key, row);
            return { rows: [row] };
          }
          return { rows: [] };
        },
      });
    },
  },
};

const TelegramKeywordService = require('./src/api/services/TelegramKeywordService');

(async () => {
  const first = await TelegramKeywordService.toggleChatPin('user-1', {
    telegram_account_id: 'account-1',
    chat_id: '-10042',
    chat_title: 'قناة الاختبار',
    chat_type: 'channel',
    pinned: true,
  });
  assert.strictEqual(first.pinned, true);
  assert.strictEqual(pinned.size, 1);

  const unpinned = await TelegramKeywordService.toggleChatPin('user-1', {
    telegram_account_id: 'account-1',
    chat_id: '-10042',
    pinned: false,
  });
  assert.strictEqual(unpinned.pinned, false);
  assert.strictEqual(pinned.size, 0);

  for (let i = 0; i < 30; i += 1) pinned.set(`user-1:account-1:chat-${i}`, makeChat('user-1', 'account-1', `chat-${i}`));
  await assert.rejects(
    TelegramKeywordService.toggleChatPin('user-1', { telegram_account_id: 'account-1', chat_id: 'chat-over-limit', pinned: true }),
    error => error.code === 'PIN_LIMIT_REACHED' && /30/.test(error.message),
  );
  assert.ok(calls.some(call => call.method === 'client.query' && call.sql.startsWith('SELECT COUNT(*)')));

  await assert.rejects(
    TelegramKeywordService.toggleChatPin('user-1', { telegram_account_id: 'account-missing', chat_id: 'chat-1', pinned: true }),
    error => error.code === 'TELEGRAM_ACCOUNT_NOT_FOUND',
  );

  console.log('telegram keyword pinned chats regression: PASS');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});

module.exports = {};
