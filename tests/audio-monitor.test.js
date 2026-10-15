const { test } = require('node:test');
const assert = require('node:assert/strict');
const { AudioMonitor } = require('../src/lib/audio-monitor');
function monitor() { let at = 100000; const events = []; const m = new AudioMonitor('g', (x) => events.push(x), () => at); m.start(); return { m, events, advance: (ms) => { at += ms; } }; }
test('unchanged position with fresh updates triggers one stall and recovery', () => {
  const { m, events, advance } = monitor();
  for (let i = 0; i < 5; i++) { m.update({ position: 100, connected: true, ping: 20 }); m.check({}); advance(5000); }
  assert.equal(events.filter((x) => x.event === 'position-stalled').length, 1);
  m.update({ position: 5000, connected: true, ping: 20 }); m.check({});
  assert.equal(m.alerts.size, 0); assert.ok(events.some((x) => x.event === 'observation-recovered'));
});
test('missing player updates are reported separately from stalled position', () => {
  const { m, advance } = monitor(); advance(20000); m.check({});
  assert.ok(m.alerts.has('updates-stale')); assert.equal(m.alerts.has('position-stalled'), false);
});
test('pausing and track changes reset stall observations', () => {
  const { m, advance } = monitor(); m.update({ position: 100 }); m.pause(true); advance(60000); m.check({});
  assert.equal(m.alerts.size, 0); m.pause(false); m.update({ position: 100 }); m.check({});
  assert.equal(m.alerts.size, 0); m.start(); m.check({}); assert.equal(m.alerts.size, 0);
});
test('voice disconnect and high ping retain contextual samples without raw metadata', () => {
  const { m, events } = monitor(); m.update({ position: 42, connected: false, ping: 1500 });
  m.check({ playingPlayers: 1, cpu: { lavalinkLoad: .1 }, frameStats: { sent: 2900, nulled: 100, deficit: 0 }, secret: 'must-not-save' });
  assert.ok(m.alerts.has('voice-disconnected')); assert.ok(m.alerts.has('voice-ping-high'));
  assert.equal(events.find(x => x.event === 'voice-disconnected').position, 42);
  assert.equal(JSON.stringify(events).includes('must-not-save'), false);
});
test('stopped playback does not emit stale-update alarms', () => {
  const { m, advance } = monitor(); m.stop('finished'); advance(60000); m.check({}); assert.equal(m.alerts.size, 0);
});
test('healthy position progress with unavailable frame statistics does not claim audible smoothness', () => {
  const { m, advance, events } = monitor();
  for (let i = 0; i < 10; i++) { advance(5000); m.update({ position: i * 5000, connected: true, ping: 20 }); m.check({}); }
  assert.equal(m.alerts.size, 0); assert.equal(events.find(x => x.event === 'sample').frameStats, null);
  assert.match(m.summary(), /Audible quality is not measured/);
});
