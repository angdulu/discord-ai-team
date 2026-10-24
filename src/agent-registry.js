const path = require('path');
const { updateSettings } = require('./agent-settings');

const REGISTRY_FILE = path.join(__dirname, '..', 'state', 'agents.json');

// Reuse the settings writer's lock and atomic rename: separate bot processes
// must merge their entries without truncating the file or losing a peer.
function createAgentRegistration({ key, getAgent, file = REGISTRY_FILE,
  intervalMs = 30000, onError = console.error }) {
  let pending;
  let closed = false;
  function refresh() {
    if (closed) return Promise.resolve();
    if (!pending) {
      pending = updateSettings((registry) => {
        registry[key] = getAgent();
      }, file).finally(() => { pending = null; });
    }
    return pending;
  }
  const timer = setInterval(() => { refresh().catch(onError); }, intervalMs);
  timer.unref();
  return { refresh, close() { closed = true; clearInterval(timer); } };
}

module.exports = { REGISTRY_FILE, createAgentRegistration };
