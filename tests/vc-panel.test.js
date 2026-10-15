const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Collection, PermissionsBitField, PermissionFlagsBits, MessageFlags } = require('discord.js');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'vcpanel-'));
const { db } = require('../src/lib/db');
const voice = require('../src/commands/voice');
const { findComponent } = require('../src/commands');

const EVERYONE = 'everyone';
function fakeChannel() {
  const overwrites = new Map();
  const sent = [];
  const channel = {
    id: 'vc1',
    name: 'Bob’s channel',
    userLimit: 0,
    members: new Collection([
      ['owner', { id: 'owner', user: { bot: false } }],
      ['mate', { id: 'mate', user: { bot: false } }],
    ]),
    permissionOverwrites: {
      cache: {
        get: (id) => {
          const o = overwrites.get(id);
          return o && { deny: { has: (bit) => bit === PermissionFlagsBits.Connect && o.Connect === false } };
        },
      },
      edit: async (target, perms) => {
        const id = typeof target === 'string' ? target : target.id;
        overwrites.set(id, { ...(overwrites.get(id) || {}), ...perms });
      },
    },
    setUserLimit: async (n) => {
      channel.userLimit = n;
    },
    setName: async (n) => {
      channel.name = n;
    },
    isTextBased: () => true,
    permissionsFor: () => ({ has: () => true }),
    send: async (p) => {
      sent.push(p);
      return { id: `panel${sent.length}`, edit: async () => {} };
    },
    messages: { fetch: async () => null },
  };
  channel.guild = {
    roles: { everyone: { id: EVERYONE } },
    members: {
      me: { id: 'bot' },
      fetch: async (id) => ({
        id,
        permissions: new PermissionsBitField(),
        voice: { channelId: 'vc1', disconnect: async () => {} },
      }),
    },
    channels: { cache: new Map([['vc1', channel]]) },
  };
  return { channel, overwrites, sent };
}
function press(channel, customId, { userId = 'owner', values, perms = 0n, fields } = {}) {
  const out = {};
  const i = {
    customId,
    guild: channel.guild,
    user: { id: userId },
    memberPermissions: new PermissionsBitField(perms),
    values,
    users: new Collection(values ? [[values[0], { id: values[0], bot: false }]] : []),
    fields: fields && { getTextInputValue: (k) => fields[k] },
    isFromMessage: () => true,
    reply: async (p) => {
      out.reply = p;
    },
    update: async (p) => {
      out.update = p;
    },
    followUp: async (p) => {
      out.followUp = p;
    },
    showModal: async (m) => {
      out.modal = m.toJSON();
    },
  };
  return { i, out, run: () => findComponent(customId)(i) };
}

beforeEach(() => {
  db.exec('DELETE FROM temp_vcs');
  db.prepare("INSERT INTO temp_vcs (channel_id, guild_id, owner_id, created_at) VALUES ('vc1', 'g', 'owner', 0)").run();
});

test('the panel is posted in the channel, pings the owner, and has every control', async () => {
  const { channel, sent } = fakeChannel();
  await voice.refreshPanel(channel);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].content, '<@owner>');
  assert.deepEqual(sent[0].allowedMentions, { users: ['owner'] });
  const ids = sent[0].components.flatMap((r) => r.toJSON().components.map((c) => c.custom_id));
  assert.deepEqual(ids, ['vcp:lock:vc1', 'vcp:limit:vc1', 'vcp:rename:vc1', 'vcp:kick:vc1', 'vcp:transfer:vc1']);
  assert.equal(db.prepare('SELECT panel_id FROM temp_vcs').get().panel_id, 'panel1');
});

test('lock keeps the people already inside, and the button switches to Unlock', async () => {
  const { channel, overwrites } = fakeChannel();
  const lock = press(channel, 'vcp:lock:vc1');
  await lock.run();
  assert.equal(overwrites.get(EVERYONE).Connect, false);
  assert.equal(overwrites.get('owner').Connect, true);
  assert.equal(overwrites.get('mate').Connect, true);
  const first = lock.out.update.components[0].toJSON().components[0];
  assert.equal(first.custom_id, 'vcp:unlock:vc1');
  assert.match(lock.out.update.embeds[0].toJSON().description, /Locked/);
  await press(channel, 'vcp:unlock:vc1').run();
  assert.equal(overwrites.get(EVERYONE).Connect, null);
});

test('only the owner or staff can use the panel', async () => {
  const { channel, overwrites } = fakeChannel();
  const stranger = press(channel, 'vcp:lock:vc1', { userId: 'mate' });
  await stranger.run();
  assert.equal(stranger.out.reply.flags, MessageFlags.Ephemeral);
  assert.match(stranger.out.reply.content, /Only the owner/);
  assert.equal(overwrites.size, 0);
  await press(channel, 'vcp:lock:vc1', { userId: 'mod', perms: PermissionFlagsBits.ManageChannels }).run();
  assert.equal(overwrites.get(EVERYONE).Connect, false);
});

test('limit and rename open a form; submitting it updates the channel and the panel', async () => {
  const { channel } = fakeChannel();
  const btn = press(channel, 'vcp:limit:vc1');
  await btn.run();
  assert.equal(btn.out.modal.custom_id, 'vcpm:limit:vc1');
  const form = press(channel, 'vcpm:limit:vc1', { fields: { n: '4' } });
  await form.run();
  assert.equal(channel.userLimit, 4);
  assert.match(form.out.update.embeds[0].toJSON().description, /2\/4/);
  const bad = press(channel, 'vcpm:limit:vc1', { fields: { n: '500' } });
  await bad.run();
  assert.match(bad.out.reply.content, /0 to 99/);
  await press(channel, 'vcpm:rename:vc1', { fields: { name: 'Squad' } }).run();
  assert.equal(channel.name, 'Squad');
});

test('kick and transfer from the menus', async () => {
  const { channel, overwrites } = fakeChannel();
  const self = press(channel, 'vcp:kick:vc1', { values: ['owner'] });
  await self.run();
  assert.match(self.out.followUp.content, /can’t kick yourself/);
  const k = press(channel, 'vcp:kick:vc1', { values: ['mate'] });
  await k.run();
  assert.equal(overwrites.get('mate').Connect, false);
  assert.match(k.out.followUp.content, /was kicked/);

  const t = press(channel, 'vcp:transfer:vc1', { values: ['mate'] });
  await t.run();
  assert.equal(db.prepare('SELECT owner_id FROM temp_vcs').get().owner_id, 'mate');
  assert.match(t.out.update.embeds[0].toJSON().description, /<@mate>/);
  const old = press(channel, 'vcp:lock:vc1', { userId: 'owner' });
  await old.run();
  assert.match(old.out.reply.content, /Only the owner/, 'previous owner loses control');
});
