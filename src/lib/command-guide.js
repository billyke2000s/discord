// A pinned list of the commands members can use, kept up to date in the bot-commands channel.
// Only public commands: nothing for staff or admins. Posted once and then edited in place on each start.
const { ChannelType, PermissionFlagsBits: P } = require('discord.js');
const { getSettings, updateSettings } = require('./db');
const { embed } = require('./util');

function guideEmbed(s) {
  const sections = [
    {
      name: '🎵 Music',
      value:
        '`/play` a song name, or a YouTube, Spotify, SoundCloud, Twitch, Vimeo or Bandcamp link (playlists too)\n' +
        '`/queue` see what’s coming up · `/nowplaying` bring the music panel back\n' +
        '`/skip` · `/stop` vote to skip the song or stop the music\n' +
        'The panel’s buttons vote to go back, skip, stop or shuffle. Votes need more than half of the people listening.',
    },
    {
      name: '🩺 Is it working?',
      value: '`/status` checks whether music is working or down, and what to try if you can’t hear it.',
    },
  ];
  if (s.levels?.enabled)
    sections.push({
      name: '🏅 Levels',
      value: '`/rank` your level and XP · `/leaderboard` the most active members\nChatting earns XP, once a minute.',
    });
  sections.push({
    name: '🎂 Birthdays',
    value: '`/birthday set` save your birthday · `/birthday show` see what’s saved (only you see these)',
  });
  if (s.jtc?.lobbyChannel)
    sections.push({
      name: '🔊 Your own voice channel',
      value: `Join <#${s.jtc.lobbyChannel}> to get one. A control panel appears in its chat: lock it for you and your mates, set a limit, rename it, kick someone or hand it over. \`/vc panel\` brings the panel back.`,
    });
  sections.push({ name: '❓ Help', value: '`/help` lists everything you can use.' });
  return embed('info')
    .setTitle('🤖 Bot commands')
    .setDescription('Type `/` in any channel and pick a command.')
    .addFields(sections);
}

// The configured channel, or a unique channel called bot-commands (with or without an emoji).
function findChannel(guild, s) {
  if (s.commandsGuide?.channel === 'off') return null;
  const set = s.commandsGuide?.channel && guild.channels.cache.get(s.commandsGuide.channel);
  if (set) return set;
  const named = guild.channels.cache.filter(
    (c) => c.type === ChannelType.GuildText && /(^|[^a-z])bot-?commands$/i.test(c.name),
  );
  return named.size === 1 ? named.first() : null;
}

// Post or update the guide. Returns the message, or null with a reason.
async function postGuide(guild) {
  const s = getSettings(guild.id);
  const channel = findChannel(guild, s);
  if (!channel) return { message: null, reason: 'no bot-commands channel' };
  const me = guild.members.me;
  if (!channel.permissionsFor(me)?.has([P.ViewChannel, P.SendMessages, P.EmbedLinks]))
    return { message: null, reason: `can't post in #${channel.name}` };
  const payload = { embeds: [guideEmbed(s)] };
  let message = null;
  if (s.commandsGuide?.messageId && s.commandsGuide.channel === channel.id) {
    message = await channel.messages.fetch(s.commandsGuide.messageId).catch(() => null);
    if (message) await message.edit(payload);
  }
  if (!message) {
    message = await channel.send(payload);
    await message.pin().catch(() => {}); // needs Manage Messages; the guide still works unpinned
    updateSettings(guild.id, { commandsGuide: { channel: channel.id, messageId: message.id } });
  }
  return { message, reason: null };
}

module.exports = { guideEmbed, findChannel, postGuide };
