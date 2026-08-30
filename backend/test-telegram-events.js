'use strict';

const assert = require('assert');
const telegramEvents = require('telegram/events');
const deletedEvents = require('telegram/events/DeletedMessage');

assert.strictEqual(typeof telegramEvents.NewMessage, 'function');
assert.strictEqual(typeof deletedEvents.DeletedMessage, 'function');
assert.strictEqual(typeof deletedEvents.DeletedMessageEvent, 'function');

console.log('telegram event imports regression: PASS');
