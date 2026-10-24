const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { promisify } = require('node:util');
const execFile = promisify(require('node:child_process').execFile);
const { createAgentRegistration } = require('../src/agent-registry');

function registryFile(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-registry-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return path.join(directory, 'agents.json');
}

test('concurrent bot processes keep every registration and a valid shared registry', async (t) => {
  const file = registryFile(t);
  const moduleFile = require.resolve('../src/agent-registry');
  const code = `
    const { createAgentRegistration } = require(process.argv[1]);
    const registration = createAgentRegistration({ file: process.argv[2], key: process.argv[3],
      getAgent: () => ({ name: process.argv[3], id: process.argv[3], pid: process.pid }) });
    registration.refresh().finally(() => registration.close()).catch((error) => { console.error(error); process.exitCode = 1; });
  `;
  const keys = Array.from({ length: 12 }, (_, index) => `bot-${index}`);
  await Promise.all(keys.map((key) => execFile(process.execPath, ['-e', code, moduleFile, file, key])));
  const registry = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(Object.keys(registry).sort(), keys.sort());
  assert.equal(fs.existsSync(`${file}.lock`), false);
});

test('heartbeat restores a dropped bot and keeps peer entries and the latest name', async (t) => {
  const file = registryFile(t);
  const peer = { name: 'Claude', id: 'claude', pid: process.pid };
  fs.writeFileSync(file, JSON.stringify({ claude: peer }));
  let name = 'ChatGPT';
  const registration = createAgentRegistration({ key: 'chatgpt', file, intervalMs: 20,
    getAgent: () => ({ name, id: 'chatgpt', pid: process.pid }),
    onError: (error) => assert.fail(error.message) });
  t.after(() => registration.close());
  await registration.refresh();
  let registry = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(registry.chatgpt.name, 'ChatGPT');
  delete registry.chatgpt;
  fs.writeFileSync(file, JSON.stringify(registry));
  name = 'Cody';
  const deadline = Date.now() + 2000;
  do {
    await new Promise((resolve) => setTimeout(resolve, 10));
    registry = JSON.parse(fs.readFileSync(file, 'utf8'));
  } while (!registry.chatgpt && Date.now() < deadline);
  assert.equal(registry.chatgpt.name, 'Cody');
  assert.deepEqual(registry.claude, peer);
  registration.close();
  delete registry.chatgpt;
  fs.writeFileSync(file, JSON.stringify(registry));
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).chatgpt, undefined);
});

test('an unreadable registry is reported instead of overwriting peers and a later refresh recovers', async (t) => {
  const file = registryFile(t);
  fs.writeFileSync(file, '{broken');
  const registration = createAgentRegistration({ key: 'chatgpt', file,
    getAgent: () => ({ id: 'chatgpt', pid: process.pid }) });
  t.after(() => registration.close());
  await assert.rejects(registration.refresh(), SyntaxError);
  assert.equal(fs.readFileSync(file, 'utf8'), '{broken');
  assert.equal(fs.existsSync(`${file}.lock`), false);
  fs.writeFileSync(file, JSON.stringify({ claude: { id: 'claude' } }));
  await registration.refresh();
  const registry = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(registry.chatgpt.id, 'chatgpt');
  assert.equal(registry.claude.id, 'claude');
});
