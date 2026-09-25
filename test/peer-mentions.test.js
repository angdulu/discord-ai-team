const test = require('node:test');
const assert = require('node:assert/strict');
const { resolvePeerMentions, debatePeerInstructions, resolveDebateHandoff } = require('../src/peer-mentions');

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

test('debate prompt lists only available agents with their exact Discord mentions', () => {
  const instructions = debatePeerInstructions([
    { name: 'Claudebot', displayName: 'Claude', id: '123' },
    { name: 'Minnie', id: 'invalid' },
  ]);
  assert.match(instructions, /Claude: <@123>/);
  assert.doesNotMatch(instructions, /Minnie/);
  assert.match(instructions, /Do not invent an agent/);
});

test('an invalid closing handoff is routed to a real peer in a bot debate turn', () => {
  const peers = [
    { name: 'Claudebot', displayName: 'Claude', id: '123' },
    { name: 'Geminibot', displayName: 'Gemini', id: '456' },
  ];
  const reply = '@Claude: I disagree.\n\n@Minnie, what do you think?';
  assert.equal(resolveDebateHandoff(reply, peers, { recoverInvalidHandoff: true }),
    '<@123>: I disagree.\n\n<@456>, what do you think?');
  assert.equal(resolveDebateHandoff(reply, peers),
    '<@123>: I disagree.\n\n@Minnie, what do you think?');
});

test('valid handoffs and ordinary mentions are not rerouted', () => {
  const peers = [{ name: 'Claude', id: '123' }];
  assert.equal(resolveDebateHandoff('See @Minnie in the notes.\n\n@Claude, your turn.', peers,
    { recoverInvalidHandoff: true }), 'See @Minnie in the notes.\n\n<@123>, your turn.');
  assert.equal(resolveDebateHandoff('`@Minnie`\n\nNo handoff.', peers,
    { recoverInvalidHandoff: true }), '`@Minnie`\n\nNo handoff.');
  assert.equal(resolveDebateHandoff('@Minnie, your turn.', [],
    { recoverInvalidHandoff: true }), '@Minnie, your turn.');
});
