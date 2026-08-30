'use strict';
const assert = require('assert');
const service = require('./src/api/services/KeywordMonitoringService');

const msg = (text, id = null) => ({ key: { ...(id ? { id } : {}), remoteJid: '966500000000@s.whatsapp.net' }, messageTimestamp: 1710000000, message: { conversation: text } });

assert.equal(service.normalizeText('  سَعْر   الخدمة  '), 'سعر الخدمة');
assert.equal(service.normalizeText('Hello   WORLD'), 'hello world');
assert.equal(service.extractMessageText({ message: { extendedTextMessage: { text: 'كم السعر؟' } } }), 'كم السعر؟');
assert.equal(service.extractMessageText({ message: { imageMessage: { caption: 'عرض' } } }), 'عرض');
assert.equal(service.extractMessageText({ message: { documentMessage: { caption: 'ملف' } } }), 'ملف');

assert.equal(service._matchesKeyword({ word: 'سعر', match_type: 'contains' }, 'كم سعر الخدمة؟'), true);
assert.equal(service._matchesKeyword({ word: 'سعر', match_type: 'exact' }, 'سعر'), true);
assert.equal(service._matchesKeyword({ word: 'سعر', match_type: 'exact' }, 'كم سعر'), false);
assert.equal(service._matchesKeyword({ word: 'عرض', match_type: 'starts_with' }, 'عرض خاص'), true);
assert.equal(service._matchesKeyword({ word: 'عرض', match_type: 'ends_with' }, 'هذا عرض'), true);
assert.equal(service._matchesKeyword({ word: 'عرض', match_type: 'ends_with' }, 'عرض خاص'), false);
assert.equal(service._matchesKeyword({ word: 'x', match_type: 'multiple', terms: ['سعر', 'خدمة'] }, 'كم سعر الخدمة؟'), true);
assert.equal(service._matchesKeyword({ word: 'x', match_type: 'multiple', terms: ['سعر', 'خدمة'] }, 'كم سعر المنتج؟'), false);
assert.equal(service._matchesKeyword({ word: 'WORLD', match_type: 'contains', case_sensitive: false }, 'hello world'), true);
assert.equal(service._matchesKeyword({ word: 'WORLD', match_type: 'contains', case_sensitive: true }, 'hello world'), false);

const a = service._getMessageId(msg('نص بدون معرف'));
const b = service._getMessageId(msg('نص بدون معرف'));
const c = service._getMessageId(msg('نص مختلف'));
assert.equal(a, b);
assert.notEqual(a, c);
assert.equal(service._getMessageId(msg('نص', 'real-id')), 'real-id');

console.log('keyword-center deep unit tests: ok');
