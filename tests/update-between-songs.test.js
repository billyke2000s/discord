const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'version-notes-'));
const status = fs.mkdtempSync(path.join(os.tmpdir(), 'update-status-'));
process.env.UPDATE_STATUS_DIR = status;
const { db } = require('../src/lib/db');
const notes = require('../src/lib/version-notes');
const bridge = require('../src/lib/update-bridge');

const now = 1_800_000_000;
const write = (name, data) => fs.writeFileSync(path.join(status, name), JSON.stringify(data));
beforeEach(() => {
  for (const f of fs.readdirSync(status)) fs.unlinkSync(path.join(status, f));
  write('heartbeat.json', { schema: 1, at: now, enabled: true, features: ['song-gap'] });
  process.env.BOT_BUILD_VERSION = 'v-old';
});

test('the bot sees an update waiting for the song gap, and ignores stale, disabled or own-version ones', async () => {
  assert.equal(await bridge.pendingUpdate(now), null, 'nothing waiting');
  write('pending.json', { schema: 1, image: 'x', version: 'v-new', since: now - 30 });
  assert.deepEqual(await bridge.pendingUpdate(now), { version: 'v-new', since: now - 30 });
  assert.equal(await bridge.pendingUpdate(now + 25 * 60), null, 'too old: never hold music forever');
  write('heartbeat.json', { schema: 1, at: now - 120, enabled: true });
  assert.equal(await bridge.pendingUpdate(now), null, 'VPS worker stopped');
  write('heartbeat.json', { schema: 1, at: now, enabled: false });
  assert.equal(await bridge.pendingUpdate(now), null, 'updates turned off');
  write('heartbeat.json', { schema: 1, at: now, enabled: true });
  process.env.BOT_BUILD_VERSION = 'v-new';
  assert.equal(await bridge.pendingUpdate(now), null, 'already running that version');
  assert.deepEqual(await bridge.hostFeatures(), []);
  write('heartbeat.json', { schema: 1, at: now, enabled: true, features: ['song-gap'] });
  assert.deepEqual(await bridge.hostFeatures(), ['song-gap']);
  assert.match(bridge.resultText({ state: 'waiting' }), /gap after the current song/);
});

test('start-up notices an update (not a first run or a plain restart) and builds a safe message', () => {
  db.exec('DELETE FROM meta');
  assert.equal(notes.checkUpdated('v1', '["x"]'), null, 'first run');
  assert.equal(notes.checkUpdated('v1', '["x"]'), null, 'plain restart');
  assert.equal(notes.checkUpdated('development'), null);
  const info = notes.checkUpdated('v2', JSON.stringify(['Add **lyrics**', '', 5, 'Fix things']));
  assert.deepEqual(info.notes, ['Add **lyrics**', 'Fix things']);
  assert.equal(
    notes.updateMessage(info),
    "✨ **The bot was updated** to `v2`. What's new:\n• Add \\*\\*lyrics\\*\\*\n• Fix things",
  );
  assert.deepEqual(notes.parseNotes('not json'), []);
  assert.match(notes.updateMessage({ version: 'v3', notes: [] }), /new controls from this song on/);
});
