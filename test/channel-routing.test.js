const test = require('node:test');
const assert = require('node:assert/strict');
const { isPrivateChannel, shouldAutoReply, shouldHandleMessageUpdate,
  trackedChannelGuilds, reconcileDeletedChannels } = require('../src/runner');

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

test('content edits in DMs and private channels route without a new mention', () => {
  const self = { id: 'bot' };
  const mentions = (hasBot) => ({ has: () => hasBot });
  const before = { partial: false, content: 'old', mentions: mentions(false) };
  const edited = { author: { bot: false }, editedTimestamp: 123, content: 'new',
    mentions: mentions(false), guild: null };
  assert.equal(shouldHandleMessageUpdate(before, edited, self), true);
  assert.equal(shouldHandleMessageUpdate(before, { ...edited, content: 'old' }, self), false);
  assert.equal(shouldHandleMessageUpdate(before, { ...edited, editedTimestamp: null }, self), false);
  assert.equal(shouldHandleMessageUpdate(before, { ...edited, author: { bot: true } }, self), false);

  const everyone = { id: 'everyone' };
  const channel = (viewable) => ({ guild: { roles: { everyone } },
    permissionsFor: () => ({ has: () => viewable }) });
  const serverEdit = { ...edited, guild: { id: 'guild' }, channel: channel(false) };
  assert.equal(shouldHandleMessageUpdate(before, serverEdit, self), true);
  assert.equal(shouldHandleMessageUpdate(before, { ...serverEdit, channel: channel(true) }, self), false);
});

test('server edits route when a bot mention is newly added, including uncached messages', () => {
  const self = { id: 'bot' };
  const mentions = (hasBot) => ({ has: () => hasBot });
  const everyone = { id: 'everyone' };
  const after = { author: { bot: false }, editedTimestamp: 123, content: '<@bot> new',
    mentions: mentions(true), guild: { id: 'guild' },
    channel: { guild: { roles: { everyone } }, permissionsFor: () => ({ has: () => true }) } };
  assert.equal(shouldHandleMessageUpdate({ partial: false, content: 'old', mentions: mentions(false) }, after, self), true);
  assert.equal(shouldHandleMessageUpdate({ partial: false, content: '<@bot> old', mentions: mentions(true) }, after, self), false);
  assert.equal(shouldHandleMessageUpdate({ partial: true }, after, self), true);
});

test('startup checks saved channel state without registering channels by hand', async () => {
  const guild = { id: 'guild', available: true };
  const requested = [];
  const remembered = [];
  const forgotten = [];
  const client = {
    guilds: { cache: new Map([['guild', guild]]) },
    channels: { fetch: async (id, options) => {
      requested.push([id, options]);
      if (id === 'deleted' || id === 'legacy-deleted') throw Object.assign(new Error('Unknown channel'), { code: 10003 });
      if (id === 'hidden') throw Object.assign(new Error('Missing access'), { code: 50001 });
      if (id === 'dm') return { id };
      return { id, guildId: 'guild' };
    } },
  };
  const tracked = trackedChannelGuilds({ deleted: 'guild', hidden: 'guild' },
    { guilds: { guild: { channels: { configured: {} } } } });
  await reconcileDeletedChannels(client, tracked, ['legacy-live', 'legacy-deleted', 'dm'],
    (id, guildId) => remembered.push([id, guildId]),
    (channel) => forgotten.push([channel.id, channel.guild.id]));
  assert.deepEqual(forgotten, [['deleted', 'guild']]);
  assert.deepEqual(remembered, [['configured', 'guild'], ['legacy-live', 'guild']]);
  assert.equal(requested.length, 6);
  assert.ok(requested.every(([, options]) => options.force && options.cache === false));
});

test('startup leaves channel state alone when its server is unavailable', async () => {
  let fetched = false;
  const client = {
    guilds: { cache: new Map([['guild', { id: 'guild', available: false }]]) },
    channels: { fetch: async () => { fetched = true; } },
  };
  await reconcileDeletedChannels(client, { channel: 'guild' }, [], () => {}, () => {
    throw new Error('must not clean state');
  });
  assert.equal(fetched, false);
});

test('startup does not erase a channel still present in the server cache', async () => {
  const guild = { id: 'guild', available: true, channels: { cache: new Map([['hidden', {}]]) } };
  const client = {
    guilds: { cache: new Map([['guild', guild]]) },
    channels: { fetch: async () => { throw Object.assign(new Error('Unknown channel'), { code: 10003 }); } },
  };
  await reconcileDeletedChannels(client, { hidden: 'guild' }, [], () => {}, () => {
    throw new Error('must not clean state');
  });
});
