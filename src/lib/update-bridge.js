const fs = require('node:fs/promises');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const requests = () => process.env.UPDATE_REQUEST_DIR || '/app/update-requests';
const statuses = () => process.env.UPDATE_STATUS_DIR || '/app/update-status';
const REPO = 'billyke2000s/discord';
let requesting = false,
  lastRequest = 0;
async function readJson(file) {
  try {
    const stat = await fs.stat(file);
    if (stat.size > 8192) throw Error('Update status is too large');
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
}
async function json(url) {
  const response = await fetch(url, {
    redirect: 'follow',
    signal: AbortSignal.timeout(15000),
    headers: { Accept: 'application/json', 'User-Agent': 'server-bot-updates' },
  });
  if (!response.ok) throw Error(`Release check returned HTTP ${response.status}. Try again later.`);
  const reader = response.body.getReader();
  let text = '',
    bytes = 0;
  const decoder = new TextDecoder();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 1000000) throw Error('Release metadata is too large');
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return JSON.parse(text);
}
async function latestRelease() {
  const release = await json(`https://api.github.com/repos/${REPO}/releases/latest`);
  if (release.draft || release.prerelease) throw Error('No stable release is available.');
  const assets = release.assets?.filter((a) => a.name === 'update.json') || [];
  if (
    assets.length !== 1 ||
    !assets[0].browser_download_url.startsWith(`https://github.com/${REPO}/releases/download/`)
  )
    throw Error('This release needs the manual installer.');
  const manifest = await json(assets[0].browser_download_url);
  if (
    manifest.repository !== REPO ||
    manifest.tag !== release.tag_name ||
    manifest.deployment !== 1 ||
    !/^[a-f0-9]{40}$/.test(manifest.commit) ||
    !/^ghcr\.io\/billyke2000s\/discord@sha256:[a-f0-9]{64}$/.test(manifest.image)
  )
    throw Error('This release needs the manual installer.');
  return { version: manifest.tag, commit: manifest.commit };
}
async function status() {
  return readJson(path.join(statuses(), 'result.json'));
}
async function request(guildId, ownerId) {
  if (requesting) throw Error('An update request is already being submitted.');
  requesting = true;
  try {
    const heartbeat = await readJson(path.join(statuses(), 'heartbeat.json'));
    if (
      !heartbeat ||
      heartbeat.schema !== 1 ||
      !Number.isFinite(heartbeat.at) ||
      Date.now() / 1000 - heartbeat.at > 60 ||
      heartbeat.at > Date.now() / 1000 + 5
    )
      throw Error(
        'The VPS update bridge is not running. Run the latest installer once, then enable the Discord update timer as shown in the README.',
      );
    if (heartbeat.enabled !== true) throw Error('Host updates are disabled. Enable auto-update.json on the VPS first.');
    const pending = await readJson(path.join(requests(), 'request.json'));
    const result = await status();
    if (result?.state === 'updating')
      throw Error('An update is already running. I’ll send its result privately when available.');
    if (pending && pending.id !== result?.id && Date.now() / 1000 - pending.createdAt < 300)
      throw Error('An update request is already waiting for the VPS.');
    if (Date.now() - lastRequest < 60000) throw Error('Wait one minute before requesting another update.');
    const data = { id: randomBytes(16).toString('hex'), guildId, ownerId, createdAt: Date.now() / 1000 };
    const temp = path.join(requests(), `.request-${data.id}.tmp`);
    try {
      await fs.writeFile(temp, JSON.stringify(data), { mode: 0o600, flag: 'wx' });
      await fs.rename(temp, path.join(requests(), 'request.json'));
    } finally {
      await fs.unlink(temp).catch(() => {});
    }
    lastRequest = Date.now();
    return data;
  } finally {
    requesting = false;
  }
}
function resultText(result) {
  const messages = {
    updated: `Update completed and passed health checks. Installed: ${result.current || 'see /update check-only:true'}.`,
    current: `Already on the latest release: ${result.current || result.latest || 'current'}.`,
    deferred: 'Update deferred because a music session is active. Use /stop, then /update again.',
    disabled: 'The host updater is disabled. Enable it on the VPS first.',
    busy: 'Another installation/update is running. Try /update again later.',
    failed: 'The update failed. Check the VPS updater logs; recovery may need attention. Do not assume it installed.',
  };
  return messages[result.state] || 'The VPS is checking/applying your update.';
}
function start(client) {
  let busy = false;
  const poll = async () => {
    if (busy) return;
    busy = true;
    try {
      const result = await status();
      if (!result || !['updated', 'current', 'deferred', 'disabled', 'busy', 'failed'].includes(result.state)) return;
      if (!/^[0-9a-f]{32}$/.test(result.id) || !/^\d{17,20}$/.test(result.ownerId)) return;
      const ack = path.join(requests(), 'notified.json');
      if ((await readJson(ack))?.id === result.id) return;
      const guild = client.guilds.cache.get(result.guildId);
      if (!guild || guild.ownerId !== result.ownerId) return;
      // Record before sending to avoid repeatedly DMing after restart. /update also shows status.
      await fs.writeFile(`${ack}.tmp`, JSON.stringify({ id: result.id }), { mode: 0o600 });
      await fs.rename(`${ack}.tmp`, ack);
      const owner = await client.users.fetch(result.ownerId);
      await owner
        .send(resultText(result))
        .catch(() => console.error('[update] Owner DM unavailable; result remains available through /update.'));
    } catch (e) {
      if (e.code !== 'ENOENT') console.error('[update status]', e.message);
    } finally {
      busy = false;
    }
  };
  poll();
  const timer = setInterval(poll, 15000);
  timer.unref();
  return () => clearInterval(timer);
}
module.exports = { latestRelease, status, request, resultText, start };
