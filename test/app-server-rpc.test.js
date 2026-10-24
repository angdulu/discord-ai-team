const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');

test('unsupported server requests are rejected without resolving outgoing RPCs with the same ID', async (t) => {
  const cp = require('child_process');
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = new EventEmitter();
  const writes = [];
  const emit = (message) => child.stdout.emit('data', Buffer.from(JSON.stringify(message) + '\n'));
  child.stdin.write = (line) => {
    const message = JSON.parse(line);
    writes.push(message);
    if (message.method === 'initialize') setImmediate(() => emit({ id: message.id, result: {} }));
  };
  child.kill = () => {};
  t.mock.method(cp, 'spawn', () => child);
  const file = require.resolve('../src/app-server-client');
  delete require.cache[file];
  t.after(() => { delete require.cache[file]; });
  const client = require(file).createAppServerClient('/tmp');
  try {
    await client.ready;
    let settled = false;
    const outgoing = client.request('model/list', {}).then((result) => { settled = true; return result; });
    const id = writes.at(-1).id;
    emit({ id, method: 'item/tool/requestUserInput', params: { threadId: 'thread', questions: [] } });
    await new Promise(setImmediate);
    assert.equal(settled, false);
    assert.deepEqual(writes.at(-1), { id, error: { code: -32601, message: 'Unsupported server request: item/tool/requestUserInput' } });
    emit({ id, result: { data: ['model'] } });
    assert.deepEqual(await outgoing, { data: ['model'] });
  } finally { client.close(); }
});
