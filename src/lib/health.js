const fs = require('node:fs');
const FILE = '/tmp/server-bot-health.json';
function healthy(state, now = Date.now()) {
  return (
    state?.ready === true &&
    state?.music === true &&
    Number.isFinite(state.at) &&
    now - state.at >= 0 &&
    now - state.at < 30_000
  );
}
function startHealth(client) {
  const write = () => {
    try {
      fs.writeFileSync(
        `${FILE}.tmp`,
        JSON.stringify({
          at: Date.now(),
          ready: client.isReady(),
          music: !!client.music.shoukaku.getIdealNode(),
          sessions: client.music.queues.size,
        }),
      );
      fs.renameSync(`${FILE}.tmp`, FILE);
    } catch (err) {
      console.error('[health]', err.message);
    }
  };
  write();
  const timer = setInterval(write, 5000);
  timer.unref();
  return () => {
    clearInterval(timer);
    try {
      fs.unlinkSync(FILE);
    } catch {}
  };
}
module.exports = { healthy, startHealth };
if (require.main === module) {
  try {
    process.exit(healthy(JSON.parse(fs.readFileSync(FILE, 'utf8'))) ? 0 : 1);
  } catch {
    process.exit(1);
  }
}
