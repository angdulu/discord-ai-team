const test = require('node:test');
const assert = require('node:assert/strict');
const { parseUsage } = require('../src/providers/claude-usage');

test('Claude usage reads current structured limits, including model-specific weekly limits', () => {
  const usage = parseUsage({
    subscription_type: 'max', rate_limits_available: true,
    rate_limits: { limits: [
      { kind: 'session', percent: 12, resets_at: '2026-09-25T13:00:00Z' },
      { kind: 'weekly_all', percent: 55, resets_at: '2026-09-28T13:00:00Z' },
      { kind: 'weekly_scoped', percent: 25, resets_at: '2026-09-28T13:00:00Z',
        scope: { model: { display_name: 'Fable' } }, is_active: false },
    ] },
  });
  assert.equal(usage.plan, 'Claude Max');
  assert.deepEqual(usage.sections[0].buckets.map(({ label, left }) => [label, left]),
    [['5h', 88], ['Weekly', 45], ['Fable', 75]]);
  assert.equal(usage.sections[0].buckets[0].resetsAt, Date.parse('2026-09-25T13:00:00Z'));
});

test('Claude usage reads older structured fields', () => {
  const usage = parseUsage({ rate_limits_available: true, rate_limits: {
    five_hour: { utilization: 3, resets_at: '2026-09-25T13:00:00Z' },
    seven_day: { utilization: 50, resets_at: '2026-09-28T13:00:00Z' },
  } });
  assert.deepEqual(usage.sections[0].buckets.map(({ label, left }) => [label, left]),
    [['5h', 97], ['Weekly', 50]]);
});

test('Claude usage explains missing authentication or plan limits', () => {
  assert.throws(() => parseUsage({ rate_limits_available: false, rate_limits: null }),
    /claude auth login/);
});
