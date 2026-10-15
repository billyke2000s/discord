const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Collection, MessageFlags, PermissionsBitField, PermissionFlagsBits } = require('discord.js');

// Keep these tests away from the real SQLite file and the log channel.
const logged = [];
let logResult = true; // what the log channel post returns (false = it couldn't be saved)
const rows = { tickets: [], warnings: [{ id: 7, guild_id: 'g', user_id: 'u1' }] };
const fakeDb = {
  prepare: (sql) => ({
    all: () => (/FROM tickets/.test(sql) ? rows.tickets : []),
    get: (_g, id) => (/FROM warnings/.test(sql) ? rows.warnings.find((w) => w.id === id) : null),
    run: (...args) => {
      if (/DELETE FROM warnings WHERE guild_id = \? AND id/.test(sql)) {
        const before = rows.warnings.length;
        rows.warnings = rows.warnings.filter((w) => w.id !== args[1]);
        return { changes: before - rows.warnings.length };
      }
      return { changes: 0 };
    },
  }),
};
require.cache[require.resolve('../src/lib/db')] = {
  exports: { db: fakeDb, getSettings: () => ({ tickets: { staffRole: 'staff' } }) },
};
const realUtil = require('../src/lib/util');
require.cache[require.resolve('../src/lib/util')] = {
  exports: {
    ...realUtil,
    log: async (_g, e, extra) => {
      logged.push({ e, extra });
      return logResult;
    },
  },
};
require.cache[require.resolve('../src/lib/antiraid')] = { exports: {} };
const tickets = require('../src/commands/tickets');
const moderation = require('../src/commands/moderation');

const message = (id, ts, author, content, extra = {}) => [
  id,
  {
    id,
    createdTimestamp: ts,
    author: { tag: author, id: `${author}-id` },
    content,
    attachments: new Collection(),
    embeds: [],
    ...extra,
  },
];

test('ticket transcript lists messages oldest first, across pages, with attachments', async () => {
  const pages = [
    new Collection(
      Array.from({ length: 100 }, (_, i) => message(String(300 - i), 3e12 - i * 1000, 'staff', `reply ${100 - i}`)),
    ),
    new Collection([
      message('2', 1e12, 'member', 'my problem', {
        attachments: new Collection([['a', { url: 'https://cdn/x.png' }]]),
      }),
    ]),
  ];
  let call = 0;
  const seen = [];
  const channel = {
    id: 'c',
    name: '🎫・ticket-bob',
    messages: {
      fetch: async (o) => {
        seen.push(o.before);
        return pages[call++] || new Collection();
      },
    },
  };
  const t = await tickets.buildTranscript(channel);
  assert.equal(t.count, 101);
  assert.equal(t.cut, false);
  assert.deepEqual(seen, [undefined, '201']);
  const lines = t.text.split('\n');
  assert.match(lines[2], /member \(member-id\): my problem \[attachments: https:\/\/cdn\/x\.png\]/);
  assert.match(lines.at(-2), /reply 100/);
});

function closeInteraction({ userId = 'closer', staff = false } = {}) {
  const out = { deleted: false, updated: null, edited: null, replied: null };
  const channel = {
    id: 'c',
    name: '🎫・ticket-bob',
    delete: async () => {
      out.deleted = true;
    },
    messages: { fetch: async () => new Collection([message('1', 1e12, 'bob', 'hi')]) },
  };
  const i = {
    channelId: 'c',
    guildId: 'g',
    channel,
    guild: {},
    user: { id: userId, toString: () => `<@${userId}>` },
    member: { roles: { cache: new Collection(staff ? [['staff', {}]] : []) } },
    memberPermissions: new PermissionsBitField(),
    update: async (p) => {
      out.updated = p;
    },
    editReply: async (p) => {
      out.edited = p;
    },
    reply: async (p) => {
      out.replied = p;
    },
  };
  return { i, out };
}
async function withTimers(fn) {
  const timers = [];
  const real = global.setTimeout;
  global.setTimeout = (cb) => timers.push(cb);
  try {
    await fn();
  } finally {
    global.setTimeout = real;
  }
  for (const t of timers) await t();
}
let ticketRowFor = { user_id: 'bob' };
fakeDb.prepare = ((orig) => (sql) => (/SELECT \* FROM tickets/.test(sql) ? { get: () => ticketRowFor } : orig(sql)))(
  fakeDb.prepare,
);

test('closing a ticket saves the transcript to the log, then deletes the channel', async () => {
  logged.length = 0;
  logResult = true;
  const { i, out } = closeInteraction({ userId: 'bob' });
  await withTimers(() => tickets.components['ticket:confirm'](i));
  assert.equal(logged.length, 1);
  assert.equal(logged[0].extra.files[0].name, 'ticket-bob-transcript.txt');
  assert.match(logged[0].e.toJSON().description, /Transcript of 1 message/);
  assert.match(out.edited.content, /Transcript saved/);
  assert.equal(out.deleted, true);
});

test('if the transcript can’t be saved, the ticket stays open and only staff can force-close', async () => {
  logged.length = 0;
  logResult = false;
  const owner = closeInteraction({ userId: 'bob' });
  await withTimers(() => tickets.components['ticket:confirm'](owner.i));
  assert.equal(owner.out.deleted, false);
  assert.match(owner.out.edited.content, /still open/);
  assert.equal(owner.out.edited.components[0].toJSON().components[0].custom_id, 'ticket:force');

  await withTimers(() => tickets.components['ticket:force'](owner.i));
  assert.equal(owner.out.deleted, false);
  assert.match(owner.out.replied.content, /Only staff/);

  const staff = closeInteraction({ userId: 'mod', staff: true });
  await withTimers(() => tickets.components['ticket:force'](staff.i));
  assert.equal(staff.out.deleted, true);
  assert.match(logged.at(-1).e.toJSON().description, /without a transcript/);
  logResult = true;
});

test('someone else can’t close a ticket; the opener, staff role and Manage Channels can', async () => {
  const stranger = closeInteraction({ userId: 'someone' });
  await tickets.components['ticket:close'](stranger.i);
  assert.match(stranger.out.replied.content, /Only the person who opened/);
  await withTimers(() => tickets.components['ticket:confirm'](stranger.i));
  assert.equal(stranger.out.deleted, false);

  for (const ok of [closeInteraction({ userId: 'bob' }), closeInteraction({ userId: 'mod', staff: true })]) {
    await tickets.components['ticket:close'](ok.i);
    assert.equal(ok.out.replied.content, 'Close this ticket?');
  }
  const admin = closeInteraction({ userId: 'admin' });
  admin.i.memberPermissions = new PermissionsBitField(PermissionFlagsBits.ManageChannels);
  await tickets.components['ticket:close'](admin.i);
  assert.equal(admin.out.replied.content, 'Close this ticket?');
});

test('double-clicking Open ticket creates only one channel', async () => {
  rows.tickets = [];
  let created = 0;
  let release;
  const gate = new Promise((r) => {
    release = r;
  });
  const guild = {
    roles: { everyone: { id: 'everyone' } },
    members: { me: { id: 'bot' } },
    channels: {
      cache: new Map(),
      create: async () => {
        created++;
        await gate;
        return { id: 'new', toString: () => '<#new>', send: async () => {} };
      },
    },
  };
  const replies = [];
  const make = () => ({
    guildId: 'g',
    guild,
    user: { id: 'u', username: 'bob', tag: 'bob', toString: () => '<@u>' },
    reply: async (p) => replies.push(p),
    deferReply: async () => {},
    editReply: async (p) => replies.push(p),
  });
  const first = tickets.components['ticket:open'](make());
  await tickets.components['ticket:open'](make());
  release();
  await first;
  assert.equal(created, 1);
  assert.ok(replies.some((r) => r.flags === MessageFlags.Ephemeral && /already being created/.test(r.content)));
});

test('/untimeout respects role order like the other moderation commands', async () => {
  const untimeout = moderation.commands.find((c) => c.data.name === 'untimeout');
  let removed = false,
    reply;
  const target = {
    id: 't',
    guild: null,
    roles: { highest: { comparePositionTo: () => 0 } },
    timeout: async () => {
      removed = true;
    },
  };
  const guild = {
    ownerId: 'owner',
    members: { me: { id: 'bot', roles: { highest: { comparePositionTo: () => 1 } } }, fetch: async () => target },
  };
  target.guild = guild;
  await untimeout.execute({
    guild,
    user: { id: 'mod', tag: 'mod' },
    member: { id: 'mod', roles: { highest: { comparePositionTo: () => 0 } } },
    options: { getUser: () => ({ id: 't' }) },
    reply: async (p) => {
      reply = p;
    },
  });
  assert.equal(removed, false);
  assert.match(reply.content, /equal or higher role/);
});

test('/delwarn records who deleted which warning in the mod log', async () => {
  logged.length = 0;
  let reply;
  const delwarn = moderation.commands.find((c) => c.data.name === 'delwarn');
  await delwarn.execute({
    guildId: 'g',
    guild: {},
    user: { toString: () => '<@mod>' },
    options: { getInteger: () => 7, getUser: () => null },
    reply: async (p) => {
      reply = p;
    },
  });
  assert.match(reply.content, /Deleted 1/);
  assert.equal(logged.length, 1);
  assert.match(logged[0].e.toJSON().description, /<@u1>[\s\S]*<@mod>[\s\S]*warning #7/);
});

test('joining the lobby twice quickly creates only one voice channel', async () => {
  const voice = require('../src/commands/voice');
  let created = 0;
  let release;
  const gate = new Promise((r) => {
    release = r;
  });
  const lobby = { id: 'lobby', parentId: null, parent: null, bitrate: 64000 };
  const guild = {
    id: 'g',
    maximumBitrate: 96000,
    members: { me: { id: 'bot' } },
    channels: {
      cache: new Map(),
      create: async () => {
        created++;
        await gate;
        return { id: 'vc', delete: async () => {} };
      },
    },
  };
  const member = { id: 'u', displayName: 'Bob', user: { tag: 'bob' }, voice: { setChannel: async () => {} } };
  const join = () =>
    voice.handleVoiceState(
      { channelId: null },
      { channelId: 'lobby', channel: lobby, guild, member },
      { jtc: { lobbyChannel: 'lobby', categoryId: null, defaultLimit: 0 } },
    );
  const first = join();
  await join();
  release();
  await first;
  assert.equal(created, 1);
});

test('/vc transfer records the new owner only after Discord accepts the permission change', async () => {
  const voice = require('../src/commands/voice');
  const vc = voice.commands[0];
  const owners = [];
  fakeDb.prepare = ((orig) => (sql) => {
    if (/SELECT \* FROM temp_vcs/.test(sql)) return { get: () => ({ channel_id: 'vc', owner_id: 'old' }) };
    if (/UPDATE temp_vcs SET owner_id/.test(sql)) return { run: (id) => owners.push(id) };
    return orig(sql);
  })(fakeDb.prepare);
  delete require.cache[require.resolve('../src/commands/voice')];
  const fresh = require('../src/commands/voice').commands[0];
  let reply;
  const channel = {
    members: new Collection([['new', {}]]),
    permissionOverwrites: {
      edit: async () => {
        throw new Error('Missing Permissions');
      },
    },
  };
  const i = {
    user: { id: 'old' },
    guild: { roles: { everyone: {} } },
    member: { voice: { channel }, permissions: new PermissionsBitField() },
    options: { getSubcommand: () => 'transfer', getUser: () => ({ id: 'new', bot: false, toString: () => '<@new>' }) },
    reply: async (p) => {
      reply = p;
    },
    deferred: false,
    replied: false,
  };
  await fresh.execute(i);
  assert.deepEqual(owners, [], 'database unchanged when Discord refuses');
  assert.match(reply.content, /Failed/);
  channel.permissionOverwrites.edit = async () => {};
  await fresh.execute(i);
  assert.deepEqual(owners, ['new']);
  assert.ok(vc);
});
