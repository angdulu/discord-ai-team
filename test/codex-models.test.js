const test = require('node:test');
const assert = require('node:assert/strict');
const { modelsFromCatalog } = require('../src/providers/codex');

test('Codex catalog adds new models and preserves saved model keys', () => {
  const models = modelsFromCatalog({ data: [
    { model: 'gpt-6.1-sol', displayName: 'GPT-6.1-Sol', hidden: false,
      defaultReasoningEffort: 'medium', supportedReasoningEfforts: [
        { reasoningEffort: 'low' }, { reasoningEffort: 'high' },
      ] },
    { model: 'gpt-6-sol', displayName: 'GPT-6-Sol', hidden: false,
      defaultReasoningEffort: 'medium', supportedReasoningEfforts: [{ reasoningEffort: 'high' }] },
    { model: 'hidden-model', hidden: true, supportedReasoningEfforts: [{ reasoningEffort: 'high' }] },
  ] });

  assert.deepEqual(models.map((model) => model.key), ['gpt-6.1-sol', 'g6sol']);
  assert.deepEqual(models[0].efforts, ['low', 'high']);
  assert.equal(models[0].id('high'), 'gpt-6.1-sol@high');
  assert.equal(models[0].defaultEffort, 'high');
});

test('Codex catalog rejects an empty or invalid model list', () => {
  assert.throws(() => modelsFromCatalog({}), /unexpected model\/list response/);
  assert.throws(() => modelsFromCatalog({ data: [] }), /no selectable models/);
  assert.throws(() => modelsFromCatalog({ data: [
    { model: 'gpt-new', supportedReasoningEfforts: [] },
  ] }), /no selectable models/);
});
