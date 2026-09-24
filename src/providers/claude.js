// Claude via Claude Code in print mode (`claude -p`), signed in with `claude` → /login
const { execFile } = require('child_process');
const path = require('path');
const { createStreamWorker } = require('../stream-worker');

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

function claude(args, prompt, options) {
  return new Promise((resolve, reject) => {
    const child = execFile('claude', args, { maxBuffer: 10 * 1024 * 1024, ...options }, (err, stdout, stderr) => {
      let out;
      try {
        out = JSON.parse(stdout);
      } catch {
        return reject(new Error(stderr || (err && err.message) || 'unexpected output from claude'));
      }
      resolve(out);
    });
    // the prompt goes through stdin, so it can never be mistaken for a flag value
    child.stdin.end(prompt);
  });
}

// `claude -p /usage` is a local command: it reports plan usage without a model call (costs no quota)
async function usage() {
  const out = await claude(['-p', '--output-format', 'json', '--strict-mcp-config'], '/usage', { timeout: 60 * 1000 });
  const buckets = [];
  for (const line of String(out.result || '').split('\n')) {
    const m = line.match(/^Current (session|week[^:]*):\s*(\d+)% used\s*·\s*resets (.+)$/);
    if (!m) continue;
    const scope = m[1].match(/\(([^)]+)\)/);
    const label = m[1] === 'session' ? '5h' : !scope || /all models/i.test(scope[1]) ? 'Weekly' : scope[1].replace(/ only$/i, '');
    buckets.push({ label, left: 100 - Number(m[2]), resetsText: m[3].replace(/\s*\([^)]*\)\s*$/, '') });
  }
  if (!buckets.length) throw new Error('unexpected /usage output');
  return { plan: 'Claude subscription', sections: [{ name: 'Claude Code', buckets }], note: 'Live from claude /usage' };
}

module.exports = function claudeProvider({ workdir, permission }) {
  const workers = new Map();

  function startWorker(sessionId, modelId, images) {
    const [alias, effort] = (modelId || '').split('@');
    // --strict-mcp-config: ignore the user's own MCP servers/plugins (e.g. a Discord plugin that would try to post itself)
    const args = ['-p', '--verbose', '--input-format', 'stream-json', '--output-format', 'stream-json',
      '--include-partial-messages', '--strict-mcp-config', ...PERMISSION_ARGS[permission]];
    for (const dir of new Set(images.map((image) => path.dirname(image)))) args.push('--add-dir', dir);
    if (sessionId) args.push('--resume', sessionId);
    if (alias) args.push('--model', alias);
    if (effort) args.push('--effort', effort);
    let worker;
    worker = createStreamWorker('claude', args, workdir, () => {
      for (const [id, entry] of workers) if (entry.worker === worker) workers.delete(id);
    });
    return worker;
  }

  async function run(prompt, sessionId, modelId, signal, images = [], onUpdate) {
    let entry = sessionId && workers.get(sessionId);
    if (entry && (entry.modelId !== modelId || images.length)) {
      entry.worker.close();
      entry = null;
    }
    const worker = entry?.worker || startWorker(sessionId, modelId, images);
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
    else if (out.session_id) workers.set(out.session_id, { worker, modelId });
    return { text, sessionId: out.session_id };
  }

  return { defaultName: 'Claude', models: MODELS, run, usage };
};
