const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { firstJson, dayKey, readArchive, formatTranscript, nightlyOutcome, composeDm, monthsBetween } = require('../scripts/nexus-nightly.cjs');

test('day key is the KST date', () => {
  assert.equal(dayKey(new Date('2026-11-23T19:00:00Z')), '2026-11-24'); // 04:00 KST
  assert.equal(dayKey(new Date('2026-11-23T14:00:00Z')), '2026-11-23');
});

test('reads only records inside the window, across month files, skipping bad lines', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nightly-test-'));
  const line = (ts, request) => JSON.stringify({ ts, bot: 'claude', request, reply: 'ok' });
  fs.writeFileSync(path.join(dir, '2026-11.jsonl'), [line('2026-11-29T10:00:00Z', 'old'), line('2026-11-30T20:00:00Z', 'nov'), 'not json'].join('\n') + '\n');
  fs.writeFileSync(path.join(dir, '2026-12.jsonl'), line('2026-12-01T03:00:00Z', 'dec') + '\n' + line('2026-12-02T03:00:00Z', 'future') + '\n');
  const records = readArchive(dir, new Date('2026-11-30T19:00:00Z'), new Date('2026-12-01T19:00:00Z'));
  assert.deepEqual(records.map(r => r.request), ['nov', 'dec']);
  assert.deepEqual(monthsBetween(new Date('2026-11-30T19:00:00Z'), new Date('2027-01-02T00:00:00Z')), ['2026-11', '2026-12', '2027-01']);
});

test('transcript shrinks long turns to fit the cap', () => {
  const records = Array.from({ length: 20 }, (_, i) => ({ ts: '2026-11-23T01:00:00Z', name: 'Claudebot', channel: 'DM', author: 'andrew', request: 'q' + i, reply: 'x'.repeat(5000) }));
  const text = formatTranscript(records, 30000);
  assert.ok(text.length <= 30000);
  assert.match(text, /\[11-23 10:00 KST · DM · Claudebot\]\nandrew: q0\nClaudebot: x+ …\(cut\)/);
});

test('outcome requires the log marker when something was saved', () => {
  const ok = nightlyOutcome('{"status":"completed","saved":["a → `nexus/x.md`"],"questions":[]}', '- nightly:2026-11-24', 'nightly:2026-11-24');
  assert.equal(ok.status, 'completed');
  const missing = nightlyOutcome('{"status":"completed","saved":["a"],"questions":[]}', '', 'nightly:2026-11-24');
  assert.equal(missing.status, 'blocked');
  const nothing = nightlyOutcome('```json\n{"status":"completed","saved":[],"questions":["1","2","3","4"]}\n```', '', 'nightly:2026-11-24');
  assert.equal(nothing.status, 'completed');
  assert.equal(nothing.questions.length, 3);
  assert.equal(nightlyOutcome('garbage', '', 'm').status, 'blocked');
});

test('DM lists saves and questions, and is empty when there is nothing', () => {
  assert.equal(composeDm('2026-11-24', { saved: [], questions: [] }), '');
  const text = composeDm('2026-11-24', { saved: ['A → `nexus/a.md`'], questions: ['B 저장할까?'] });
  assert.equal(text, '밤 정리 (2026-11-24)\n저장함:\n- A → `nexus/a.md`\n확인 필요:\n1. B 저장할까?\n이 메시지에 답장(reply)으로 승인/거절을 보내줘.');
});

test('takes the first JSON object even with prose, fences or a second object after it', () => {
  assert.equal(firstJson('```json\n{"bot":"gemini","reason":"a } in \\"text\\""}\n```\nI picked Gemini.'), '{"bot":"gemini","reason":"a } in \\"text\\""}');
  assert.equal(firstJson('{"a":{"b":1}}\n\n{"a":2}'), '{"a":{"b":1}}');
  assert.equal(JSON.parse(firstJson('Sure:\n{"defer":true,"reason":"low"}')).defer, true);
  assert.equal(nightlyOutcome('{"status":"completed","saved":[],"questions":[]}\nDone.', '', 'm').status, 'completed');
});
