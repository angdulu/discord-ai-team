const test = require('node:test');
const assert = require('node:assert/strict');
const { choose, weekKey, maintenancePrompt, invoke, workerOutcome } = require('./scripts/nexus-weekly.cjs');
const snapshots = [{ bot: 'a', models: [{ id: 'model@high' }], usage: { sections: [{ buckets: [{ left: 50 }] }] } }];
test('routing validates catalog and quota without escalation', () => {
  assert.equal(choose('{"bot":"a","model":"model@high","reason":"fits"}', snapshots).bot, 'a');
  assert.throws(() => choose('{"bot":"a","model":"invented","reason":"fits"}', snapshots), /unavailable/);
  assert.throws(() => choose('{"bot":"a","model":"model@high","reason":"fits"}',
    [{ ...snapshots[0], usage: { sections: [{ buckets: [{ left: 0 }] }] } }]), /no quota/);
  assert.equal(choose('```json\n{"bot":"a","model":"model@high","reason":"fits"}\n```', snapshots).model, 'model@high');
});
test('week boundaries use Sunday in Korea', () => {
  assert.equal(weekKey(new Date('2026-11-14T14:59:00Z')), '2026-11-08');
  assert.equal(weekKey(new Date('2026-11-14T15:00:00Z')), '2026-11-15');
});
test('prompt preserves admissions freeze and shared write rules', () => {
  const prompt = maintenancePrompt('/vault', { counts: {} });
  assert.match(prompt, /Do not edit admissions/);
  assert.match(prompt, /Re-read immediately/);
  assert.match(prompt, /the wrapper runs it once/);
});
test('provider subprocess timeout kills its owned process group', async () => {
  const fs = require('fs'), os = require('os'), path = require('path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-worker-'));
  const script = path.join(dir, 'hang.cjs');
  fs.writeFileSync(script, 'setInterval(() => {}, 1000)');
  try { await assert.rejects(invoke(script, {}, 80), /timed out/); }
  finally { fs.rmSync(dir, { recursive: true }); }
});

test('insufficient capable quota can defer without choosing a weaker model', () => {
  assert.equal(choose('{"defer":true,"reason":"capable tier exhausted"}', []).defer, true);
  assert.throws(() => choose('{"defer":true}', []), /reason/);
});

test('worker success requires structured completion and the actual Sync record', () => {
  assert.equal(workerOutcome('{"status":"completed","summary":"done"}', '- sync scheduled:week', 'scheduled:week').status, 'completed');
  assert.equal(workerOutcome('{"status":"completed","summary":"done"}', '', 'scheduled:week').status, 'blocked');
  assert.equal(workerOutcome('{"status":"blocked","summary":"sandbox failure"}', '', 'scheduled:week').status, 'blocked');
  assert.equal(workerOutcome('could not read files', '', 'scheduled:week').status, 'blocked');
});
