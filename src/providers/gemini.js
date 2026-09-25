// Gemini via the Antigravity CLI (`agy -p`), signed in with Google on first run
const { execFile } = require('child_process');
const path = require('path');
const { createStreamWorker } = require('../stream-worker');

// effort is baked into agy model ids (--effort conflicts with them), so the menu picks the id
const MODELS = [
  { key: 'g38f', label: 'Gemini 3.8 Flash', efforts: ['low', 'medium', 'high'], id: (e) => `gemini-3.8-flash-${e}` },
  { key: 'g37f', label: 'Gemini 3.7 Flash', efforts: ['low', 'medium', 'high'], id: (e) => `gemini-3.7-flash-${e}` },
  { key: 'g36f', label: 'Gemini 3.6 Flash', efforts: ['low', 'medium', 'high'], id: (e) => `gemini-3.6-flash-${e}` },
  { key: 'g31p', label: 'Gemini 3.1 Pro', efforts: ['low', 'high'], id: (e) => `gemini-3.1-pro-${e}` },
  { key: 'sonnet', label: 'Claude Sonnet 4.6', efforts: null, id: () => 'claude-sonnet-4-6' },
  { key: 'opus', label: 'Claude Opus 4.6', efforts: null, id: () => 'claude-opus-4-6-thinking' },
  { key: 'gptoss', label: 'GPT-OSS 120B', efforts: null, id: () => 'gpt-oss-120b-medium' },
];

// read-only: agy denies every tool not allowed in ~/.gemini/antigravity-cli/settings.json
// edit: file edits auto-approved (shell still limited to that allowlist) · full: every tool auto-approved
const PERMISSION_ARGS = {
  'read-only': [],
  edit: ['--mode', 'accept-edits'],
  full: ['--dangerously-skip-permissions'],
};

// `agy -p /usage` answers from the quota service without starting the agent (costs no quota)
function usage() {
  return new Promise((resolve, reject) => {
    execFile('agy', ['-p', '/usage', '--output-format', 'json'], { timeout: 60 * 1000 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(stderr || err.message));
      let groups;
      try {
        groups = JSON.parse(stdout).command.data.groups;
      } catch {
        return reject(new Error('unexpected /usage output'));
      }
      const sections = groups.map((g) => ({
        name: g.name,
        buckets: [...g.buckets]
          .sort((a, b) => (a.window === '5h' ? -1 : b.window === '5h' ? 1 : 0))
          .map((b) => ({ label: b.window === '5h' ? '5h' : 'Weekly', left: b.remaining_fraction * 100, resetsAt: b.reset_time })),
      }));
      resolve({ plan: 'Google AI (Antigravity)', sections, note: 'Live from agy /usage' });
    });
  });
}

// Gemini tends to open with shell commands (git status, ...); outside `full` most are blocked,
// and a blocked command often ends the turn with no answer
const TOOL_HINT = 'Read and search files with your file tools, not shell commands (most shell commands are blocked here).';
const RETRY_PROMPT = 'Your shell command was blocked. Do not run shell commands. Use your file tools to read what you need, then answer the original request.';

module.exports = function gemini({ workdir, permission, getPermission = () => permission,
  getIdleTimeoutMs = () => 5 * 60 * 1000 }) {
  const workers = new Map();

  function refreshIdle() {
    const timeout = getIdleTimeoutMs();
    for (const entry of workers.values()) entry.worker.setIdleTimeoutMs(timeout);
  }
  function refreshPermission() {
    for (const entry of workers.values()) entry.worker.close();
    workers.clear();
  }
  const idleRefresh = setInterval(refreshIdle, 5000);
  idleRefresh.unref();

  function closeSession(sessionId) {
    const entry = workers.get(sessionId);
    if (!entry) return;
    workers.delete(sessionId);
    entry.worker.close();
  }

  function startWorker(conversationId, modelId, images, mode) {
    const args = ['--input-format', 'stream-json', '--output-format', 'stream-json',
      '--add-dir', workdir, ...PERMISSION_ARGS[mode]];
    for (const dir of new Set(images.map((image) => path.dirname(image)))) args.push('--add-dir', dir);
    if (conversationId) args.push('--conversation', conversationId);
    if (modelId) args.push('--model', modelId);
    args.push('--print=');
    let worker;
    worker = createStreamWorker('agy', args, workdir, () => {
      for (const [id, entry] of workers) if (entry.worker === worker) workers.delete(id);
    }, getIdleTimeoutMs());
    return worker;
  }

  async function run(prompt, conversationId, modelId, signal, images = [], onUpdate) {
    const mode = getPermission();
    const hinted = mode === 'full' ? prompt : `${TOOL_HINT}\n\n${prompt}`;
    const first = await runOnce(hinted, conversationId, modelId, signal, images, onUpdate, mode);
    if (first.text || !first.denied.length || !first.sessionId) return finish(first);
    // one automatic retry in the same conversation when a denial left no answer
    const second = await runOnce(RETRY_PROMPT, first.sessionId, modelId, signal, images, onUpdate, mode);
    return finish({ ...second, denied: [...first.denied, ...second.denied] });
  }

  function finish({ text, denied, sessionId }) {
    const names = [...new Set(denied)].join(', ');
    return { text: text + (names ? `${text ? '\n\n' : ''}⛔ Permission denied: ${names}` : ''), sessionId };
  }

  async function runOnce(prompt, conversationId, modelId, signal, images, onUpdate, mode) {
    let entry = conversationId && workers.get(conversationId);
    if (entry && (entry.modelId !== modelId || entry.mode !== mode || images.length)) {
      entry.worker.close();
      entry = null;
    }
    const worker = entry?.worker || startWorker(conversationId, modelId, images, mode);
    let partial = '';
    const out = await worker.request({ event: 'user', message: { content: prompt } }, (event) => {
      if (event.event === 'step_update' && event.step_update?.text_delta) {
        partial += event.step_update.text_delta;
        onUpdate?.(partial);
      }
      return event.event === 'result' ? { done: true, value: event.result } : null;
    }, signal);
    if (out.status && out.status !== 'SUCCESS') {
      worker.close();
      throw new Error(`${out.status}: ${out.error || out.response || 'agy error'}`);
    }
    if (images.length) worker.close();
    else if (out.conversation_id) workers.set(out.conversation_id, { worker, modelId, mode });
    const denied = (out.denied_actions || []).map((a) => a.action);
    return { text: (out.response || '').trim(), denied, sessionId: out.conversation_id };
  }

  return { defaultName: 'Geminibot', models: MODELS, run, usage, closeSession, refreshIdle, refreshPermission };
};
