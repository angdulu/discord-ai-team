const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { publishStop, watchStops } = require('../src/team-control');

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
