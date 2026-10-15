// /status: a simple check anyone can run, to answer "is the music down, or is it just me?"
// Shows nothing about the VPS, other members or settings: only whether each part a member uses works.
// YouTube and Spotify lookups are cached and shared, so many members running it doesn't hammer either service.
const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { embed, log } = require('../lib/util');
const { describePlayback, fmtAgo } = require('../lib/diagnostic-tools');

const PROBE_TTL_MS = 2 * 60_000; // reuse a YouTube/Spotify result for 2 minutes
const USER_COOLDOWN_MS = 20_000;
const STAFF_ALERT_MS = 10 * 60_000; // tell staff at most once every 10 minutes per server
const SPOTIFY_TEST_TRACK = 'https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT';

const lastUse = new Map(); // userId -> time
const lastAlert = new Map(); // guildId -> time
const probes = new Map(); // name -> { ok, at } or { pending }

const timeout = (p, ms) => {
  let timer;
  return Promise.race([
    p,
    new Promise((_, rej) => {
      timer = setTimeout(() => rej(new Error('timed out')), ms);
    }),
  ]).finally(() => clearTimeout(timer));
};

// One shared, cached result per probe. Concurrent callers wait for the same request.
async function probe(name, work, now = Date.now()) {
  const cached = probes.get(name);
  if (cached?.pending) return cached.pending;
  if (cached && now - cached.at < PROBE_TTL_MS) return cached;
  const pending = work()
    .then(
      (ok) => ({ ok: !!ok, at: Date.now() }),
      () => ({ ok: false, at: Date.now() }),
    )
    .then((result) => {
      probes.set(name, result);
      return result;
    });
  probes.set(name, { pending });
  return pending;
}

async function runChecks(client, guildId) {
  const node = client.music.shoukaku.getIdealNode();
  const [youtube, spotify] = node
    ? await Promise.all([
        probe('youtube', async () => {
          const res = await timeout(node.rest.resolve('ytsearch:lofi hip hop'), 10_000);
          return res?.loadType === 'search' && res.data.length > 0;
        }),
        probe('spotify', async () => {
          const sp = await timeout(require('../lib/spotify').load(SPOTIFY_TEST_TRACK), 10_000);
          return sp.tracks.length > 0;
        }),
      ])
    : [null, null];
  const q = client.music.get(guildId);
  let here = { status: 'off', text: 'Nothing is playing right now.' };
  if (q?.current) {
    q.monitor?.check(node?.stats);
    const playback = q.monitor ? describePlayback(q.monitor) : { status: 'ok' };
    here =
      playback.status === 'warn'
        ? { status: 'warn', text: `Playing in <#${q.voiceChannelId}>, but it may be stuck.` }
        : { status: 'ok', text: `Playing in <#${q.voiceChannelId}> · ${q.tracks.length} queued.` };
  }
  return {
    ping: client.ws.ping,
    node: !!node,
    youtube,
    spotify,
    here,
    voiceChannelId: q?.current ? q.voiceChannelId : null,
  };
}

function buildReport(r, memberVoiceId, now = Date.now()) {
  const tick = (ok) => (ok ? '✅' : '❌');
  const lines = [
    `✅ **Bot:** online (Discord ${r.ping} ms)`,
    `${tick(r.node)} **Music server:** ${r.node ? 'connected' : 'down'}`,
  ];
  if (r.node) {
    lines.push(
      `${tick(r.youtube.ok)} **Finding songs (YouTube):** ${r.youtube.ok ? 'working' : 'not working right now'}`,
    );
    lines.push(
      `${r.spotify.ok ? '✅' : '⚠️'} **Spotify links:** ${r.spotify.ok ? 'working' : 'not working right now (song names and YouTube links still work)'}`,
    );
  }
  const hereIcon = { ok: '🎵', warn: '⚠️', off: '➖' }[r.here.status];
  lines.push(`${hereIcon} **Music here:** ${r.here.text}`);

  const down = !r.node || !r.youtube?.ok;
  const stuck = r.here.status === 'warn';
  let title, color, advice;
  if (down) {
    title = '❌ Music is down';
    color = 'bad';
    advice = "It's not you. Staff have been told, so there's no need to report it.";
  } else if (stuck) {
    title = '⚠️ Music may be stuck';
    color = 'warn';
    advice = "Staff have been told. If it doesn't recover in a minute, staff can skip the song.";
  } else if (!r.spotify.ok) {
    title = "⚠️ Spotify links aren't working";
    color = 'warn';
    advice = 'Use a song name or a YouTube link instead for now.';
  } else {
    title = '✅ Everything is working';
    color = 'ok';
    advice =
      r.voiceChannelId && memberVoiceId !== r.voiceChannelId
        ? `Music is playing in <#${r.voiceChannelId}>. Join that channel to hear it.`
        : r.voiceChannelId
          ? "If you can't hear it: check you're not deafened, that the bot's user volume isn't at 0 (right-click the bot), and try leaving and rejoining the channel."
          : 'Use /play to start some music.';
  }
  const ages = [r.youtube, r.spotify].filter(Boolean).map((p) => now - p.at);
  const footer =
    ages.length && Math.max(...ages) >= 30_000
      ? `YouTube and Spotify checked ${fmtAgo(Math.max(...ages))} · run again in a minute for a fresh check`
      : 'Checked just now';
  return { title, color, description: `${lines.join('\n')}\n\n${advice}`, footer, alert: down || stuck };
}

const status = {
  data: new SlashCommandBuilder()
    .setName('status')
    .setDescription('Is the bot and music working? A quick check anyone can run'),
  async execute(interaction) {
    const now = Date.now();
    const last = lastUse.get(interaction.user.id) || 0;
    if (now - last < USER_COOLDOWN_MS) {
      return interaction.reply({
        content: `You just checked. Try again in ${Math.ceil((USER_COOLDOWN_MS - (now - last)) / 1000)} seconds.`,
        flags: MessageFlags.Ephemeral,
      });
    }
    lastUse.set(interaction.user.id, now);
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const result = await runChecks(interaction.client, interaction.guildId);
    const report = buildReport(result, interaction.member?.voice?.channelId);
    await interaction.editReply({
      embeds: [
        embed(report.color)
          .setTitle(report.title)
          .setDescription(report.description)
          .setFooter({ text: report.footer }),
      ],
    });
    if (report.alert && now - (lastAlert.get(interaction.guildId) || 0) >= STAFF_ALERT_MS) {
      lastAlert.set(interaction.guildId, now);
      await log(
        interaction.guild,
        embed('bad').setDescription(
          `🩺 ${interaction.user} ran /status and got **${report.title.replace(/^\S+\s/, '')}**. Run /diagnostics for details.`,
        ),
      );
    }
  },
};

module.exports = {
  commands: [status],
  buildReport,
  probe,
  _reset: () => {
    lastUse.clear();
    lastAlert.clear();
    probes.clear();
  },
};
