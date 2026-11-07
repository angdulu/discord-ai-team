const { performance } = require('perf_hooks');

// agy's result usage/duration are cumulative across the conversation. Measure
// this request ourselves and use unique current-turn steps for the breakdown.
function createGeminiDiagnostics({ model, reused, resumed, promptChars, now = () => performance.now() }) {
  const started = now();
  const steps = new Map();
  let firstEventMs = null;
  let firstTextMs = null;
  let userStepIndex;

  function observe(event) {
    firstEventMs ??= Math.round(now() - started);
    const step = event.step_update;
    if (!step || !Number.isInteger(step.step_index)) return;
    if (step.step_type === 'user_input' && userStepIndex === undefined) userStepIndex = step.step_index;
    // A resumed worker can emit historical steps before the current user step.
    if (userStepIndex === undefined || step.step_index < userStepIndex) return;
    if (step.step_type === 'agent_response' && step.text_delta) firstTextMs ??= Math.round(now() - started);
    const previous = steps.get(step.step_index) || {};
    const name = step.tool_name || step.tool_info?.name;
    // Never retain tool arguments, results, prompts, or error messages.
    const tool = typeof name === 'string' && /^[a-zA-Z0-9_.:-]{1,100}$/.test(name) ? name : previous.tool;
    steps.set(step.step_index, {
      type: step.step_type || previous.type,
      state: step.state || previous.state,
      tool,
      durationMs: Number.isFinite(step.duration_seconds) && step.duration_seconds >= 0
        ? Math.round(step.duration_seconds * 1000) : previous.durationMs,
    });
  }

  function finish(status) {
    const tools = {};
    let agentSteps = 0;
    let agentMs = 0;
    let toolSteps = 0;
    let toolMs = 0;
    let errorSteps = 0;
    for (const step of steps.values()) {
      if (step.type === 'agent_response') {
        agentSteps++;
        agentMs += step.durationMs || 0;
      }
      if (step.tool || ['tool', 'tool_call'].includes(step.type)) {
        toolSteps++;
        toolMs += step.durationMs || 0;
        const name = step.tool || 'unknown';
        tools[name] = (tools[name] || 0) + 1;
      }
      if (step.type === 'error_message' || step.state === 'ERROR') errorSteps++;
    }
    return { model, reused, resumed, promptChars, userStepIndex: userStepIndex ?? null,
      wallMs: Math.round(now() - started), firstEventMs, firstTextMs,
      agentSteps, agentMs, toolSteps, toolMs, tools, errorSteps, status };
  }

  return { observe, finish };
}

module.exports = { createGeminiDiagnostics };
