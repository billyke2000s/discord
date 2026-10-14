const fs = require('node:fs/promises');
const os = require('node:os');
const { performance, monitorEventLoopDelay } = require('node:perf_hooks');
const { setTimeout: delay } = require('node:timers/promises');

class DiagnosticGate {
  constructor(cooldownMs = 300_000, now = Date.now) { this.cooldownMs = cooldownMs; this.now = now; this.running = false; this.until = 0; }
  acquire() {
    if (this.running) return { ok: false, message: 'A bot check is already running. Wait for it to finish.' };
    if (this.now() < this.until) return { ok: false, message: `Please wait ${Math.ceil((this.until - this.now()) / 1000)} seconds before running another check. The limit is shared by both diagnostic commands and all admins.` };
    this.running = true; this.until = this.now() + this.cooldownMs;
    return { ok: true, release: () => { this.running = false; } };
  }
}

function parseCpu(text) {
  const fields = /^cpu\s+(.+)$/m.exec(text)?.[1].trim().split(/\s+/).map(Number).slice(0, 8);
  if (!fields || fields.length < 8 || fields.some(x => !Number.isFinite(x))) return null;
  return { total: fields.reduce((a, b) => a + b, 0), idle: fields[3], wait: fields[4], steal: fields[7] };
}
function cpuDelta(a, b) {
  if (!a || !b || b.total <= a.total) return null;
  const total = b.total - a.total;
  return { busy: 100 * (total - (b.idle - a.idle) - (b.wait - a.wait)) / total,
    ioWait: 100 * (b.wait - a.wait) / total, steal: 100 * (b.steal - a.steal) / total };
}
function parseMemory(text) {
  const values = Object.fromEntries([...text.matchAll(/^(\w+):\s+(\d+)\s+kB$/gm)].map(m => [m[1], Number(m[2]) * 1024]));
  if (!values.MemTotal || !Number.isFinite(values.MemAvailable)) return null;
  return { total: values.MemTotal, available: values.MemAvailable, swapTotal: values.SwapTotal ?? null,
    swapUsed: Number.isFinite(values.SwapTotal) && Number.isFinite(values.SwapFree) ? values.SwapTotal - values.SwapFree : null };
}
const read = async (file) => fs.readFile(file, 'utf8').catch(() => null);
const number = (text) => text !== null && text.trim() !== 'max' && Number.isFinite(Number(text)) ? Number(text) : null;
async function sampleResources() {
  const first = parseCpu(await read('/proc/stat') || '');
  const processStart = process.cpuUsage(), started = performance.now();
  const loop = monitorEventLoopDelay({ resolution: 20 }); loop.enable();
  try {
    await delay(1000);
    const elapsed = performance.now() - started;
    const cpu = cpuDelta(first, parseCpu(await read('/proc/stat') || ''));
    const memory = parseMemory(await read('/proc/meminfo') || '');
    const usage = process.cpuUsage(processStart);
    const [limitText, currentText, quotaText] = await Promise.all([
      read('/sys/fs/cgroup/memory.max'), read('/sys/fs/cgroup/memory.current'), read('/sys/fs/cgroup/cpu.max'),
    ]);
    const quota = quotaText?.trim().split(/\s+/);
    const cpuLimit = quota && quota[0] !== 'max' && Number(quota[1]) > 0 ? Number(quota[0]) / Number(quota[1]) : null;
    return { cpu, memory, load: os.loadavg()[0], hostCores: os.cpus().length,
      botCpu: (usage.user + usage.system) / (elapsed * 10), // percent of one core
      botRss: process.memoryUsage().rss, containerMemory: number(currentText), containerLimit: number(limitText), cpuLimit,
      loopP99Ms: loop.count > 0 ? loop.percentile(99) / 1e6 : null, loopMaxMs: loop.count > 0 ? loop.max / 1e6 : null };
  } finally { loop.disable(); }
}

const DOWN_BYTES = 2 * 1024 * 1024, UP_BYTES = 256 * 1024;
async function consume(response, limit, expected = null) {
  if (!response.ok) { await response.body?.cancel(); throw new Error(`test endpoint returned HTTP ${response.status}`); }
  if (!response.body) throw new Error('test endpoint returned no body');
  const reader = response.body.getReader(); let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      bytes += value.byteLength;
      if (bytes > limit) throw new Error('test response exceeded its size limit');
    }
  } finally { await reader.cancel().catch(() => {}); }
  if (expected !== null && bytes !== expected) throw new Error('test download was incomplete');
  return bytes;
}
async function speedTest(fetcher = fetch, now = () => performance.now(), timeoutMs = 12_000) {
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), timeoutMs);
  const result = { latencyMs: null, variationMs: null, downloadMbps: null, uploadMbps: null, errors: [], bytesDownloaded: 0, bytesUploaded: 0 };
  const request = (url, options = {}) => {
    controller.signal.throwIfAborted();
    return fetcher(url, { ...options, redirect: 'error', signal: controller.signal, headers: { 'Cache-Control': 'no-store', 'Accept-Encoding': 'identity', ...(options.headers || {}) } });
  };
  const measure = async (name, work) => {
    try { await work(); } catch { result.errors.push(`${name} unavailable${controller.signal.aborted ? ' (test time limit reached)' : ' (endpoint/network error)'}`); }
  };
  try {
    await measure('Response time', async () => {
      const samples = [];
      for (let i = 0; i < 3; i++) {
        const start = now(); await consume(await request('https://speed.cloudflare.com/__down?bytes=0'), 1024);
        samples.push(now() - start);
      }
      result.latencyMs = samples.reduce((a, b) => a + b, 0) / samples.length;
      result.variationMs = Math.max(...samples) - Math.min(...samples);
    });
    await measure('Download', async () => {
      const start = now();
      result.bytesDownloaded = await consume(await request(`https://speed.cloudflare.com/__down?bytes=${DOWN_BYTES}`), DOWN_BYTES, DOWN_BYTES);
      const elapsed = now() - start;
      if (elapsed <= 0) throw new Error('invalid timing');
      result.downloadMbps = result.bytesDownloaded * 8 / elapsed / 1000;
    });
    await measure('Upload', async () => {
      const payload = Buffer.alloc(UP_BYTES); const start = now();
      await consume(await request('https://speed.cloudflare.com/__up', { method: 'POST', body: payload,
        headers: { 'Content-Type': 'application/octet-stream' } }), 16_384);
      const elapsed = now() - start;
      if (elapsed <= 0) throw new Error('invalid timing');
      result.bytesUploaded = UP_BYTES; result.uploadMbps = UP_BYTES * 8 / elapsed / 1000;
    });
    return result;
  } finally { clearTimeout(timer); controller.abort(); }
}

const icons = { ok: '✅', warn: '⚠️', fail: '❌', unknown: '❔', off: '➖' };
const ISSUE_NAMES = { 'position-stalled': 'song position stopped advancing', 'updates-stale': 'music server stopped sending player updates',
  'voice-disconnected': 'voice connection dropped', 'voice-ping-high': 'voice connection response was slow',
  'track-stuck': 'audio source stopped supplying frames', 'track-exception': 'audio source reported an error',
  'voice-closed': 'voice connection closed', 'play-request-failed': 'song could not start' };
function describePlayback(monitor, now = Date.now()) {
  if (monitor.paused) return { status: 'off', detail: 'paused; stall checks are suspended' };
  if (!monitor.active) return { status: 'off', detail: 'waiting for playback to start; no live audio measurement' };
  const problems = [...monitor.alerts].map(x => ISSUE_NAMES[x] || 'playback warning');
  if (problems.length) return { status: 'warn', detail: problems.join('; ') };
  if (!monitor.last) return { status: 'unknown', detail: 'waiting for the first player update' };
  const age = Math.max(0, Math.round((now - monitor.last.at) / 1000));
  const issue = [...monitor.recent].reverse().find(x => ISSUE_NAMES[x.event] && now - Date.parse(x.at) <= 300_000);
  return { status: issue ? 'warn' : 'ok', detail: `no active stall signal; player update ${age}s ago${issue ? `; recently: ${ISSUE_NAMES[issue.event]}` : ''}. Sound is not measured.` };
}
const GROUPS = ['Server resources', 'Internet speed', 'Music & voice', 'Discord & permissions', 'Server features', 'Storage & protection'];
function formatReport(results) {
  const attention = results.filter(r => ['fail', 'warn', 'unknown'].includes(r.status)).sort((a, b) => ({ fail: 0, warn: 1, unknown: 2 }[a.status] - { fail: 0, warn: 1, unknown: 2 }[b.status]));
  const actions = attention.slice(0, 4).map(r => `${icons[r.status]} **${r.name}** — ${r.action || r.detail}`);
  return {
    title: attention.length ? `Bot check — ${attention.length} thing${attention.length === 1 ? '' : 's'} to review` : 'Bot check — no issue found in these checks',
    description: `${actions.length ? actions.join('\n') : 'Connections and sampled resources look available.'}\n\nThis is a snapshot. It does not confirm what listeners hear.`,
    color: attention.some(r => r.status === 'fail') ? 'bad' : attention.length ? 'warn' : 'ok',
    fields: GROUPS.map(group => {
      const rows = results.filter(r => r.group === group);
      // Keep every check visible. Short, bounded lines fit one Discord embed.
      const lines = rows.map(r => `${icons[r.status]} **${r.name}:** ${r.detail}`);
      const value = lines.join('\n');
      return { name: group, value: value.length > 850 ? value.slice(0, 800) + '\n…full details in the attached report.' : value || 'No measurement available.' };
    }),
    fullText: GROUPS.map(group => `${group}\n${results.filter(r => r.group === group).map(r => `${r.status.toUpperCase()} ${r.name}: ${r.detail}${r.action ? `\n  Next step: ${r.action}` : ''}`).join('\n')}`).join('\n\n'),
  };
}
module.exports = { DiagnosticGate, parseCpu, cpuDelta, parseMemory, sampleResources, speedTest, formatReport, describePlayback, DOWN_BYTES, UP_BYTES };
