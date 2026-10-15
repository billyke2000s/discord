const { test } = require('node:test');
const assert = require('node:assert/strict');
const { DiagnosticGate, parseCpu, cpuDelta, parseMemory, speedTest, formatReport, describePlayback, fmtUptime, fmtAgo, plainMentions, DOWN_BYTES, UP_BYTES, LATENCY_SAMPLES } = require('../src/lib/diagnostic-tools');

test('one shared gate rejects concurrent checks, enforces cooldown, and releases after failure', () => {
  let now = 1000; const gate = new DiagnosticGate(undefined, () => now);
  const first = gate.acquire(); assert.equal(first.ok, true);
  assert.match(gate.acquire().message, /already running/);
  first.release(); assert.match(gate.acquire().message, /60 seconds/);
  now += 59999; assert.equal(gate.acquire().ok, false);
  now++; const next = gate.acquire(); assert.equal(next.ok, true); next.release();
});
test('CPU parsing excludes guest double counting and reports IO/hypervisor wait separately', () => {
  const a = parseCpu('cpu  10 0 10 70 5 0 0 5 99 99\ncpu0 0 0 0 0');
  const b = parseCpu('cpu  30 0 20 120 15 0 0 15 999 999');
  assert.equal(a.total, 100); assert.deepEqual(cpuDelta(a, b), { busy: 40, ioWait: 10, steal: 10 });
  assert.equal(cpuDelta(a, a), null); assert.equal(parseCpu('bad'), null);
});
test('RAM uses available memory instead of treating filesystem cache as lost memory', () => {
  assert.deepEqual(parseMemory('MemTotal: 1000 kB\nMemAvailable: 600 kB\nMemFree: 100 kB\nSwapTotal: 200 kB\nSwapFree: 150 kB\n'),
    { total: 1024000, available: 614400, swapTotal: 204800, swapUsed: 51200 });
  assert.equal(parseMemory('MemTotal: 1000 kB'), null);
});
test('speed test caps transfers, uses fixed endpoints and generates non-sensitive upload data', async () => {
  let time = 0; const requests = [];
  const result = await speedTest(async (url, opts) => {
    requests.push({ url, opts }); time += 100;
    assert.equal(opts.redirect, 'error'); assert.equal(opts.headers['Cache-Control'], 'no-store');
    if (opts.method === 'POST') { assert.equal(opts.body.byteLength, UP_BYTES); assert.ok(opts.body.every(x => x === 0)); return new Response('ok'); }
    return new Response(url.endsWith('bytes=0') ? '' : new Uint8Array(DOWN_BYTES));
  }, () => time);
  assert.equal(requests.length, LATENCY_SAMPLES + 2); assert.equal(result.bytesDownloaded, DOWN_BYTES); assert.equal(result.bytesUploaded, UP_BYTES);
  assert.equal(result.latencyMs, 100); assert.equal(result.variationMs, 0);
  assert.equal(result.downloadMbps, DOWN_BYTES * 8 / 100 / 1000); assert.deepEqual(result.errors, []);
});
test('incomplete or oversized speed responses stay unavailable rather than inventing a rate', async () => {
  let time = 0;
  const result = await speedTest(async (url, opts) => { time += 100; return new Response(opts.method === 'POST' ? 'ok' : url.endsWith('bytes=0') ? '' : new Uint8Array(10)); }, () => time);
  assert.equal(result.downloadMbps, null); assert.ok(result.errors.some(x => x.includes('Download')));
  const oversized = await speedTest(async () => new Response(new Uint8Array(DOWN_BYTES + 1)), () => ++time);
  assert.equal(oversized.downloadMbps, null); assert.equal(oversized.uploadMbps, null);
});
test('speed-test deadline aborts work and skips remaining transfers', async () => {
  let requests = 0;
  const result = await speedTest(async (_url, opts) => {
    requests++;
    return new Promise((resolve, reject) => opts.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
  }, Date.now, 20);
  assert.equal(requests, 1); assert.equal(result.downloadMbps, null); assert.equal(result.errors.length, 3);
});
test('report gives a verdict, one line per area, next steps only for problems, and a full text file', () => {
  const rows = [{ status: 'ok', group: 'Server', name: 'CPU', detail: '2%', action: undefined },
    { status: 'unknown', group: 'Music', name: 'Audio smoothness', detail: 'unavailable', action: 'Capture during a cutout.' },
    { status: 'fail', group: 'Data & protection', name: 'Backups', detail: 'missing', action: 'Make a backup.' },
    { status: 'warn', group: 'Bot', name: 'Bot permissions', detail: 'has Administrator', action: 'Remove it.' },
    { status: 'ok', group: 'Setup', name: 'Log channel', detail: '<#123>' },
    { status: 'off', group: 'Setup', name: 'Welcome channel', detail: 'not set up' }];
  const report = formatReport(rows, { summaries: { Server: 'CPU 2%' }, names: { channel: () => 'mod-logs' }, at: new Date(0) });
  assert.equal(report.title, '❌ 2 problems found'); assert.equal(report.color, 'bad');
  assert.ok(report.description.indexOf('**Backups:**') < report.description.indexOf('**Bot permissions:**'));
  assert.match(report.description, /🖥️ \*\*Server\*\* · ✅ CPU 2%/);
  assert.match(report.description, /💾 \*\*Data & protection\*\* · ❌ Backups/);
  assert.match(report.description, /🎵 \*\*Music\*\* · ❔ couldn't check/);
  assert.match(report.description, /Couldn't measure: Audio smoothness/);
  assert.match(report.fullText, /FAIL\s+Backups: missing\n\s+Next step: Make a backup\./);
  assert.match(report.fullText, /OK\s+Log channel: #mod-logs \(123\)/);
  assert.doesNotMatch(report.fullText, /<#|Next step: undefined/);
  assert.match(report.fullText, /^Bot check · 1970-01-01 00:00:00 UTC/);
  const fine = formatReport([{ status: 'ok', group: 'Bot', name: 'Discord connection', detail: '40 ms' }], { summaries: { Bot: 'online' } });
  assert.equal(fine.title, '✅ Everything looks fine'); assert.doesNotMatch(fine.description, /What to do|Next step/);
  const many = formatReport(Array.from({ length: 50 }, (_, i) => ({ group: 'Setup', status: 'warn', name: `feature${i}`, detail: 'x'.repeat(200), action: 'y' })));
  assert.ok(many.description.length <= 4096); assert.match(many.description, /45 more/); assert.match(many.fullText, /feature49/);
});
test('uptime, ages and mentions are written so nobody can misread them', () => {
  assert.equal(fmtUptime(469), '7 min'); assert.equal(fmtUptime(7 * 3600 + 49 * 60), '7 h 49 min');
  assert.equal(fmtUptime(2 * 86400 + 3 * 3600), '2 days 3 h'); assert.equal(fmtUptime(12), '12 s');
  assert.equal(fmtAgo(12 * 60_000), '12 min ago'); assert.equal(fmtAgo(3 * 3600e3), '3 h ago'); assert.equal(fmtAgo(5 * 86400e3), '5 days ago');
  assert.equal(plainMentions('<#1> <@&2> <t:0:R> <#3>', { channel: (id) => id === '1' ? 'music' : undefined, role: () => 'Staff' }),
    '#music (1) @Staff (2) 1970-01-01 00:00 UTC #unknown-channel (3)');
});
test('playback wording is understandable and paused playback is informational', () => {
  const m = { active: true, paused: false, alerts: new Set(['position-stalled']), recent: [], last: { at: 1000 } };
  assert.match(describePlayback(m, 2000).detail, /song position stopped advancing/);
  m.paused = true; assert.equal(describePlayback(m).status, 'off');
  m.paused = false; m.alerts.clear(); m.last = null; assert.equal(describePlayback(m).status, 'unknown');
  m.last = { at: 1000 }; m.recent = [{ event: 'track-exception', at: new Date(1000).toISOString() }];
  assert.match(describePlayback(m, 2000).detail, /audio source reported an error/);
  assert.equal(describePlayback(m, 400000).status, 'ok');
});

