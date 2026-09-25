const test = require('node:test');
const assert = require('node:assert/strict');
const { isPrivateChannel, shouldAutoReply } = require('../src/runner');

test('only a private channel with one accessible agent accepts an unmentioned human message', () => {
  const everyone = { id: 'everyone' };
  const channel = (viewable) => ({
    guild: { roles: { everyone } },
    permissionsFor: (role) => {
      assert.equal(role, everyone);
      return { has: () => viewable };
    },
  });
  assert.equal(isPrivateChannel(channel(false)), true);
  assert.equal(isPrivateChannel(channel(true)), false);
  assert.equal(isPrivateChannel({ guild: null }), false);

  const request = { isDM: false, authorIsBot: false, mentioned: false,
    mentionsOtherBot: false, privateChannel: true, peerCount: 0 };
  assert.equal(shouldAutoReply(request), true);
  for (const change of [
    { authorIsBot: true }, { mentioned: true }, { mentionsOtherBot: true },
    { privateChannel: false }, { peerCount: 1 },
  ]) {
    assert.equal(shouldAutoReply({ ...request, ...change }), false);
  }
});
