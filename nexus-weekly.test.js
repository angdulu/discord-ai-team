const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  choose, weekKey, expectedWeekKey, annotateQuota,
  maintenancePrompt, invoke, workerOutcome, deliverAny, checkWeeklyAlert,
} = require('./scripts/nexus-weekly.cjs');

const snapshots = [{ bot: 'a', models: [{ id: 'model@high' }], usage: { sections: [{ buckets: [{ left: 50 }] }] } }];

test('routing validates catalog and quota without escalation', () => {
  assert.equal(choose('{"bot":"a","model":"model@high","reason":"fits"}', snapshots).bot, 'a');
  assert.throws(() => choose('{"bot":"a","model":"invented","reason":"fits"}', snapshots), /unavailable/);
  assert.throws(() => choose('{"bot":"a","model":"model@high","reason":"fits"}',
    [{ ...snapshots[0], usage: { sections: [{ buckets: [{ left: 0 }] }] } }]), /no quota/);
  assert.throws(() => choose('{"bot":"a","model":"model@high","reason":"fits"}',
    [{ ...snapshots[0], usage: { sections: [{ buckets: [{ label: '5h', left: 15 }, { label: 'Weekly', left: 80 }] }] } }]), /no quota above reserve/);
  assert.equal(choose('```json\n{"bot":"a","model":"model@high","reason":"fits"}\n```', snapshots).model, 'model@high');
});

test('quota pace annotation computes windowLeftPct, paceDeltaPct, and interactive reserve', () => {
  const now = Date.parse('2026-11-15T11:00:00Z');
  const raw = [{
    bot: 'chatgpt',
    models: [{ id: 'gpt-6-astra@high', label: 'GPT-6-Astra' }],
    usage: {
      sections: [{
        name: 'Codex',
        buckets: [
          // 90% left right after weekly reset (99% of 168h window remaining) -> negative paceDeltaPct
          { label: 'Weekly', left: 90, resetsAt: now + 166.32 * 3600 * 1000 },
          // 40% left with 1h left in 5h window (20% window remaining) -> positive paceDeltaPct
          { label: '5h', left: 40, resetsAt: new Date(now + 1 * 3600 * 1000).toISOString() },
        ],
      }],
    },
  }];
  const [annotated] = annotateQuota(raw, now);
  const [weekly, fiveH] = annotated.usage.sections[0].buckets;
  assert.equal(weekly.windowLeftPct, 99);
  assert.equal(weekly.paceDeltaPct, -9);
  assert.equal(weekly.usableLeft, 75);
  assert.equal(weekly.belowReserve, false);
  assert.match(weekly.resetsAt, /^2026-11-22T/);

  assert.equal(fiveH.windowLeftPct, 20);
  assert.equal(fiveH.paceDeltaPct, 20);
  assert.equal(fiveH.usableLeft, 20);
  assert.equal(fiveH.belowReserve, false);
});

test('applicableBuckets scopes model-specific quota sections', () => {
  const geminiSnap = [{
    bot: 'gemini',
    models: [
      { id: 'gemini-3.8-flash-high', label: 'Gemini 3.8 Flash' },
      { id: 'gemini-4-argon-high', label: 'Gemini 4 Argon' },
    ],
    usage: {
      sections: [
        { name: 'Gemini Models', buckets: [{ label: 'Weekly', left: 80 }, { label: '5h', left: 90 }] },
        { name: 'Gemini 4 Argon', buckets: [{ label: 'Weekly', left: 10 }] },
      ],
    },
  }];
  assert.throws(() => choose('{"bot":"gemini","model":"gemini-4-argon-high","reason":"top"}', geminiSnap), /no quota above reserve/);
  assert.equal(choose('{"bot":"gemini","model":"gemini-3.8-flash-high","reason":"fast"}', geminiSnap).model, 'gemini-3.8-flash-high');
});

test('week boundaries use Sunday in Korea and Monday check targets the just-finished Sunday', () => {
  assert.equal(weekKey(new Date('2026-11-14T14:59:00Z')), '2026-11-08');
  assert.equal(weekKey(new Date('2026-11-14T15:00:00Z')), '2026-11-15');
  // Monday 03:20 KST (Sunday 18:20 UTC) checks the Sunday that started 27h20m earlier (2026-11-15)
  assert.equal(expectedWeekKey(new Date('2026-11-15T18:20:00Z')), '2026-11-15');
  // Sunday 19:00 KST (10:00 UTC), before the 20:00 KST run, checks the prior Sunday (2026-11-08)
  assert.equal(expectedWeekKey(new Date('2026-11-15T10:00:00Z')), '2026-11-08');
});

test('prompt preserves admissions freeze and shared write rules', () => {
  const prompt = maintenancePrompt('/vault', { counts: {} });
  assert.match(prompt, /Do not edit admissions/);
  assert.match(prompt, /Re-read immediately/);
  assert.match(prompt, /the wrapper runs it once/);
});

test('provider subprocess timeout kills its owned process group', async () => {
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

test('deliverAny falls back across bots and checkWeeklyAlert alerts once on incomplete Sunday state', async () => {
  const tried = [];
  const msgId = await deliverAny(['chatgpt', 'claude', 'chatgpt'], 'u1', 'hi', 'n1', async (bot) => {
    tried.push(bot);
    if (bot === 'chatgpt') throw new Error('token failed');
    return 'msg-123';
  });
  assert.equal(msgId, 'msg-123');
  assert.deepEqual(tried, ['chatgpt', 'claude']);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-alert-'));
  const stateDir = path.join(dir, 'state');
  fs.mkdirSync(path.join(dir, 'nexus'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'nexus/log.md'), '');
  const monday = new Date('2026-11-15T18:20:00Z'); // Mon 2026-11-16 03:20 KST -> week 2026-11-15
  let alerts = 0;
  try {
    const first = await checkWeeklyAlert({
      stateDir, root: dir, bots: ['claude'], recipient: 'u1', now: monday,
      send: async () => { alerts++; return 'alert-1'; },
    });
    assert.equal(first.ok, false);
    assert.equal(first.alerted, true);
    assert.equal(alerts, 1);

    const second = await checkWeeklyAlert({
      stateDir, root: dir, bots: ['claude'], recipient: 'u1', now: monday,
      send: async () => { alerts++; return 'alert-2'; },
    });
    assert.equal(second.alreadyAlerted, true);
    assert.equal(alerts, 1);

    fs.writeFileSync(path.join(stateDir, '2026-11-15.json'), JSON.stringify({
      status: 'complete', week: '2026-11-15', messageId: 'm1',
    }));
    fs.writeFileSync(path.join(dir, 'nexus/log.md'), '- [2026-11-15] sync — scheduled:2026-11-15\n');
    const third = await checkWeeklyAlert({
      stateDir, root: dir, bots: ['claude'], recipient: 'u1', now: monday,
      send: async () => { alerts++; return 'alert-3'; },
    });
    assert.equal(third.ok, true);
    assert.equal(alerts, 1);
  } finally {
    fs.rmSync(dir, { recursive: true });
  }
});
