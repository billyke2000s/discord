// /automod: switch automod rules on and set what they do. Manage Server only. Every rule starts off.
const { SlashCommandBuilder, PermissionFlagsBits: P, ChannelType, MessageFlags } = require('discord.js');
const { embed, log, truncate } = require('../lib/util');
const { getSettings, updateSettings } = require('../lib/db');
const automod = require('../lib/automod');

const eph = (content) => ({ content, flags: MessageFlags.Ephemeral });
const MAX_WORDS = 200;
const MAX_DOMAINS = 100;
const ACTION_TEXT = {
  delete: 'delete the message',
  warn: 'delete it and add a warning',
  timeout: 'delete it and time the member out',
};
const cleanDomain = (d) =>
  String(d)
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .split(/[/?#:]/)[0];

const command = {
  data: new SlashCommandBuilder()
    .setName('automod')
    .setDescription('Set up automatic moderation rules')
    .setDefaultMemberPermissions(P.ManageGuild)
    .addSubcommand((s) => s.setName('show').setDescription('Which rules are on and what they do'))
    .addSubcommand((s) =>
      s
        .setName('rule')
        .setDescription('Turn a rule on or off and choose what it does')
        .addStringOption((o) =>
          o
            .setName('rule')
            .setDescription('Which rule')
            .setRequired(true)
            .addChoices(...automod.RULES.map((r) => ({ name: automod.RULE_NAMES[r], value: r }))),
        )
        .addBooleanOption((o) => o.setName('enabled').setDescription('On or off').setRequired(true))
        .addStringOption((o) =>
          o
            .setName('action')
            .setDescription('What happens (default: keep the current one)')
            .addChoices(
              { name: 'Delete the message', value: 'delete' },
              { name: 'Delete + warning', value: 'warn' },
              { name: 'Delete + timeout', value: 'timeout' },
            ),
        ),
    )
    .addSubcommand((s) =>
      s
        .setName('words-add')
        .setDescription('Block words or phrases (comma-separated; end with * to block every word starting with it)')
        .addStringOption((o) =>
          o.setName('words').setDescription('e.g. badword, bad phrase, slur*').setRequired(true).setMaxLength(1000),
        ),
    )
    .addSubcommand((s) =>
      s
        .setName('words-remove')
        .setDescription('Unblock a word or phrase')
        .addStringOption((o) => o.setName('word').setDescription('Exactly as it was added').setRequired(true)),
    )
    .addSubcommand((s) => s.setName('words-list').setDescription('See the blocked words (only you see this)'))
    .addSubcommand((s) =>
      s
        .setName('links-allow')
        .setDescription('Allow links to a site when the Links rule is on')
        .addStringOption((o) => o.setName('domain').setDescription('e.g. example.com').setRequired(true)),
    )
    .addSubcommand((s) =>
      s
        .setName('links-unallow')
        .setDescription('Stop allowing links to a site')
        .addStringOption((o) => o.setName('domain').setDescription('e.g. example.com').setRequired(true)),
    )
    .addSubcommand((s) =>
      s
        .setName('limits')
        .setDescription('Change the numbers the rules use')
        .addIntegerOption((o) =>
          o
            .setName('max_mentions')
            .setDescription('Most mentions allowed in one message (default 5)')
            .setMinValue(1)
            .setMaxValue(50),
        )
        .addIntegerOption((o) =>
          o
            .setName('spam_messages')
            .setDescription('Messages that count as spam… (default 5)')
            .setMinValue(3)
            .setMaxValue(20),
        )
        .addIntegerOption((o) =>
          o
            .setName('spam_seconds')
            .setDescription('…within this many seconds (default 5)')
            .setMinValue(2)
            .setMaxValue(60),
        )
        .addIntegerOption((o) =>
          o
            .setName('caps_percent')
            .setDescription('Capital letters that count as shouting, in % (default 70)')
            .setMinValue(50)
            .setMaxValue(100),
        )
        .addIntegerOption((o) =>
          o
            .setName('timeout_minutes')
            .setDescription('Timeout length for timeout rules (default 10)')
            .setMinValue(1)
            .setMaxValue(40320),
        ),
    )
    .addSubcommand((s) =>
      s
        .setName('exempt')
        .setDescription('Let a role or channel skip automod (run again to undo)')
        .addRoleOption((o) => o.setName('role').setDescription('Role'))
        .addChannelOption((o) =>
          o
            .setName('channel')
            .setDescription('Channel or category')
            .addChannelTypes(
              ChannelType.GuildText,
              ChannelType.GuildAnnouncement,
              ChannelType.GuildCategory,
              ChannelType.GuildForum,
              ChannelType.GuildVoice,
            ),
        ),
    )
    .addSubcommand((s) =>
      s
        .setName('test')
        .setDescription('Check some text against the rules without doing anything')
        .addStringOption((o) => o.setName('text').setDescription('Text to check').setRequired(true).setMaxLength(2000)),
    ),

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();
    const g = interaction.guildId;
    const cfg = getSettings(g).automod;
    const save = (patch) => updateSettings(g, { automod: patch }).automod;
    const done = (text) =>
      interaction.reply({ embeds: [embed('ok').setDescription(text)], flags: MessageFlags.Ephemeral });
    const audit = (text) => log(interaction.guild, embed('info').setDescription(`🤖 ${interaction.user} ${text}`));

    switch (sub) {
      case 'show': {
        const rules = automod.RULES.map((r) => {
          const rule = cfg.rules[r];
          return `${rule.enabled ? '✅' : '➖'} **${automod.RULE_NAMES[r]}**${rule.enabled ? `: ${ACTION_TEXT[rule.action]}` : ' (off)'}`;
        }).join('\n');
        return interaction.reply({
          flags: MessageFlags.Ephemeral,
          embeds: [
            embed('info')
              .setTitle('Automod')
              .setDescription(rules)
              .addFields(
                {
                  name: 'Blocked words',
                  value: `${cfg.words.length} (see them with /automod words-list)`,
                  inline: true,
                },
                {
                  name: 'Limits',
                  value: `${cfg.maxMentions} mentions · ${cfg.spamMessages} messages in ${cfg.spamSeconds}s · ${cfg.capsPercent}% caps · ${cfg.timeoutMinutes} min timeout`,
                },
                { name: 'Allowed links', value: truncate(cfg.allowedLinks.join(', ') || 'none', 1000) },
                {
                  name: 'Skips automod',
                  value:
                    truncate(
                      [...cfg.exemptRoles.map((id) => `<@&${id}>`), ...cfg.exemptChannels.map((id) => `<#${id}>`)].join(
                        ', ',
                      ) || 'nobody extra',
                      1000,
                    ) + '\nStaff with Manage Messages are always skipped.',
                },
              ),
          ],
        });
      }
      case 'rule': {
        const rule = interaction.options.getString('rule', true);
        const enabled = interaction.options.getBoolean('enabled', true);
        const action = interaction.options.getString('action') || cfg.rules[rule].action;
        save({ rules: { [rule]: { enabled, action } } });
        if (enabled && rule === 'words' && !cfg.words.length) {
          await audit(`turned on the ${automod.RULE_NAMES[rule]} rule.`);
          return done('**Blocked words** is on, but the list is empty. Add words with `/automod words-add`.');
        }
        await audit(
          `turned ${enabled ? 'on' : 'off'} the ${automod.RULE_NAMES[rule]} rule${enabled ? ` (${action})` : ''}.`,
        );
        return done(
          enabled
            ? `**${automod.RULE_NAMES[rule]}** is on. It will ${ACTION_TEXT[action]}.`
            : `**${automod.RULE_NAMES[rule]}** is off.`,
        );
      }
      case 'words-add': {
        const add = interaction.options
          .getString('words', true)
          .split(',')
          .map((w) => w.trim())
          .filter((w) => w && w.length <= 50);
        const words = [...new Set([...cfg.words, ...add])];
        if (words.length > MAX_WORDS) return interaction.reply(eph(`The list can hold at most ${MAX_WORDS} words.`));
        save({ words });
        await audit(`added ${words.length - cfg.words.length} blocked word(s).`);
        const note = cfg.rules.words.enabled
          ? ''
          : ' The rule is off: turn it on with `/automod rule rule:Blocked words enabled:true`.';
        return done(`Added ${words.length - cfg.words.length} word(s); the list has ${words.length}.${note}`);
      }
      case 'words-remove': {
        const word = interaction.options.getString('word', true).trim();
        const words = cfg.words.filter((w) => w.toLowerCase() !== word.toLowerCase());
        if (words.length === cfg.words.length) return interaction.reply(eph('That word isn’t on the list.'));
        save({ words });
        await audit('removed a blocked word.');
        return done(`Removed. The list has ${words.length} word(s).`);
      }
      case 'words-list':
        return interaction.reply(
          eph(
            cfg.words.length
              ? `Blocked words (${cfg.words.length}):\n||${truncate(cfg.words.join(', '), 1900)}||`
              : 'No blocked words yet.',
          ),
        );
      case 'links-allow':
      case 'links-unallow': {
        const domain = cleanDomain(interaction.options.getString('domain', true));
        if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(domain))
          return interaction.reply(eph('That doesn’t look like a domain. Try something like `example.com`.'));
        const allow = sub === 'links-allow';
        const list = allow ? [...new Set([...cfg.allowedLinks, domain])] : cfg.allowedLinks.filter((d) => d !== domain);
        if (list.length > MAX_DOMAINS) return interaction.reply(eph(`At most ${MAX_DOMAINS} allowed sites.`));
        save({ allowedLinks: list });
        await audit(`${allow ? 'allowed' : 'stopped allowing'} links to ${domain}.`);
        return done(
          allow
            ? `Links to **${domain}** (and its subdomains) are allowed.`
            : `Links to **${domain}** are no longer allowed.`,
        );
      }
      case 'limits': {
        const o = interaction.options;
        const patch = {};
        for (const [opt, key] of [
          ['max_mentions', 'maxMentions'],
          ['spam_messages', 'spamMessages'],
          ['spam_seconds', 'spamSeconds'],
          ['caps_percent', 'capsPercent'],
          ['timeout_minutes', 'timeoutMinutes'],
        ]) {
          if (o.getInteger(opt) !== null) patch[key] = o.getInteger(opt);
        }
        if (!Object.keys(patch).length) return interaction.reply(eph('Give at least one number to change.'));
        const next = save(patch);
        await audit('changed automod limits.');
        return done(
          `Now: ${next.maxMentions} mentions · ${next.spamMessages} messages in ${next.spamSeconds}s · ${next.capsPercent}% caps · ${next.timeoutMinutes} min timeout.`,
        );
      }
      case 'exempt': {
        const role = interaction.options.getRole('role');
        const channel = interaction.options.getChannel('channel');
        if (!role && !channel) return interaction.reply(eph('Pick a role or a channel.'));
        const toggle = (list, id) => (list.includes(id) ? list.filter((x) => x !== id) : [...list, id]);
        const next = save({
          ...(role ? { exemptRoles: toggle(cfg.exemptRoles, role.id) } : {}),
          ...(channel ? { exemptChannels: toggle(cfg.exemptChannels, channel.id) } : {}),
        });
        const lines = [];
        if (role)
          lines.push(next.exemptRoles.includes(role.id) ? `${role} skips automod.` : `${role} is checked again.`);
        if (channel)
          lines.push(
            next.exemptChannels.includes(channel.id) ? `${channel} skips automod.` : `${channel} is checked again.`,
          );
        await audit(`changed who skips automod: ${lines.join(' ')}`);
        return done(lines.join('\n'));
      }
      case 'test': {
        const text = interaction.options.getString('text', true);
        // Every rule is tried here, even ones that are off, so admins can try a rule before turning it on.
        const all = {
          ...cfg,
          rules: Object.fromEntries(
            automod.RULES.filter((r) => r !== 'spam').map((r) => [r, { ...cfg.rules[r], enabled: true }]),
          ),
        };
        const mentionCount = new Set(text.match(/<@[!&]?\d+>/g) || []).size;
        const hit = await automod.evaluate({ content: text, mentionCount, edited: true }, all);
        if (!hit) return interaction.reply(eph('✅ Nothing would catch that.'));
        const rule = cfg.rules[hit.rule];
        return interaction.reply(
          eph(
            `🚫 **${automod.RULE_NAMES[hit.rule]}** would catch that (${hit.detail}). ${rule.enabled ? `It's on, so automod would ${ACTION_TEXT[rule.action]}.` : 'That rule is off right now.'}`,
          ),
        );
      }
    }
  },
};

module.exports = { commands: [command] };
