// Image captcha for verification. Challenges live in memory for 5 minutes.
// The image library is loaded only when the first captcha is drawn (it's ~90 MB of memory), not at startup.
let createCanvas = null;
const crypto = require('node:crypto');

// No 0/O, 1/I/L, 5/S, 2/Z, 8/B: characters people confuse.
const CHARS = 'ACDEFGHJKMNPQRTUVWXY34679';
const TTL_MS = 5 * 60 * 1000;
const MAX_ATTEMPTS = 3;
const challenges = new Map(); // key guildId:userId -> { code, expires, attempts }

function randomCode(len = 5) {
  let s = '';
  for (let i = 0; i < len; i++) s += CHARS[crypto.randomInt(CHARS.length)];
  return s;
}

function render(code) {
  if (!createCanvas) ({ createCanvas } = require('@napi-rs/canvas'));
  const w = 260, h = 90;
  const c = createCanvas(w, h);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#2b2d31';
  ctx.fillRect(0, 0, w, h);

  // noise lines
  for (let i = 0; i < 7; i++) {
    ctx.strokeStyle = `hsl(${crypto.randomInt(360)},60%,55%)`;
    ctx.lineWidth = 1 + Math.random() * 2;
    ctx.beginPath();
    ctx.moveTo(Math.random() * w, Math.random() * h);
    ctx.bezierCurveTo(Math.random() * w, Math.random() * h, Math.random() * w, Math.random() * h, Math.random() * w, Math.random() * h);
    ctx.stroke();
  }
  // characters, each rotated and offset
  ctx.textBaseline = 'middle';
  const step = (w - 40) / code.length;
  for (let i = 0; i < code.length; i++) {
    ctx.save();
    ctx.translate(25 + i * step + step / 2, h / 2 + (Math.random() * 16 - 8));
    ctx.rotate((Math.random() - 0.5) * 0.7);
    ctx.font = `bold ${38 + crypto.randomInt(10)}px sans-serif`;
    ctx.fillStyle = `hsl(${crypto.randomInt(360)},70%,75%)`;
    ctx.textAlign = 'center';
    ctx.fillText(code[i], 0, 0);
    ctx.restore();
  }
  // dots
  for (let i = 0; i < 120; i++) {
    ctx.fillStyle = `rgba(255,255,255,${Math.random() * 0.4})`;
    ctx.fillRect(Math.random() * w, Math.random() * h, 2, 2);
  }
  return c.toBuffer('image/png');
}

function newChallenge(guildId, userId) {
  const code = randomCode();
  challenges.set(`${guildId}:${userId}`, { code, expires: Date.now() + TTL_MS, attempts: 0 });
  return render(code);
}

// Returns 'ok' | 'wrong' | 'expired' | 'locked'
function check(guildId, userId, answer) {
  const key = `${guildId}:${userId}`;
  const ch = challenges.get(key);
  if (!ch || ch.expires < Date.now()) { challenges.delete(key); return 'expired'; }
  if (String(answer).trim().toUpperCase() === ch.code) { challenges.delete(key); return 'ok'; }
  ch.attempts++;
  if (ch.attempts >= MAX_ATTEMPTS) { challenges.delete(key); return 'locked'; }
  return 'wrong';
}

// prune expired every minute
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of challenges) if (v.expires < now) challenges.delete(k);
}, 60_000).unref();

module.exports = { newChallenge, check, MAX_ATTEMPTS };
