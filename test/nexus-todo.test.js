const test = require('node:test');
const assert = require('node:assert/strict');
const { todoPayload, toTodo, dueSoon, reminderLines, weekLine } = require('../scripts/nexus-todo.cjs');

const now = new Date('2026-11-24T19:00:00Z'); // 2026-11-25 04:00 KST

test('payload starts at 09:00 KST on the due date and ends a year later', () => {
  const p = todoPayload({ title: 'UC signup', due: '2026-11-30' }, now);
  assert.equal(p.scheduled_start_time, '2026-11-30T00:00:00.000Z');
  assert.equal(p.scheduled_end_time, '2027-11-30T00:00:00.000Z');
  assert.equal(p.entity_type, 3);
  assert.equal(p.entity_metadata.location, '마감 2026-11-30');
  assert.throws(() => todoPayload({ title: ' ' }, now), /title/);
  assert.throws(() => todoPayload({ title: 'x', due: '11/30' }, now), /YYYY-MM-DD/);
});

test('past or undated due dates never start in the past', () => {
  assert.ok(Date.parse(todoPayload({ title: 'x', due: '2026-11-20' }, now).scheduled_start_time) > now.getTime());
  const undated = todoPayload({ title: 'x' }, now);
  assert.equal(undated.entity_metadata.location, '마감 미정');
  assert.equal(toTodo({ id: '1', name: 'x', entity_metadata: undated.entity_metadata, scheduled_start_time: undated.scheduled_start_time }).due, null);
});

test('reminders cover overdue, today and tomorrow in KST; week line lists 7 days', () => {
  const todos = [
    { id: '1', title: 'A', due: '2026-11-24' }, { id: '2', title: 'B', due: '2026-11-25' },
    { id: '3', title: 'C', due: '2026-11-26' }, { id: '4', title: 'D', due: '2026-12-10' }, { id: '5', title: 'E', due: null },
  ];
  assert.deepEqual(dueSoon(todos, now), { overdue: ['A'], today: ['B'], tomorrow: ['C'] });
  assert.deepEqual(reminderLines(todos, now), ['⚠️ 기한 지남: A', '📅 오늘 마감: B', '📅 내일 마감: C']);
  assert.deepEqual(reminderLines([], now), []);
  assert.equal(weekLine(todos, now), '📅 할 일 5개 · 7일 내 마감: A(11/24), B(11/25), C(11/26)');
});
