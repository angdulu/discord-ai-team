// ChatGPT via the Codex CLI (`codex exec`), signed in with `codex login`
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile, spawn } = require('child_process');

const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const EFFORTS_ULTRA = [...EFFORTS, 'ultra'];

// ids/effort levels from ~/.codex/models_cache.json; first entry is the default.
// codex takes effort separately, so the runner's modelId is "<model>@<effort>"
const MODELS = [
  { key: 'g6sol', label: 'GPT-6-Sol', model: 'gpt-6-sol', efforts: EFFORTS_ULTRA },
  { key: 'g6astra', label: 'GPT-6-Astra', model: 'gpt-6-astra', efforts: EFFORTS_ULTRA },
  { key: 'g6luna', label: 'GPT-6-Luna', model: 'gpt-6-luna', efforts: EFFORTS },
  { key: 'g56sol', label: 'GPT-5.6-Sol', model: 'gpt-5.6-sol', efforts: EFFORTS_ULTRA },
  { key: 'g56terra', label: 'GPT-5.6-Terra', model: 'gpt-5.6-terra', efforts: EFFORTS_ULTRA },
  { key: 'g56luna', label: 'GPT-5.6-Luna', model: 'gpt-5.6-luna', efforts: EFFORTS },
  { key: 'g55', label: 'GPT-5.5', model: 'gpt-5.5', efforts: ['low', 'medium', 'high', 'xhigh'] },
].map((m) => ({ ...m, defaultEffort: 'high', id: (e) => `${m.model}@${e}` }));

// read-only: OS sandbox blocks all writes · edit: may write inside the workspace · full: no sandbox
const SANDBOX = { 'read-only': 'read-only', edit: 'workspace-write', full: 'danger-full-access' };

// live: `codex app-server` answers account/rateLimits/read from the account, no model call (costs no quota)
function liveRateLimits() {
  return new Promise((resolve, reject) => {
    const child = spawn('codex', ['app-server'], { stdio: ['pipe', 'pipe', 'ignore'] });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('codex app-server timed out'));
    }, 20 * 1000);
    const send = (msg) => child.stdin.write(JSON.stringify(msg) + '\n');
    let buf = '';
    child.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (msg.id === 0) {
          send({ method: 'initialized' });
          send({ method: 'account/rateLimits/read', id: 1 });
        }
        if (msg.id === 1) {
          clearTimeout(timer);
          child.kill();
          if (msg.error || !msg.result) return reject(new Error((msg.error && msg.error.message) || 'no result'));
          resolve(msg.result);
        }
      }
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    send({ method: 'initialize', id: 0, params: { clientInfo: { name: 'discord-bot', title: 'Discord bot', version: '1.0' } } });
  });
}

function planLabel(planType) {
  return planType ? `ChatGPT ${planType[0].toUpperCase()}${planType.slice(1)}` : 'ChatGPT';
}

// fallback: every codex call records the plan's rate limits in its session log; read the latest one
function latestRollouts(max) {
  const files = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries.sort((a, b) => b.name.localeCompare(a.name))) { // newest first (date-named)
      if (files.length >= max) return;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.jsonl')) files.push(p);
    }
  };
  walk(path.join(os.homedir(), '.codex', 'sessions'));
  return files;
}

function usageFromLogs() {
  const candidates = latestRollouts(20)
    .map((f) => ({ f, mtime: fs.statSync(f).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  for (const { f, mtime } of candidates) {
    const lines = fs.readFileSync(f, 'utf8').split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!lines[i].includes('"rate_limits"')) continue;
      let limits;
      try {
        const find = (o) => (o && typeof o === 'object' ? o.rate_limits || Object.values(o).map(find).find(Boolean) : null);
        limits = find(JSON.parse(lines[i]));
      } catch {
        continue;
      }
      if (!limits || !limits.primary) continue;
      const bucket = (label, b) => ({ label, left: 100 - b.used_percent, resetsAt: b.resets_at * 1000 });
      const buckets = [bucket('5h', limits.primary)];
      if (limits.secondary) buckets.push(bucket('Weekly', limits.secondary));
      const asOf = new Date(mtime).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
      return { plan: planLabel(limits.plan_type), sections: [{ name: 'Codex', buckets }], note: `As of the last Codex call, ${asOf}` };
    }
  }
  throw new Error('no rate-limit data in ~/.codex/sessions yet');
}

module.exports = function codex({ workdir, permission }) {
  function run(prompt, threadId, modelId, signal, images = []) {
    const [model, effort] = (modelId || '').split('@');
    const opts = ['--skip-git-repo-check', '--json', '-c', `sandbox_mode="${SANDBOX[permission]}"`];
    if (model) opts.push('-m', model);
    if (effort) opts.push('-c', `model_reasoning_effort="${effort}"`);
    for (const image of images) opts.push('-i', image);
    // --image accepts multiple files, so stop option parsing before the positional prompt.
    // Sending the prompt through stdin also keeps user text out of the process argument list.
    const args = threadId ? ['exec', 'resume', ...opts, '--', threadId, '-'] : ['exec', ...opts, '--', '-'];

    return new Promise((resolve, reject) => {
      const child = execFile(
        'codex',
        args,
        { cwd: workdir, signal, timeout: 5 * 60 * 1000, maxBuffer: 10 * 1024 * 1024 },
        (err, stdout, stderr) => {
          let sessionId;
          let text = '';
          let failure;
          for (const line of stdout.split('\n')) {
            let ev;
            try {
              ev = JSON.parse(line);
            } catch {
              continue;
            }
            if (ev.type === 'thread.started') sessionId = ev.thread_id;
            if (ev.type === 'item.completed' && ev.item && ev.item.type === 'agent_message') text = ev.item.text;
            if (ev.type === 'turn.failed') failure = (ev.error && ev.error.message) || 'turn failed';
            if (ev.type === 'error') failure = ev.message || 'error';
          }
          if (failure) return reject(new Error(failure));
          if (err && !text) return reject(new Error(stderr || err.message));
          resolve({ text: text.trim(), sessionId });
        }
      );
      child.stdin.end(prompt);
    });
  }

  async function usage() {
    try {
      const r = await liveRateLimits();
      const l = r.rateLimits;
      const bucket = (label, b) => ({ label, left: 100 - b.usedPercent, resetsAt: b.resetsAt * 1000 });
      const buckets = [bucket('5h', l.primary)];
      if (l.secondary) buckets.push(bucket('Weekly', l.secondary));
      const resets = ((r.rateLimitResetCredits && r.rateLimitResetCredits.credits) || []).filter((c) => c.status === 'available');
      const note = resets.length ? `Live · ${resets.length} free limit reset available` : 'Live from codex app-server';
      return { plan: planLabel(l.planType), sections: [{ name: 'Codex', buckets }], note };
    } catch {
      return usageFromLogs();
    }
  }

  return { defaultName: 'Codex', models: MODELS, run, usage };
};
