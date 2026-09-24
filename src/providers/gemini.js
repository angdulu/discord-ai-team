// Gemini via the Antigravity CLI (`agy -p`), signed in with Google on first run
const { execFile } = require('child_process');
const path = require('path');

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

module.exports = function gemini({ workdir, permission }) {
  async function run(prompt, conversationId, modelId, signal, images = []) {
    const hinted = permission === 'full' ? prompt : `${TOOL_HINT}\n\n${prompt}`;
    const first = await runOnce(hinted, conversationId, modelId, signal, images);
    if (first.text || !first.denied.length || !first.sessionId) return finish(first);
    // one automatic retry in the same conversation when a denial left no answer
    const second = await runOnce(RETRY_PROMPT, first.sessionId, modelId, signal, images);
    return finish({ ...second, denied: [...first.denied, ...second.denied] });
  }

  function finish({ text, denied, sessionId }) {
    const names = [...new Set(denied)].join(', ');
    return { text: text + (names ? `${text ? '\n\n' : ''}⛔ Permission denied: ${names}` : ''), sessionId };
  }

  function runOnce(prompt, conversationId, modelId, signal, images) {
    // in -p mode the working directory alone is not the workspace; --add-dir makes it one
    const args = ['-p', prompt, '--add-dir', workdir, '--output-format', 'json', ...PERMISSION_ARGS[permission]];
    for (const dir of new Set(images.map((image) => path.dirname(image)))) args.push('--add-dir', dir);
    if (conversationId) args.push('--conversation', conversationId);
    if (modelId) args.push('--model', modelId);
    return new Promise((resolve, reject) => {
      execFile('agy', args, { cwd: workdir, signal, timeout: 5 * 60 * 1000, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
        if (err) return reject(new Error(stderr || err.message));
        let out;
        try {
          out = JSON.parse(stdout);
        } catch {
          return resolve({ text: stdout.trim(), denied: [] });
        }
        if (out.status && out.status !== 'SUCCESS') {
          return reject(new Error(`${out.status}: ${out.error || out.response || stderr}`));
        }
        const denied = (out.denied_actions || []).map((a) => a.action);
        resolve({ text: (out.response || '').trim(), denied, sessionId: out.conversation_id });
      });
    });
  }

  return { defaultName: 'Gemini', models: MODELS, run, usage };
};
