const { spawn } = require('node:child_process');

// Claude Code's headless get_usage control request returns plan limits without a model turn.
function parseUsage(response) {
  if (!response?.rate_limits_available || !response.rate_limits) {
    throw new Error('Claude plan usage is unavailable. Check `claude auth status`; if signed out, run `claude auth login`.');
  }

  const limits = response.rate_limits;
  const rows = Array.isArray(limits.limits) ? limits.limits : [
    limits.five_hour && { kind: 'session', percent: limits.five_hour.utilization, resets_at: limits.five_hour.resets_at },
    limits.seven_day && { kind: 'weekly_all', percent: limits.seven_day.utilization, resets_at: limits.seven_day.resets_at },
    ...(limits.model_scoped || []).map((limit) => ({
      kind: 'weekly_scoped', percent: limit.utilization, resets_at: limit.resets_at,
      scope: { model: { display_name: limit.display_name } },
    })),
  ].filter(Boolean);

  const buckets = rows.flatMap((row) => {
    if (row.percent == null) return [];
    const used = Number(row.percent);
    if (!Number.isFinite(used)) return [];
    let label;
    if (row.kind === 'session') label = '5h';
    else if (row.kind === 'weekly_all') label = 'Weekly';
    else if (row.kind === 'weekly_scoped') label = row.scope?.model?.display_name || row.scope?.surface?.display_name;
    if (!label) return [];
    const resetsAt = Date.parse(row.resets_at || '');
    return [{ label, left: Math.max(0, Math.min(100, 100 - used)),
      ...(Number.isFinite(resetsAt) ? { resetsAt } : {}) }];
  });
  if (!buckets.length) throw new Error('Claude returned no plan usage limits.');
  const subscription = response.subscription_type;
  const plan = subscription ? `Claude ${subscription[0].toUpperCase()}${subscription.slice(1)}` : 'Claude subscription';
  return { plan, sections: [{ name: 'Claude Code', buckets }], note: 'Live from Claude Code' };
}

function usage() {
  return new Promise((resolve, reject) => {
    const args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
      '--model', 'haiku', '--setting-sources', '', '--strict-mcp-config'];
    const child = spawn('claude', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '';
    let errorOutput = '';
    const timer = setTimeout(() => child.kill(), 20 * 1000);
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { errorOutput += chunk; });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (signal) return reject(new Error('Claude usage request timed out.'));
      if (code !== 0) return reject(new Error(errorOutput.trim().slice(0, 500) || `Claude exited with code ${code}.`));
      for (const line of output.split('\n')) {
        let event;
        try { event = JSON.parse(line); } catch { continue; }
        if (event.type !== 'control_response' || event.response?.request_id !== 'usage') continue;
        if (event.response.subtype !== 'success') {
          return reject(new Error(event.response.error || 'Claude rejected the usage request.'));
        }
        try { return resolve(parseUsage(event.response.response)); }
        catch (error) { return reject(error); }
      }
      reject(new Error('Claude did not return usage data. Update Claude Code and try again.'));
    });
    child.stdin.end(JSON.stringify({ type: 'control_request', request_id: 'usage',
      request: { subtype: 'get_usage', skip_behaviors: true } }) + '\n');
  });
}

module.exports = { usage, parseUsage };
