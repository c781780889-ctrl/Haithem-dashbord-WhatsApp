'use strict';
const assert = require('assert');
const SystemDB = require('./src/database/SystemDB');
const service = require('./src/api/services/KeywordMonitoringService');

const original = { get: SystemDB.get, all: SystemDB.all, run: SystemDB.run };
const JWTService = require('./src/core/JWTService');
const SocketBridge = require('./src/core/SocketBridge');
const calls = { messages: 0, alerts: 0, notifications: 0, broadcasts: 0 };
const keyword = { id: 'kw-1', word: 'سعر', match_type: 'contains', case_sensitive: false, color: '#00A884', priority: 'normal', notify_enabled: true };

SystemDB.run = async (sql) => {
  if (sql.includes('INSERT INTO kw_messages')) calls.messages++;
  return { rowCount: 1 };
};
SystemDB.all = async (sql) => {
  if (sql.includes('FROM kw_keywords')) return [keyword];
  return [];
};
SystemDB.get = async (sql) => {
  if (sql.includes('INSERT INTO kw_alerts')) { calls.alerts++; return { id: 'alert-1', user_id: 'user-1', matched_keyword: 'سعر', message_text: 'كم سعر الخدمة؟', sender_phone: '966500000000', account_id: 'acc-1', status: 'new' }; }
  if (sql.includes('INSERT INTO kw_notifications')) { calls.notifications++; return { id: 'notification-1', alert_id: 'alert-1' }; }
  return null;
};

(async () => {
  const socketBridge = require('./src/core/SocketBridge');
  const originalTo = socketBridge.to;
  socketBridge.to = () => ({ emit: () => { calls.broadcasts++; } });
  try {
    await service._processQueueJob({ user_id: 'user-1', account_id: 'acc-1', message_id: 'msg-1', payload: { key: { id: 'msg-1', remoteJid: '966500000000@s.whatsapp.net' }, pushName: 'عميل', messageTimestamp: 1710000000, message: { conversation: 'كم سعر الخدمة؟' } } });
    assert.equal(calls.messages, 1);
    assert.equal(calls.alerts, 1);
    assert.equal(calls.notifications, 1);
    assert.equal(calls.broadcasts, 2);
    console.log('keyword-center worker integration simulation: ok');

    const socketHandlers = {};
    const joined = [];
    const fakeSocket = { on: (name, handler) => { socketHandlers[name] = handler; }, join: room => joined.push(room), leave: () => {} };
    SocketBridge.init({ on: (_event, handler) => handler(fakeSocket), to: () => ({ emit: () => {} }) });
    const token = JWTService.issueTokenPair({ id: 'user-1', username: 'test', role: 'user' }).accessToken;
    let ack = null;
    socketHandlers.join_user({ userId: 'user-1', token }, value => { ack = value; });
    assert.deepEqual(ack, { success: true });
    assert.ok(joined.includes('user:user-1'));
    ack = null;
    socketHandlers.join_user({ userId: 'user-2', token }, value => { ack = value; });
    assert.deepEqual(ack, { success: false });
    console.log('keyword-center authenticated socket room test: ok');
  } finally {
    socketBridge.to = originalTo;
    SystemDB.get = original.get; SystemDB.all = original.all; SystemDB.run = original.run;
  }
})().catch(err => { console.error(err); process.exitCode = 1; });
