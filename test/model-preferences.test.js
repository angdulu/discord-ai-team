const test = require('node:test');
const assert = require('node:assert/strict');
const { modelPrefForChannel, saveModelPref } = require('../src/runner');

test('model and effort choices apply only to the selected channel', () => {
  const prefs = { existing: { model: 'sonnet', effort: 'high' } };
  saveModelPref(prefs, 'selected', { model: 'opus', effort: 'high' });
  assert.deepEqual(modelPrefForChannel(prefs, 'selected'), { model: 'opus', effort: 'high' });
  assert.deepEqual(modelPrefForChannel(prefs, 'new'), {});
  assert.deepEqual(modelPrefForChannel(prefs, 'existing'), { model: 'sonnet', effort: 'high' });
  saveModelPref(prefs, 'existing', { model: 'sonnet', effort: 'low' });
  assert.deepEqual(modelPrefForChannel(prefs, 'selected'), { model: 'opus', effort: 'high' });
  assert.deepEqual(modelPrefForChannel(prefs, 'existing'), { model: 'sonnet', effort: 'low' });
  assert.equal(prefs._default, undefined);
});

test('unconfigured channels use the provider default even with a legacy shared default', () => {
  assert.deepEqual(modelPrefForChannel({}, 'new'), {});
  const prefs = { _default: { model: 'opus', effort: 'high' } };
  assert.deepEqual(modelPrefForChannel(prefs, 'new'), {});
  saveModelPref(prefs, 'selected', { model: 'sonnet', effort: 'low' });
  assert.deepEqual(modelPrefForChannel(prefs, 'new'), {});
  assert.deepEqual(modelPrefForChannel(JSON.parse(JSON.stringify(prefs)), 'selected'), { model: 'sonnet', effort: 'low' });
});
