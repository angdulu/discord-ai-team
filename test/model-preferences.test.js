const test = require('node:test');
const assert = require('node:assert/strict');
const { modelPrefForChannel, saveModelPref } = require('../src/runner');

test('a model choice becomes the default in new channels without changing existing channels', () => {
  const prefs = { existing: { model: 'sonnet', effort: 'high' } };
  saveModelPref(prefs, 'selected', { model: 'opus', effort: 'high' });
  assert.deepEqual(modelPrefForChannel(prefs, 'selected'), { model: 'opus', effort: 'high' });
  assert.deepEqual(modelPrefForChannel(prefs, 'new'), { model: 'opus', effort: 'high' });
  assert.deepEqual(modelPrefForChannel(prefs, 'existing'), { model: 'sonnet', effort: 'high' });
});

test('a bot without a saved default still uses its provider default', () => {
  assert.deepEqual(modelPrefForChannel({}, 'new'), {});
});
