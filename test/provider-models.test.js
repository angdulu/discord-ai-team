const test = require('node:test');
const assert = require('node:assert/strict');
const { modelsFromList } = require('../src/providers/gemini');
const { modelsFromCatalog } = require('../src/providers/claude');
const { modelPanel } = require('../src/runner');

test('Gemini discovery groups effort variants and keeps fixed IDs and saved keys', () => {
  const models = modelsFromList([
    'Fetching available models...',
    'gemini-new-flash-high\tGemini New Flash (High)',
    'gemini-new-flash-low\tGemini New Flash (Low)',
    'gemini-3.8-flash-high\tGemini 3.8 Flash (High)',
    'gemini-3.8-flash-medium\tGemini 3.8 Flash (Medium)',
    'gemini-3.8-flash-low\tGemini 3.8 Flash (Low)',
    'gpt-oss-120b-medium\tGPT-OSS 120B (Medium)',
    'claude-sonnet-4-6\tClaude Sonnet 4.6 (Thinking)',
  ].join('\n'));
  assert.deepEqual(models.map((model) => model.key), ['gemini-new-flash', 'g38f', 'gptoss', 'sonnet']);
  assert.deepEqual(models[0].efforts, ['low', 'high']);
  assert.equal(models[0].id('low'), 'gemini-new-flash-low');
  assert.equal(models[0].defaultEffort, 'high');
  assert.equal(models[2].efforts, null);
  assert.equal(models[2].id(null), 'gpt-oss-120b-medium');
  assert.throws(() => modelsFromList('No models'), /no selectable models/);
});

test('Claude discovery keeps aliases and derives effort options from the CLI', () => {
  const models = modelsFromCatalog({ models: [
    { value: 'default', displayName: 'Default', resolvedModel: 'claude-opus-new' },
    { value: 'claude-sonnet-old', displayName: 'Sonnet Old', resolvedModel: 'claude-sonnet-old' },
    { value: 'sonnet', displayName: 'Sonnet New', resolvedModel: 'claude-sonnet-new',
      supportsEffort: true, supportedEffortLevels: ['low', 'high'] },
    { value: 'claude-fable-new', displayName: 'Fable New', resolvedModel: 'claude-fable-new',
      supportsEffort: true, supportedEffortLevels: ['medium'] },
    { value: 'haiku', displayName: 'Haiku', supportsEffort: false },
    { value: 'claude-new-family', displayName: 'New Family' },
  ] });
  assert.equal(models[0].key, 'sonnet');
  assert.equal(models[0].label, 'Sonnet New');
  assert.equal(models[0].id('high'), 'sonnet@high');
  assert.equal(new Set(models.map((model) => model.key)).size, models.length);
  assert.deepEqual(models.find((model) => model.key === 'fable').efforts, ['medium']);
  assert.equal(models.find((model) => model.key === 'fable').id('medium'), 'claude-fable-new@medium');
  assert.equal(models.find((model) => model.key === 'haiku').efforts, null);
  assert.ok(models.find((model) => model.key === 'claude-new-family'));
  assert.throws(() => modelsFromCatalog({ models: [] }), /no selectable models/);
});

test('model menus paginate beyond Discord limits and open on the selected model', () => {
  const models = Array.from({ length: 28 }, (_, index) => ({
    key: `model-${index}`, label: `Model ${index}`, efforts: ['low', 'high'],
    defaultEffort: 'high', id: (effort) => `model-${index}@${effort}`,
  }));
  const first = modelPanel('bot', 'Bot', models, { model: 'model-0' });
  assert.equal(first.components[0].toJSON().components[0].options.length, 25);
  const second = modelPanel('bot', 'Bot', models, { model: 'model-27' });
  const menu = second.components[0].toJSON().components[0];
  assert.equal(menu.options.length, 3);
  assert.equal(menu.custom_id, 'bot:model:1');
  assert.equal(menu.options.find((option) => option.default).value, 'model-27');
  assert.equal(second.components[2].toJSON().components[1].disabled, true);
});

test('Claude default selection shows the resolved model while still invoking the default alias', () => {
  const models = modelsFromCatalog({ models: [
    { value: 'default', displayName: 'Default (recommended)', resolvedModel: 'claude-opus-5-5',
      supportsEffort: true, supportedEffortLevels: ['low', 'high'] },
    { value: 'opus', displayName: 'Opus 5.5', resolvedModel: 'claude-opus-5-5' },
  ] });
  const selected = models.find((model) => model.key === 'default');
  assert.equal(selected.label, 'Opus 5.5 (account default)');
  assert.equal(selected.id('high'), 'default@high');
  const panel = modelPanel('claude', 'Claude', models, { model: 'default', effort: 'high' });
  assert.match(panel.content, /Opus 5\.5 \(account default\)/);
  assert.match(panel.content, /claude-opus-5-5@high/);
  assert.doesNotMatch(panel.content, /default@high/);
  assert.equal(panel.components[0].toJSON().components[0].options.find((option) => option.default).label,
    'Opus 5.5 (account default)');
});
