// Claude via Claude Code in print mode (`claude -p`), signed in with `claude` → /login
const path = require('path');
const { createStreamWorker } = require('../stream-worker');
const { usage } = require('./claude-usage');

const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

// aliases resolve to the latest model of each family; first entry is the default.
// Claude Code takes effort separately, so the runner's modelId is "<alias>@<effort>"
const MODELS = [
  { key: 'sonnet', label: 'Claude Sonnet', alias: 'sonnet', efforts: EFFORTS },
  { key: 'opus', label: 'Claude Opus', alias: 'opus', efforts: EFFORTS },
  { key: 'fable', label: 'Claude Fable', alias: 'fable', efforts: EFFORTS },
  { key: 'haiku', label: 'Claude Haiku', alias: 'haiku', efforts: null },
].map((m) => ({ ...m, defaultEffort: 'high', id: (e) => (e ? `${m.alias}@${e}` : m.alias) }));

// read-only: anything needing approval is denied in print mode, and file-writing tools and the shell are blocked outright
// (the shell too, since allow rules in the user's Claude settings could otherwise let commands write files)
// edit: file edits auto-approved (other commands still denied) · full: every permission check skipped
const PERMISSION_ARGS = {
  'read-only': ['--permission-mode', 'default', '--disallowedTools', 'Edit,Write,NotebookEdit,Bash'],
  edit: ['--permission-mode', 'acceptEdits'],
  full: ['--dangerously-skip-permissions'],
};

module.exports = function claudeProvider({ workdir, permission, getPermission = () => permission, getIdleTimeoutMs = () => null }) {
  const workers = new Map();
  const maxWarmWorkers = 8;

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

  function rememberWorker(sessionId, worker, modelId, mode) {
    workers.delete(sessionId);
    while (workers.size >= maxWarmWorkers) {
      const [oldId, oldEntry] = workers.entries().next().value;
      workers.delete(oldId);
      oldEntry.worker.close();
    }
    workers.set(sessionId, { worker, modelId, mode });
  }

  function closeSession(sessionId) {
    const entry = workers.get(sessionId);
    if (!entry) return;
    workers.delete(sessionId);
    entry.worker.close();
  }

  function startWorker(sessionId, modelId, images, mode) {
    const [alias, effort] = (modelId || '').split('@');
    // --strict-mcp-config: ignore the user's own MCP servers/plugins (e.g. a Discord plugin that would try to post itself)
    const args = ['-p', '--verbose', '--input-format', 'stream-json', '--output-format', 'stream-json',
      '--include-partial-messages', '--strict-mcp-config', ...PERMISSION_ARGS[mode]];
    for (const dir of new Set(images.map((image) => path.dirname(image)))) args.push('--add-dir', dir);
    if (sessionId) args.push('--resume', sessionId);
    if (alias) args.push('--model', alias);
    if (effort) args.push('--effort', effort);
    let worker;
    worker = createStreamWorker('claude', args, workdir, () => {
      for (const [id, entry] of workers) if (entry.worker === worker) workers.delete(id);
    }, getIdleTimeoutMs());
    return worker;
  }

  async function run(prompt, sessionId, modelId, signal, images = [], onUpdate) {
    const mode = getPermission();
    let entry = sessionId && workers.get(sessionId);
    if (entry) workers.delete(sessionId);
    if (entry && (entry.modelId !== modelId || entry.mode !== mode || images.length)) {
      entry.worker.close();
      entry = null;
    }
    const worker = entry?.worker || startWorker(sessionId, modelId, images, mode);
    let partial = '';
    const out = await worker.request({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: prompt }] } }, (event) => {
      if (event.type === 'stream_event') {
        if (event.event?.type === 'message_start') partial = '';
        if (event.event?.type === 'content_block_delta' && event.event.delta?.type === 'text_delta') {
          partial += event.event.delta.text || '';
          onUpdate?.(partial);
        }
      }
      return event.type === 'result' ? { done: true, value: event } : null;
    }, signal);
    if (out.is_error) {
      worker.close();
      throw new Error(out.result || out.subtype || 'claude error');
    }
    let text = (out.result || '').trim();
    if (out.permission_denials && out.permission_denials.length) {
      const names = [...new Set(out.permission_denials.map((d) => d.tool_name))].join(', ');
      text += `${text ? '\n\n' : ''}⛔ Permission denied: ${names}`;
    }
    if (images.length) worker.close();
    else if (out.session_id) rememberWorker(out.session_id, worker, modelId, mode);
    return { text, sessionId: out.session_id };
  }

  return { defaultName: 'Claudebot', models: MODELS, run, usage, closeSession, refreshIdle, refreshPermission };
};
