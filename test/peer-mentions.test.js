const test = require('node:test');
const assert = require('node:assert/strict');
const { resolvePeerMentions } = require('../src/peer-mentions');

test('eligible peer names become real Discord mentions without triggering plain names', () => {
  const peers = [{ name: 'Claire', id: '123', displayName: 'Claire Writer', username: 'claire_bot' }];
  assert.equal(resolvePeerMentions('Claire, please read this. @Claire, your turn.', peers),
    'Claire, please read this. <@123>, your turn.');
  assert.equal(resolvePeerMentions('@Claire Writer and @CLAIRE_BOT', peers), '<@123> and <@123>');
  assert.equal(resolvePeerMentions('@Claire2 @Unknown', peers), '@Claire2 @Unknown');
});

test('code, URLs, and ambiguous peer names do not cause a handoff', () => {
  const peers = [
    { name: 'Claire', id: '123', displayName: 'Editor' },
    { name: 'Minnie', id: '456', displayName: 'Editor' },
  ];
  const reply = '@Claire `@Claire` https://example.com/@Claire\n```text\n@Minnie\n```\n@Editor @Minnie';
  assert.equal(resolvePeerMentions(reply, peers),
    '<@123> `@Claire` https://example.com/@Claire\n```text\n@Minnie\n```\n@Editor <@456>');
});

test('no peer means no conversion', () => {
  assert.equal(resolvePeerMentions('@Claire', []), '@Claire');
});
