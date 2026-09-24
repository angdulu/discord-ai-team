const test = require('node:test');
const assert = require('node:assert/strict');
const { createStreamWorker } = require('../src/stream-worker');

const fakeCli = `
let buffer = '';
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf('\\n')) >= 0) {
    const input = JSON.parse(buffer.slice(0, newline));
    buffer = buffer.slice(newline + 1);
    if (input.wait) continue;
    const line = JSON.stringify({ type: 'result', value: input.value, pid: process.pid }) + '\\n';
    process.stdout.write(line.slice(0, 5));
    setTimeout(() => process.stdout.write(line.slice(5)), 5);
  }
});
`;

function result(event) {
  return event.type === 'result' ? { done: true, value: event } : null;
}

test('stream worker reuses one process across turns and parses split JSON lines', async () => {
  const worker = createStreamWorker(process.execPath, ['-e', fakeCli], process.cwd());
  try {
    const first = await worker.request({ value: 'ONE' }, result);
    const second = await worker.request({ value: 'TWO' }, result);
    assert.equal(first.value, 'ONE');
    assert.equal(second.value, 'TWO');
    assert.equal(first.pid, second.pid);
  } finally {
    worker.close();
  }
});

test('aborting a turn stops its worker', async () => {
  const worker = createStreamWorker(process.execPath, ['-e', fakeCli], process.cwd());
  const controller = new AbortController();
  const turn = worker.request({ wait: true }, result, controller.signal);
  controller.abort();
  await assert.rejects(turn, /aborted/);
  assert.equal(worker.closed, true);
});
