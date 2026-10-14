const { test } = require('node:test');
const assert = require('node:assert/strict');
const { DiagnosticGate, parseCpu, cpuDelta, parseMemory, speedTest, formatReport, describePlayback, DOWN_BYTES, UP_BYTES } = require('../src/lib/diagnostic-tools');

test('one shared gate rejects concurrent checks, enforces cooldown, and releases after failure', () => {
  let now = 1000; const gate = new DiagnosticGate(300000, () => now);
  const first = gate.acquire(); assert.equal(first.ok, true);
  assert.match(gate.acquire().message, /already running/);
  first.release(); assert.match(gate.acquire().message, /300 seconds/);
  now += 299999; assert.equal(gate.acquire().ok, false);
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
  assert.equal(requests.length, 5); assert.equal(result.bytesDownloaded, DOWN_BYTES); assert.equal(result.bytesUploaded, UP_BYTES);
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
test('friendly report prioritizes faults and missing evidence, groups results, and retains full details', () => {
  const rows = [{ status: 'ok', group: 'Server resources', name: 'CPU', detail: '2%' },
    { status: 'unknown', group: 'Music & voice', name: 'Audio', detail: 'unavailable', action: 'Capture during a cutout.' },
    { status: 'fail', group: 'Storage & protection', name: 'Backups', detail: 'missing', action: 'Make a backup.' },
    { status: 'off', group: 'Server features', name: 'Welcome', detail: 'off' }];
  const report = formatReport(rows); assert.match(report.title, /2 things/); assert.equal(report.color, 'bad');
  assert.ok(report.description.indexOf('Backups') < report.description.indexOf('Audio'));
  assert.match(report.fullText, /Make a backup/); assert.equal(report.fields.length, 6);
  assert.match(report.description, /does not confirm what listeners hear/);
  const full = formatReport(Array.from({ length: 50 }, (_, i) => ({ group: 'Server features', status: 'warn', name: `feature${i}`, detail: 'x'.repeat(200) })));
  assert.ok(full.fields.every(x => x.value.length <= 1024)); assert.match(full.fullText, /feature49/);
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
