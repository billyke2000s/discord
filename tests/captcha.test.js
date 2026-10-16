const { test } = require('node:test');
const assert = require('node:assert/strict');
const captcha = require('../src/lib/captcha');

test('three wrong codes lock the member out; a new image is refused until the lockout ends', () => {
  assert.ok(Buffer.isBuffer(captcha.newChallenge('g', 'u')));
  assert.equal(captcha.check('g', 'u', 'nope1'), 'wrong');
  assert.equal(captcha.check('g', 'u', 'nope2'), 'wrong');
  assert.equal(captcha.check('g', 'u', 'nope3'), 'locked');
  assert.ok(captcha.lockedFor('g', 'u') > captcha.LOCKOUT_MS - 5000);
  assert.equal(captcha.newChallenge('g', 'u'), null, '"New image" must not reset the tries');
  // Other members and other servers are unaffected.
  assert.equal(captcha.lockedFor('g', 'someone-else'), 0);
  assert.equal(captcha.lockedFor('other-guild', 'u'), 0);
  // After the lockout, a new image works again.
  assert.equal(captcha.lockedFor('g', 'u', Date.now() + captcha.LOCKOUT_MS + 1), 0);
  assert.ok(Buffer.isBuffer(captcha.newChallenge('g', 'u')));
});
