const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { publishStop, publishNewConversation, watchStops, withChannelTurnLock } = require('../src/team-control');

test('new conversations reach all bots and offline bots replay the reset before a later stop', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'team-new-test-'));
  const watchers = [];
  try {
    const seen = [[], []];
    for (let i = 0; i < 2; i++) watchers.push(watchStops(() => {}, {
      directory, onNewConversation: (channel, marker) => seen[i].push([channel, marker.id]),
    }));
    const id = publishNewConversation('123456', { ownerId: 'owner', channelName: 'test' }, directory);
    for (const watcher of watchers) { watcher.refresh(); watcher.refresh(); }
    assert.deepEqual(seen, [[['123456', id]], [['123456', id]]]);
    publishStop('123456', directory);
    const offline = [];
    const watcher = watchStops(() => offline.push('stop'), {
      directory, onNewConversation: (channel, marker) => offline.push(marker.id),
    });
    watchers.push(watcher);
    watcher.refresh();
    assert.deepEqual(offline, [id, 'stop']);
  } finally {
    for (const watcher of watchers) watcher.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('simultaneous reply checks share a lock and cannot exceed the remaining turn', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'team-turn-test-'));
  try {
    let turns = 3;
    let posted = 0;
    const post = () => withChannelTurnLock('123456', async () => {
      if (turns >= 4) return;
      await new Promise((resolve) => setTimeout(resolve, 30));
      turns++;
      posted++;
    }, directory);
    await Promise.all([post(), post(), post()]);
    assert.equal(posted, 1);
    assert.equal(turns, 4);
    await assert.rejects(withChannelTurnLock('123456', async () => { throw new Error('send failed'); }, directory), /send failed/);
    await withChannelTurnLock('123456', async () => {}, directory);
    assert.deepEqual(fs.readdirSync(directory), []);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('a stop-all command reaches other running bots once', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'team-stop-test-'));
  try {
    const seenA = [];
    const seenB = [];
    const a = watchStops((channelId, at) => { assert.ok(Number.isFinite(at)); seenA.push(channelId); }, { directory });
    const b = watchStops((channelId) => seenB.push(channelId), { directory });
    publishStop('123456', directory);
    a.refresh();
    b.refresh();
    a.refresh();
    assert.deepEqual(seenA, ['123456']);
    assert.deepEqual(seenB, ['123456']);
    a.close();
    b.close();
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
