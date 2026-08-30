const jobs = [];
const emitted = [];

jest.mock('../../lib/postgres', () => ({
  query: jest.fn(async (sql) => ({ rowCount: 1, rows: [] })),
  queryOne: jest.fn(async (sql) => {
    if (sql.includes('SELECT id,user_id,name FROM telegram_accounts')) return { id: 'acc-1', user_id: 'user-1', name: 'Test account' };
    if (sql.includes('SELECT * FROM telegram_smart_settings')) return { enabled: true };
    if (sql.includes('SELECT * FROM telegram_smart_rules')) return [{ id: 'rule-1', name: 'قاعدة اختبار', instructions: 'حلل الطلبات التعليمية', min_score: 70, priority: 'high', account_ids: [], group_mode: 'all', group_ids: [], exclude_group_ids: [] }];
    if (sql.includes('INSERT INTO telegram_smart_results')) return { id: 'result-1', user_id: 'user-1', rule_id: 'rule-1', telegram_account_id: 'acc-1', chat_id: 'chat-1', message_id: 'msg-1', message_text: 'أحتاج مساعدة في بحث جامعي', ai_status: 'pending', status: 'new' };
    if (sql.includes('UPDATE telegram_smart_results SET match_score')) return { id: 'result-1', user_id: 'user-1', rule_id: 'rule-1', telegram_account_id: 'acc-1', chat_id: 'chat-1', message_id: 'msg-1', message_text: 'أحتاج مساعدة في بحث جامعي', ai_status: 'completed', status: 'new', match_score: 92, is_match: true };
    return null;
  }),
  queryAll: jest.fn(async (sql) => sql.includes('telegram_smart_rules') ? [{ id: 'rule-1', name: 'قاعدة اختبار', instructions: 'حلل الطلبات التعليمية', min_score: 70, priority: 'high', account_ids: [], group_mode: 'all', group_ids: [], exclude_group_ids: [] }] : []),
}));

jest.mock('../../core/SocketBridge', () => ({
  to: jest.fn(() => ({ emit: jest.fn((event, payload) => emitted.push({ event, payload })) })),
}));

jest.mock('../../lib/QueueManager', () => ({
  enqueueGeminiAnalysis: jest.fn(async (data) => { jobs.push({ data, attemptsMade: 0, opts: { attempts: 3 } }); return { id: 'job-1' }; }),
}));

jest.mock('./TelegramService', () => ({ getWorker: jest.fn(() => null) }));

jest.mock('./GeminiAIService', () => ({
  status: jest.fn(() => ({ enabled: true, configured: true })),
  analyze: jest.fn(async () => ({ matched: true, score: 92, category: 'academic', priority: 'high', reason: 'طلب تعليمي واضح', summary: 'طلب مساعدة في بحث جامعي', confidence: 0.96, ai_model: 'gemini-test', ai_request_id: 'request-1', ai_api_version: 'v1', processing_time: 12, retry_count: 0 })),
}));

test('completes the real service path from ingest to Gemini result', async () => {
  const service = require('./TelegramSmartConversationService');
  const message = { text: 'أحتاج مساعدة في بحث جامعي', chat_id: 'chat-1', chat_title: 'Test chat', message_id: 'msg-1', sender_id: 'sender-1' };

  const queued = await service.ingest('acc-1', message);
  expect(queued.analyzed).toBe(1);
  expect(jobs).toHaveLength(1);
  expect(queued.results[0].ai_status).toBe('pending');

  const completed = await service.processGeminiJob(jobs[0]);
  expect(completed.ai_status).toBe('completed');
  expect(completed.is_match).toBe(true);
  expect(emitted.map(item => item.payload.analysis.status || item.payload.result.ai_status)).toEqual(['pending', 'processing', 'completed']);
});
