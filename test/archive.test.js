const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { archiveTurn, archiveFile } = require('../src/archive');

test('does nothing when ARCHIVE_DIR is unset', async () => {
  assert.equal(await archiveTurn({ request: 'hi', reply: 'yo' }, { dir: '' }), false);
});

test('appends one JSON line per turn to a monthly file', async () => {
  const dir = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'archive-test-')), 'nested');
  const now = new Date('2026-11-23T04:00:00Z');
  await archiveTurn({ bot: 'claude', request: '첫 질문', reply: 'answer\nwith newline' }, { dir, now });
  await archiveTurn({ bot: 'gemini', request: 'second', reply: 'two' }, { dir, now });
  const file = archiveFile(dir, now);
  assert.equal(path.basename(file), '2026-11.jsonl');
  const lines = (await fs.readFile(file, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(lines.length, 2);
  assert.deepEqual(lines[0], { ts: '2026-11-23T04:00:00.000Z', bot: 'claude', request: '첫 질문', reply: 'answer\nwith newline' });
  assert.equal(lines[1].bot, 'gemini');
  assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
});

test('a write failure is swallowed', async () => {
  const blocker = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'archive-test-')), 'file');
  await fs.writeFile(blocker, 'x');
  const original = console.error;
  console.error = () => {};
  try {
    assert.equal(await archiveTurn({ request: 'a', reply: 'b' }, { dir: path.join(blocker, 'sub') }), false);
  } finally { console.error = original; }
});
