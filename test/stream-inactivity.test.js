const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const childProcess = require('node:child_process');

const MINUTE = 60 * 1000;

function fakeWorker(t) {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = t.mock.fn();
  t.mock.method(childProcess, 'spawn', () => child);
  const file = require.resolve('../src/stream-worker');
  delete require.cache[file];
  const { createStreamWorker } = require(file);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const worker = createStreamWorker('claude', [], process.cwd(), null, null);
  t.after(() => { worker.close(); delete require.cache[file]; });
  return { worker, child, emit: (event) => child.stdout.write(`${JSON.stringify(event)}\n`) };
}

const result = (event) => event.type === 'result' ? { done: true, value: event.value } : null;

test('streamed progress keeps a turn alive beyond five minutes and beyond thirty minutes total', async (t) => {
  const { worker, child, emit } = fakeWorker(t);
  let settled = false;
  const turn = worker.request({}, result).finally(() => { settled = true; });
  t.mock.timers.tick(5 * MINUTE + 1000);
  await Promise.resolve();
  assert.equal(settled, false);
  assert.equal(worker.closed, false);
  for (let i = 0; i < 3; i++) {
    emit({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'thinking_delta' } } });
    t.mock.timers.tick(25 * MINUTE);
    assert.equal(worker.closed, false);
    assert.equal(child.kill.mock.callCount(), 0);
  }
  emit({ type: 'result', value: 'finished' });
  assert.equal(await turn, 'finished');
  t.mock.timers.tick(30 * MINUTE);
  assert.equal(worker.closed, false);
});

test('thirty minutes of silence after the last event stops the turn once', async (t) => {
  const { worker, child, emit } = fakeWorker(t);
  const rejected = assert.rejects(worker.request({}, result), (error) => {
    assert.equal(error.code, 'TURN_INACTIVITY_TIMEOUT');
    assert.match(error.message, /30 minutes without progress/);
    return true;
  });
  t.mock.timers.tick(29 * MINUTE);
  emit({ type: 'user', message: { content: [{ type: 'tool_result' }] } });
  t.mock.timers.tick(29 * MINUTE);
  assert.equal(worker.closed, false);
  t.mock.timers.tick(MINUTE);
  await rejected;
  assert.equal(worker.closed, true);
  assert.equal(child.kill.mock.callCount(), 1);
  t.mock.timers.tick(30 * MINUTE);
  assert.equal(child.kill.mock.callCount(), 1);
});

test('stderr and malformed output do not count as turn progress', async (t) => {
  const { worker, child } = fakeWorker(t);
  const rejected = assert.rejects(worker.request({}, result), { code: 'TURN_INACTIVITY_TIMEOUT' });
  t.mock.timers.tick(29 * MINUTE);
  child.stdout.write('diagnostic text\n');
  child.stderr.write('diagnostic text\n');
  t.mock.timers.tick(MINUTE);
  await rejected;
  assert.equal(worker.closed, true);
});
