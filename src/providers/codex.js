// ChatGPT via the Codex CLI (`codex exec`), signed in with `codex login`
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { createAppServerClient } = require('../app-server-client');

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
const SANDBOX_POLICY = {
  'read-only': { type: 'readOnly' },
  edit: { type: 'workspaceWrite', writableRoots: [], networkAccess: false },
  full: { type: 'dangerFullAccess' },
};

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
  let app;
  let loadedThreads = new Set();

  function getApp() {
    if (!app || app.closed) {
      loadedThreads = new Set();
      app = createAppServerClient(workdir);
    }
    return app;
  }

  async function run(prompt, threadId, modelId, signal, images = [], onUpdate) {
    const [model, effort] = (modelId || '').split('@');
    const client = getApp();
    await client.ready;
    if (signal?.aborted) throw new Error('aborted');
    if (threadId && !loadedThreads.has(threadId)) {
      await client.request('thread/resume', { threadId });
      loadedThreads.add(threadId);
    }
    if (!threadId) {
      const started = await client.request('thread/start', { cwd: workdir, approvalPolicy: 'never' });
      threadId = started.thread.id;
      loadedThreads.add(threadId);
    }

    const sandboxPolicy = permission === 'edit'
      ? { ...SANDBOX_POLICY.edit, writableRoots: [workdir] }
      : SANDBOX_POLICY[permission];
    return new Promise((resolve, reject) => {
      let turnId;
      let completed;
      let lastText = '';
      let finalText = '';
      let partial = '';
      let timer;
      let settled = false;
      const phases = new Map();
      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        unsubscribe();
      };
      const finish = (error) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (error) reject(error);
        else resolve({ text: (finalText || lastText).trim(), sessionId: threadId });
      };
      const checkCompleted = () => {
        if (!completed || !turnId || completed.turn?.id !== turnId) return;
        const turn = completed.turn;
        finish(turn.status === 'completed' ? null : new Error(turn.error?.message || `turn ${turn.status}`));
      };
      const abort = () => {
        if (turnId) client.request('turn/interrupt', { threadId, turnId }).catch(() => {});
      };
      const unsubscribe = client.subscribe((event) => {
        if (event.method === 'server/closed') return finish(event.params.error);
        if (event.params?.threadId !== threadId) return;
        if (event.method === 'item/started' && event.params.item?.type === 'agentMessage') {
          phases.set(event.params.item.id, event.params.item.phase);
        }
        if (event.method === 'item/agentMessage/delta') {
          const phase = phases.get(event.params.itemId);
          if (phase === 'final_answer' || !phase) {
            partial += event.params.delta || '';
            onUpdate?.(partial);
          }
        }
        if (event.method === 'item/completed' && event.params.item?.type === 'agentMessage') {
          lastText = event.params.item.text || lastText;
          if (event.params.item.phase === 'final_answer') finalText = event.params.item.text || finalText;
        }
        if (event.method === 'turn/completed') {
          completed = event.params;
          checkCompleted();
        }
      });
      signal?.addEventListener('abort', abort, { once: true });
      timer = setTimeout(() => {
        abort();
        finish(new Error('codex timed out'));
      }, 5 * 60 * 1000);
      client.request('turn/start', {
        threadId,
        input: [{ type: 'text', text: prompt }, ...images.map((image) => ({ type: 'localImage', path: image }))],
        cwd: workdir,
        approvalPolicy: 'never',
        sandboxPolicy,
        ...(model ? { model } : {}),
        ...(effort ? { effort } : {}),
      }).then((started) => {
        turnId = started.turn.id;
        if (signal?.aborted) abort();
        checkCompleted();
      }, finish);
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
