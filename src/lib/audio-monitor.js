// Playback observations, not a microphone or a claim about what listeners hear.
const fs = require('node:fs/promises');
const path = require('node:path');
const FILE = path.join(process.env.DATA_DIR || path.join(__dirname, '..', '..', 'data'), 'music-health.jsonl');
let pending = Promise.resolve(),
  queued = 0;
function record(data) {
  if (queued >= 100) return; // bound disk work if a source produces an event storm
  queued++;
  pending = pending
    .catch(() => {})
    .then(async () => {
      await fs.mkdir(path.dirname(FILE), { recursive: true });
      const size = await fs
        .stat(FILE)
        .then((s) => s.size)
        .catch(() => 0);
      if (size >= 2_000_000) {
        await fs.rm(`${FILE}.2`, { force: true });
        await fs.rename(`${FILE}.1`, `${FILE}.2`).catch((e) => {
          if (e.code !== 'ENOENT') throw e;
        });
        await fs.rename(FILE, `${FILE}.1`);
      }
      await fs.appendFile(FILE, JSON.stringify(data) + '\n', { mode: 0o600 });
    })
    .catch((err) => console.error('[music health] unable to save observations:', err.code))
    .finally(() => {
      queued--;
    });
}

class AudioMonitor {
  constructor(guildId, write = record, now = Date.now) {
    this.guildId = guildId;
    this.write = write;
    this.now = now;
    this.active = false;
    this.paused = false;
    this.alerts = new Set();
    this.recent = [];
    this.last = null;
    this.lastSample = 0;
  }
  emit(event, detail = {}) {
    const observation = { at: new Date(this.now()).toISOString(), guildId: this.guildId, event, ...detail };
    this.recent.push(observation);
    this.recent = this.recent.slice(-20);
    this.write(observation);
  }
  start() {
    this.active = true;
    this.paused = false;
    this.last = null;
    this.started = this.progressAt = this.now();
    this.lastSample = 0;
    this.alerts.clear();
    this.emit('track-start');
  }
  stop(reason) {
    this.active = false;
    this.alerts.clear();
    this.emit('track-end', { reason });
  }
  pause(paused) {
    this.paused = paused;
    this.progressAt = this.now();
    this.last = null;
    this.alerts.clear();
  }
  update(state) {
    if (!this.active || !state || !Number.isFinite(state.position)) return;
    const at = this.now();
    if (!this.last || state.position !== this.last.position) this.progressAt = at;
    this.last = { at, position: state.position, connected: state.connected, ping: state.ping };
  }
  check(stats) {
    if (!this.active || this.paused) return;
    const at = this.now();
    const conditions = {
      'updates-stale': at - (this.last?.at ?? this.started) >= 20_000,
      'position-stalled': !!this.last && at - this.last.at < 20_000 && at - this.progressAt >= 15_000,
      'voice-disconnected': this.last?.connected === false,
      'voice-ping-high': Number.isFinite(this.last?.ping) && this.last.ping >= 1000,
    };
    for (const [event, triggered] of Object.entries(conditions)) {
      if (triggered && !this.alerts.has(event)) {
        this.alerts.add(event);
        this.emit(event, this.snapshot(stats));
      } else if (!triggered && this.alerts.delete(event)) this.emit('observation-recovered', { observation: event });
    }
    if (at - this.lastSample >= 30_000) {
      this.lastSample = at;
      this.emit('sample', this.snapshot(stats));
    }
  }
  snapshot(stats) {
    return {
      position: this.last?.position ?? null,
      updateAgeMs: this.last ? this.now() - this.last.at : null,
      connected: this.last?.connected ?? null,
      voicePingMs: this.last?.ping ?? null,
      playingPlayers: stats?.playingPlayers ?? null,
      frameStats: stats?.frameStats
        ? {
            sent: stats.frameStats.sent,
            nulled: stats.frameStats.nulled,
            deficit: stats.frameStats.deficit,
          }
        : null,
      lavalinkCpu: stats?.cpu?.lavalinkLoad ?? null,
      systemCpu: stats?.cpu?.systemLoad ?? null,
    };
  }
  summary() {
    if (!this.active) return 'no active playback observation';
    if (this.paused) return 'paused; stall checks suspended';
    const age = this.last ? `${Math.round((this.now() - this.last.at) / 1000)}s ago` : 'not received yet';
    const alerts = [...this.alerts].join(', ');
    const lastIssue = [...this.recent]
      .reverse()
      .find((x) =>
        [
          'position-stalled',
          'updates-stale',
          'voice-disconnected',
          'voice-ping-high',
          'track-stuck',
          'track-exception',
          'voice-closed',
          'play-request-failed',
        ].includes(x.event),
      );
    return `player update ${age}${alerts ? `; observations: ${alerts}` : '; no active stall/voice warning'}${lastIssue ? `; latest issue: ${lastIssue.event} at ${lastIssue.at}` : ''}. Audible quality is not measured.`;
  }
}
module.exports = { AudioMonitor, FILE };
