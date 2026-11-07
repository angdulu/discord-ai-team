const test = require('node:test');
const assert = require('node:assert/strict');
const { createGeminiDiagnostics } = require('../src/gemini-diagnostics');

test('Gemini diagnostics count each current step once and exclude historical events and private content', () => {
  let clock = 0;
  const diagnostics = createGeminiDiagnostics({ model: 'flash-high', reused: true,
    resumed: true, promptChars: 42, now: () => clock });
  const emit = (step) => diagnostics.observe({ event: 'step_update', step_update: step });
  clock = 5;
  emit({ step_index: 3, step_type: 'tool', tool_name: 'old_tool', duration_seconds: 100 });
  emit({ step_index: 10, step_type: 'user_input' });
  clock = 100;
  emit({ step_index: 11, step_type: 'agent_response', state: 'ACTIVE', text_delta: 'private reply' });
  emit({ step_index: 11, step_type: 'agent_response', state: 'DONE', duration_seconds: 0.25 });
  emit({ step_index: 12, step_type: 'tool', state: 'ACTIVE', tool_name: 'read_file',
    tool_info: { parameters: { Path: '/private/file' }, output: 'private data' } });
  emit({ step_index: 12, step_type: 'tool', state: 'DONE', duration_seconds: 0.1 });
  emit({ step_index: 12, step_type: 'tool', state: 'DONE', duration_seconds: 0.1 });
  emit({ step_index: 13, step_type: 'error_message', state: 'ERROR', text_delta: 'private error' });
  // Cumulative conversation counters must not contaminate this turn.
  diagnostics.observe({ event: 'result', result: { duration_seconds: 900, usage: { total_tokens: 1000000 } } });
  clock = 500;
  const result = diagnostics.finish('SUCCESS');
  assert.deepEqual(result, { model: 'flash-high', reused: true, resumed: true, promptChars: 42,
    userStepIndex: 10, wallMs: 500, firstEventMs: 5, firstTextMs: 100,
    agentSteps: 1, agentMs: 250, toolSteps: 1, toolMs: 100,
    tools: { read_file: 1 }, errorSteps: 1, status: 'SUCCESS' });
  assert.doesNotMatch(JSON.stringify(result), /private|old_tool|1000000/);
});

test('Gemini diagnostics handle no response, missing durations, and unsafe tool names', () => {
  const diagnostics = createGeminiDiagnostics({ reused: false, resumed: false, promptChars: 0, now: () => 0 });
  const emit = (step) => diagnostics.observe({ event: 'step_update', step_update: step });
  emit({ step_index: 0, step_type: 'user_input' });
  emit({ step_index: 1, step_type: 'tool_call', state: 'ERROR', tool_name: 'private path with spaces', duration_seconds: -1 });
  assert.deepEqual(diagnostics.finish('DISCONNECTED'), { model: undefined, reused: false, resumed: false,
    promptChars: 0, userStepIndex: 0, wallMs: 0, firstEventMs: 0, firstTextMs: null,
    agentSteps: 0, agentMs: 0, toolSteps: 1, toolMs: 0, tools: { unknown: 1 },
    errorSteps: 1, status: 'DISCONNECTED' });
});
