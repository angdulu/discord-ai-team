#!/usr/bin/env node
// Isolated provider invocation: each process loads only its own bot environment.
const fs = require('fs');
const path = require('path');
async function main() {
  const input = JSON.parse(fs.readFileSync(0, 'utf8'));
  if (!/^[a-z0-9_-]+$/.test(input.bot)) throw new Error('Invalid bot key');
  const env = require('dotenv').config({ path: path.join(__dirname, '..', 'bots', input.bot + '.env'), override: true });
  if (env.error) throw new Error('Bot environment missing');
  const providerId = ({ claude: 'claude', codex: 'codex', chatgpt: 'codex', gemini: 'gemini' })[process.env.PROVIDER];
  if (!providerId) throw new Error('Unsupported provider');
  const provider = require('../src/providers/' + providerId)({
    workdir: input.root, permission: input.permission || 'read-only', getIdleTimeoutMs: () => 0,
  });
  if (input.action === 'inspect') {
    const [catalog, quota] = await Promise.allSettled([provider.getModels(), provider.usage()]);
    const models = catalog.status === 'fulfilled' ? catalog.value.flatMap(m =>
      (m.efforts?.length ? m.efforts : [null]).map(e => ({ id: m.id(e), label: m.label, effort: e }))) : [];
    return { bot: input.bot, provider: providerId, models,
      usage: quota.status === 'fulfilled' ? quota.value : null,
      modelError: catalog.status === 'rejected' ? String(catalog.reason.message) : null,
      usageError: quota.status === 'rejected' ? String(quota.reason.message) : null };
  }
  if (input.action !== 'run') throw new Error('Unknown action');
  return provider.run(input.prompt, null, input.model, new AbortController().signal);
}
main().then(result => { process.stdout.write('\nNEXUS_RESULT=' + JSON.stringify(result) + '\n'); process.exit(0); },
  error => { console.error(error.message); process.exit(1); });
