const fs = require('node:fs/promises');
const os = require('node:os');
const { performance, monitorEventLoopDelay } = require('node:perf_hooks');
const { setTimeout: delay } = require('node:timers/promises');

class DiagnosticGate {
  constructor(cooldownMs = 60_000, now = Date.now) {
    this.cooldownMs = cooldownMs;
    this.now = now;
    this.running = false;
    this.until = 0;
  }
  acquire() {
    if (this.running) return { ok: false, message: 'A bot check is already running. Wait for it to finish.' };
    if (this.now() < this.until)
      return {
        ok: false,
        message: `Please wait ${Math.ceil((this.until - this.now()) / 1000)} seconds before running another check. The limit is shared by both diagnostic commands and all admins.`,
      };
    this.running = true;
    this.until = this.now() + this.cooldownMs;
    return {
      ok: true,
      release: () => {
        this.running = false;
      },
    };
  }
}

function parseCpu(text) {
  const fields = /^cpu\s+(.+)$/m.exec(text)?.[1].trim().split(/\s+/).map(Number).slice(0, 8);
  if (!fields || fields.length < 8 || fields.some((x) => !Number.isFinite(x))) return null;
  return { total: fields.reduce((a, b) => a + b, 0), idle: fields[3], wait: fields[4], steal: fields[7] };
}
function cpuDelta(a, b) {
  if (!a || !b || b.total <= a.total) return null;
  const total = b.total - a.total;
  return {
    busy: (100 * (total - (b.idle - a.idle) - (b.wait - a.wait))) / total,
    ioWait: (100 * (b.wait - a.wait)) / total,
    steal: (100 * (b.steal - a.steal)) / total,
  };
}
function parseMemory(text) {
  const values = Object.fromEntries(
    [...text.matchAll(/^(\w+):\s+(\d+)\s+kB$/gm)].map((m) => [m[1], Number(m[2]) * 1024]),
  );
  if (!values.MemTotal || !Number.isFinite(values.MemAvailable)) return null;
  return {
    total: values.MemTotal,
    available: values.MemAvailable,
    swapTotal: values.SwapTotal ?? null,
    swapUsed:
      Number.isFinite(values.SwapTotal) && Number.isFinite(values.SwapFree) ? values.SwapTotal - values.SwapFree : null,
  };
}
const read = async (file) => fs.readFile(file, 'utf8').catch(() => null);
const number = (text) =>
  text !== null && text.trim() !== 'max' && Number.isFinite(Number(text)) ? Number(text) : null;
async function sampleResources() {
  const first = parseCpu((await read('/proc/stat')) || '');
  const processStart = process.cpuUsage(),
    started = performance.now();
  const loop = monitorEventLoopDelay({ resolution: 20 });
  loop.enable();
  try {
    await delay(1000);
    const elapsed = performance.now() - started;
    const cpu = cpuDelta(first, parseCpu((await read('/proc/stat')) || ''));
    const memory = parseMemory((await read('/proc/meminfo')) || '');
    const usage = process.cpuUsage(processStart);
    const [limitText, currentText, quotaText] = await Promise.all([
      read('/sys/fs/cgroup/memory.max'),
      read('/sys/fs/cgroup/memory.current'),
      read('/sys/fs/cgroup/cpu.max'),
    ]);
    const quota = quotaText?.trim().split(/\s+/);
    const cpuLimit = quota && quota[0] !== 'max' && Number(quota[1]) > 0 ? Number(quota[0]) / Number(quota[1]) : null;
    return {
      cpu,
      memory,
      load: os.loadavg()[0],
      hostCores: os.cpus().length,
      botCpu: (usage.user + usage.system) / (elapsed * 10), // percent of one core
      botRss: process.memoryUsage().rss,
      containerMemory: number(currentText),
      containerLimit: number(limitText),
      cpuLimit,
      loopP99Ms: loop.count > 0 ? loop.percentile(99) / 1e6 : null,
      loopMaxMs: loop.count > 0 ? loop.max / 1e6 : null,
    };
  } finally {
    loop.disable();
  }
}

const DOWN_BYTES = 2 * 1024 * 1024,
  UP_BYTES = 256 * 1024,
  LATENCY_SAMPLES = 5;
async function consume(response, limit, expected = null) {
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`test endpoint returned HTTP ${response.status}`);
  }
  if (!response.body) throw new Error('test endpoint returned no body');
  const reader = response.body.getReader();
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > limit) throw new Error('test response exceeded its size limit');
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  if (expected !== null && bytes !== expected) throw new Error('test download was incomplete');
  return bytes;
}
async function speedTest(fetcher = fetch, now = () => performance.now(), timeoutMs = 12_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const result = {
    latencyMs: null,
    variationMs: null,
    downloadMbps: null,
    uploadMbps: null,
    errors: [],
    bytesDownloaded: 0,
    bytesUploaded: 0,
  };
  const request = (url, options = {}) => {
    controller.signal.throwIfAborted();
    return fetcher(url, {
      ...options,
      redirect: 'error',
      signal: controller.signal,
      headers: { 'Cache-Control': 'no-store', 'Accept-Encoding': 'identity', ...(options.headers || {}) },
    });
  };
  const measure = async (name, work) => {
    try {
      await work();
    } catch {
      result.errors.push(
        `${name} unavailable${controller.signal.aborted ? ' (test time limit reached)' : ' (endpoint/network error)'}`,
      );
    }
  };
  try {
    await measure('Response time', async () => {
      const samples = [];
      for (let i = 0; i < LATENCY_SAMPLES; i++) {
        const start = now();
        await consume(await request('https://speed.cloudflare.com/__down?bytes=0'), 1024);
        samples.push(now() - start);
      }
      // Median, so one slow request does not decide the result; range shows how much it varied.
      const sorted = [...samples].sort((a, b) => a - b);
      result.latencyMs = sorted[Math.floor(sorted.length / 2)];
      result.variationMs = sorted[sorted.length - 1] - sorted[0];
    });
    await measure('Download', async () => {
      const start = now();
      result.bytesDownloaded = await consume(
        await request(`https://speed.cloudflare.com/__down?bytes=${DOWN_BYTES}`),
        DOWN_BYTES,
        DOWN_BYTES,
      );
      const elapsed = now() - start;
      if (elapsed <= 0) throw new Error('invalid timing');
      result.downloadMbps = (result.bytesDownloaded * 8) / elapsed / 1000;
    });
    await measure('Upload', async () => {
      const payload = Buffer.alloc(UP_BYTES);
      const start = now();
      await consume(
        await request('https://speed.cloudflare.com/__up', {
          method: 'POST',
          body: payload,
          headers: { 'Content-Type': 'application/octet-stream' },
        }),
        16_384,
      );
      const elapsed = now() - start;
      if (elapsed <= 0) throw new Error('invalid timing');
      result.bytesUploaded = UP_BYTES;
      result.uploadMbps = (UP_BYTES * 8) / elapsed / 1000;
    });
    return result;
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

const icons = { ok: '✅', warn: '⚠️', fail: '❌', unknown: '❔', off: '➖' };
// Words used in the text file, so results can be searched and read outside Discord.
const LABELS = { ok: 'OK', warn: 'WARN', fail: 'FAIL', unknown: 'UNMEASURED', off: 'INFO' };
const ISSUE_NAMES = {
  'position-stalled': 'song position stopped advancing',
  'updates-stale': 'music server stopped sending player updates',
  'voice-disconnected': 'voice connection dropped',
  'voice-ping-high': 'voice connection response was slow',
  'track-stuck': 'audio source stopped supplying frames',
  'track-exception': 'audio source reported an error',
  'voice-closed': 'voice connection closed',
  'play-request-failed': 'song could not start',
};
function describePlayback(monitor, now = Date.now()) {
  if (monitor.paused) return { status: 'off', detail: 'paused' };
  if (!monitor.active) return { status: 'off', detail: 'waiting for a song to start' };
  const problems = [...monitor.alerts].map((x) => ISSUE_NAMES[x] || 'playback warning');
  if (problems.length) return { status: 'warn', detail: problems.join('; ') };
  if (!monitor.last) return { status: 'unknown', detail: 'waiting for the first update from the music server' };
  const age = Math.max(0, Math.round((now - monitor.last.at) / 1000));
  const issue = [...monitor.recent].reverse().find((x) => ISSUE_NAMES[x.event] && now - Date.parse(x.at) <= 300_000);
  return {
    status: issue ? 'warn' : 'ok',
    detail: `no stalls right now (last update ${age}s ago)${issue ? `; in the last 5 minutes: ${ISSUE_NAMES[issue.event]}` : ''}`,
  };
}

// "11 min", "7 h 49 min", "2 days 3 h". Never the ambiguous "7:49".
function fmtUptime(seconds) {
  const s = Math.max(0, Math.floor(seconds));
  const d = Math.floor(s / 86400),
    h = Math.floor((s % 86400) / 3600),
    m = Math.floor((s % 3600) / 60);
  if (d) return `${d} day${d === 1 ? '' : 's'} ${h} h`;
  if (h) return `${h} h ${m} min`;
  return m ? `${m} min` : `${s} s`;
}
// How long ago, in words: "12 min ago", "3 h ago", "2 days ago".
function fmtAgo(ms) {
  const min = Math.max(0, Math.round(ms / 60_000));
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.round(h / 24)} days ago`;
}
// Discord mention syntax means nothing in a text file: turn it into names, IDs and UTC times.
function plainMentions(text, names = {}) {
  return String(text)
    .replace(/<#(\d+)>/g, (_, id) => `#${names.channel?.(id) || 'unknown-channel'} (${id})`)
    .replace(/<@&(\d+)>/g, (_, id) => `@${names.role?.(id) || 'unknown-role'} (${id})`)
    .replace(
      /<t:(\d+)(?::[a-zA-Z])?>/g,
      (_, sec) => `${new Date(Number(sec) * 1000).toISOString().slice(0, 16).replace('T', ' ')} UTC`,
    );
}

const GROUPS = [
  { name: 'Bot', icon: '🤖' },
  { name: 'Music', icon: '🎵' },
  { name: 'Internet', icon: '🌐' },
  { name: 'Server', icon: '🖥️' },
  { name: 'Data & protection', icon: '💾' },
  { name: 'Setup', icon: '⚙️' },
];
const RANK = { fail: 0, warn: 1, unknown: 2, ok: 3, off: 4 };
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

// Two layers: a short plain-English embed (verdict, one line per area, what to do) and a
// complete text file with every number. Next steps appear only for things that need attention.
function formatReport(results, { summaries = {}, names = {}, at = new Date() } = {}) {
  const problems = results
    .filter((r) => r.status === 'fail' || r.status === 'warn')
    .sort((a, b) => RANK[a.status] - RANK[b.status]);
  const unmeasured = results.filter((r) => r.status === 'unknown');
  const failed = problems.some((r) => r.status === 'fail');
  const title = failed
    ? `❌ ${plural(problems.length, 'problem')} found`
    : problems.length
      ? `⚠️ ${plural(problems.length, 'thing')} to review`
      : '✅ Everything looks fine';

  const lines = [];
  for (const group of GROUPS) {
    const rows = results.filter((r) => r.group === group.name);
    if (!rows.length) continue;
    const bad = rows
      .filter((r) => r.status === 'fail' || r.status === 'warn')
      .sort((a, b) => RANK[a.status] - RANK[b.status]);
    let text;
    if (bad.length) text = `${icons[bad[0].status]} ${bad.map((r) => r.name).join(', ')}`;
    else if (
      rows.every((r) => r.status === 'unknown' || r.status === 'off') &&
      rows.some((r) => r.status === 'unknown')
    )
      text = "❔ couldn't check";
    else text = `✅ ${summaries[group.name] || 'fine'}`;
    lines.push(`${group.icon} **${group.name}** · ${text}`);
  }
  let description = lines.join('\n');
  if (problems.length) {
    const shown = problems
      .slice(0, 5)
      .map((r) => `${icons[r.status]} **${r.name}:** ${r.detail}${r.action ? `\n→ ${r.action}` : ''}`);
    if (problems.length > 5) shown.push(`…and ${problems.length - 5} more in the attached file.`);
    description += `\n\n**What to do**\n${shown.join('\n')}`;
  }
  if (unmeasured.length) description += `\n\n❔ Couldn't measure: ${unmeasured.map((r) => r.name).join(', ')}`;
  if (description.length > 4000) description = `${description.slice(0, 3950)}\n…the rest is in the attached file.`;

  const plain = (text) => plainMentions(text, names);
  const row = (r) =>
    `  ${LABELS[r.status].padEnd(10)} ${r.name}: ${plain(r.detail)}${r.action ? `\n             Next step: ${plain(r.action)}` : ''}`;
  const fullText = [
    `Bot check · ${at.toISOString().slice(0, 19).replace('T', ' ')} UTC`,
    `Result: ${title.replace(/^\S+\s/, '')}`,
    '',
    ...GROUPS.flatMap((group) => {
      const rows = results.filter((r) => r.group === group.name).sort((a, b) => RANK[a.status] - RANK[b.status]);
      return rows.length ? [group.name, ...rows.map(row), ''] : [];
    }),
    'Status words: OK passed · WARN needs review · FAIL failed · UNMEASURED could not be checked · INFO off or for information.',
    'Not measured: what listeners actually hear, and packet loss on the Discord voice connection.',
  ].join('\n');

  return { title, description, color: failed ? 'bad' : problems.length ? 'warn' : 'ok', fullText };
}
module.exports = {
  DiagnosticGate,
  parseCpu,
  cpuDelta,
  parseMemory,
  sampleResources,
  speedTest,
  formatReport,
  describePlayback,
  fmtUptime,
  fmtAgo,
  plainMentions,
  DOWN_BYTES,
  UP_BYTES,
  LATENCY_SAMPLES,
};
