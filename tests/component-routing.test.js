const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'routing-'));
const { findComponent, commands } = require('../src/commands');

// Buttons must reach their handlers through the real router, not just when a test calls the handler directly.
test('every button family is routed to a handler', () => {
  for (const id of [
    'music:queuepage:0123456789abcdef:123:2:3',
    'music:skip',
    'music:stop',
    'music:previous',
    'music:shuffle',
    'music:queue',
    'role:123',
    'ticket:open',
    'ticket:close',
    'ticket:confirm',
    'ticket:force',
    'verify:start',
    'verify:enter',
    'verify:modal',
    'rebuild:confirm',
    'rebuild:modal',
  ])
    assert.equal(typeof findComponent(id), 'function', id);
  assert.equal(findComponent('nothing:here'), null);
});

test('every slash command definition is valid', () => {
  for (const c of commands.values()) assert.ok(c.data.toJSON().name);
});
