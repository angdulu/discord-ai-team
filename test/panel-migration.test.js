const test = require('node:test');
const assert = require('node:assert/strict');
const { isControlPanel, refreshControlPanels } = require('../src/panel-migration');

function panel(id, author = 'bot') {
  return { id, author: { id: author }, content: '**Test Bot controls**\nOpen settings, change models, or manage tasks here. You can pin this panel for quick access.',
    components: [{ components: ['settings', 'model', 'usage', 'new'].map((action) => ({ custom_id: `control:${action}` })) }] };
}

test('only generated control panel messages owned by this bot are eligible for an update', () => {
  assert.equal(isControlPanel(panel('one'), 'bot'), true);
  assert.equal(isControlPanel(panel('one', 'another-bot'), 'bot'), false);
  assert.equal(isControlPanel({ ...panel('one'), content: 'A normal AI answer.' }, 'bot'), false);
  assert.equal(isControlPanel({ ...panel('one'), components: [] }, 'bot'), false);
});

test('migration includes older pins, deduplicates recent panels, and skips inaccessible channels', async () => {
  const edits = [];
  const cursors = [];
  const rest = {
    async get(route, { query }) {
      if (route.includes('/blocked/')) throw Object.assign(new Error('Missing access'), { code: 50001 });
      if (route.endsWith('/messages/pins')) {
        cursors.push(query.get('before'));
        return query.has('before')
          ? { items: [{ message: panel('old'), pinned_at: '2026-01-01T00:00:00Z' }], has_more: false }
          : { items: [{ message: panel('recent'), pinned_at: '2026-10-24T00:00:00Z' }], has_more: true };
      }
      return [panel('recent'), panel('other', 'another-bot'), { ...panel('answer'), content: 'Normal reply' }];
    },
    async patch(route, payload) { edits.push({ route, payload }); },
  };
  assert.deepEqual(await refreshControlPanels({ rest, botId: 'bot', name: 'Test Bot', channelIds: ['channel', 'channel', 'blocked'] }),
    { updated: 2, inaccessible: 1 });
  assert.deepEqual(cursors, [null, '2026-10-24T00:00:00Z']);
  assert.equal(edits.length, 2);
  const buttons = edits[0].payload.body.components.flatMap((row) => row.components.map((item) => item.label));
  assert.deepEqual(buttons, ['Agent settings', 'Model', 'Usage', 'New conversation', 'Resume', 'Rename']);
  assert.deepEqual(edits[0].payload.body.allowed_mentions, { parse: [] });
});
