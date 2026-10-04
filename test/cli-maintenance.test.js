const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createCliMaintenance } = require('../src/cli-maintenance');

function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-maintenance-'));
  let time = Date.now();
  let version = '1.0';
  let updates = 0;
  const applied = [];
  const instances = [];
  return {
    directory, applied,
    get updates() { return updates; },
    advance: () => { time += 1001; },
    setVersion: (value) => { version = value; },
    create(key, options = {}) {
      const instance = createCliMaintenance({ key, providerId: 'claude', directory,
        enabled: true, idleMs: 1000, pollMs: 10000000, now: () => time,
        readVersion: async () => version,
        update: async () => { updates++; version = '2.0'; },
        validate: async () => [{ key: 'new-model' }],
        apply: async (catalog) => { applied.push({ key, catalog }); },
        log: () => {}, ...options,
      });
      instances.push(instance);
      return instance;
    },
    close() {
      for (const instance of instances) instance.close();
      fs.rmSync(directory, { recursive: true, force: true });
    },
  };
}

test('updates wait for queued work and idle time in every bot using the provider', async () => {
  const state = fixture();
  try {
    const first = state.create('first');
    const second = state.create('second');
    await Promise.all([first.ready, second.ready]);
    state.advance();
    const release = second.reserve();
    assert.equal(await first.check(), false);
    assert.equal(state.updates, 0);
    release();
    assert.equal(await first.check(), false);
    state.advance();
    assert.equal(await first.check(), true);
    assert.equal(state.updates, 1);
    assert.deepEqual(state.applied[0].catalog, [{ key: 'new-model' }]);
    assert.equal(await second.check(), true);
    assert.equal(state.updates, 1);
    assert.deepEqual(state.applied.map((entry) => entry.key), ['first', 'second']);
    assert.equal(await first.check(), false);
  } finally { state.close(); }
});

test('new requests wait for an update and concurrent update checks cannot overlap', async () => {
  const state = fixture();
  try {
    let finishUpdate;
    let updateStarted;
    const started = new Promise((resolve) => { updateStarted = resolve; });
    const updating = new Promise((resolve) => { finishUpdate = resolve; });
    const first = state.create('first', { update: async () => {
      updateStarted();
      await updating;
      state.setVersion('2.0');
    } });
    const second = state.create('second');
    await Promise.all([first.ready, second.ready]);
    state.advance();
    const check = first.check();
    await started;
    assert.equal(await second.check(), false);
    let ran = false;
    const request = second.run(() => { ran = true; });
    assert.equal(ran, false);
    finishUpdate();
    assert.equal(await check, true);
    await request;
    assert.equal(ran, true);
    assert.equal(fs.existsSync(path.join(state.directory, 'claude.lock')), false);
  } finally { state.close(); }
});

test('failed updates and failed model checks keep existing connections and release the lock', async () => {
  for (const options of [
    { update: async () => { throw new Error('download failed'); } },
    { validate: async () => { throw new Error('model discovery failed'); } },
    { validate: async () => [] },
  ]) {
    const state = fixture();
    try {
      const maintenance = state.create('bot', options);
      await maintenance.ready;
      state.advance();
      assert.equal(await maintenance.check(), false);
      assert.deepEqual(state.applied, []);
      assert.equal(fs.existsSync(path.join(state.directory, 'claude.lock')), false);
      const result = JSON.parse(fs.readFileSync(path.join(state.directory, 'claude.updates.json')));
      assert.ok(result.error);
      assert.ok(result.nextCheckAt > result.checkedAt);
      assert.equal(await maintenance.run(() => 'still running'), 'still running');
    } finally { state.close(); }
  }
});

test('disabled updates still track activity and externally installed versions reload without another update', async () => {
  const state = fixture();
  try {
    const maintenance = state.create('bot');
    await maintenance.ready;
    state.advance();
    await maintenance.check();
    state.setVersion('3.0');
    assert.equal(await maintenance.check(), true);
    assert.equal(state.updates, 1);
    assert.equal(state.applied.length, 2);
    const disabled = state.create('disabled', { enabled: false });
    await disabled.ready;
    assert.equal(await disabled.check(), false);
    const release = disabled.reserve();
    const status = JSON.parse(fs.readFileSync(path.join(state.directory, `claude.disabled.${process.pid}.json`)));
    assert.equal(status.pending, 1);
    release();
  } finally { state.close(); }
});

test('an older running bot without an activity marker blocks updates', async () => {
  const state = fixture();
  try {
    const registryFile = path.join(state.directory, 'registry.json');
    fs.writeFileSync(registryFile, JSON.stringify({ other: { providerId: 'claude', pid: 99999 } }));
    const maintenance = state.create('bot', { registryFile, isAlive: () => true });
    await maintenance.ready;
    state.advance();
    assert.equal(await maintenance.check(), false);
    assert.equal(state.updates, 0);
  } finally { state.close(); }
});

test('a lock left by a dead updater is recovered', async () => {
  const state = fixture();
  try {
    const maintenance = state.create('bot', { isAlive: (pid) => pid === process.pid });
    await maintenance.ready;
    state.advance();
    fs.writeFileSync(path.join(state.directory, 'claude.lock'), JSON.stringify({ pid: 99999 }));
    assert.equal(await maintenance.check(), true);
    assert.equal(state.updates, 1);
  } finally { state.close(); }
});
