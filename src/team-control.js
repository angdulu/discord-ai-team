const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');

const DEFAULT_DIR = path.join(__dirname, '..', 'state', 'team-stop');

// Serialize the final limit check and posting across bot processes.
async function withChannelTurnLock(channelId, run, directory = DEFAULT_DIR) {
  if (!/^\d+$/.test(channelId)) throw new Error('Invalid channel ID');
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const lock = path.join(directory, `${channelId}.turn-lock`);
  let fd;
  const deadline = Date.now() + 30000;
  while (fd === undefined) {
    try {
      fd = fs.openSync(lock, 'wx', 0o600);
      fs.writeFileSync(fd, String(process.pid));
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      try {
        const pid = Number(fs.readFileSync(lock, 'utf8'));
        if (pid > 0) {
          try { process.kill(pid, 0); }
          catch (error) { if (error.code === 'ESRCH') fs.unlinkSync(lock); }
        } else if (Date.now() - fs.statSync(lock).mtimeMs > 30000) fs.unlinkSync(lock);
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (Date.now() >= deadline) throw new Error('Channel reply lock timed out');
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  try { return await run(); }
  finally { fs.closeSync(fd); fs.unlinkSync(lock); }
}

function stopMarkers(directory = DEFAULT_DIR) {
  let files;
  try { files = fs.readdirSync(directory); } catch { return {}; }
  const markers = {};
  for (const file of files) {
    if (!/^\d+\.json$/.test(file)) continue;
    try {
      const value = JSON.parse(fs.readFileSync(path.join(directory, file), 'utf8'));
      if (typeof value.id === 'string') markers[file.slice(0, -5)] = value;
    } catch { /* A partial or removed marker can be ignored. */ }
  }
  return markers;
}

function publishStop(channelId, directory = DEFAULT_DIR) {
  return publishChannelAction(channelId, { action: 'stop' }, directory);
}

function publishNewConversation(channelId, { ownerId, channelName }, directory = DEFAULT_DIR) {
  return publishChannelAction(channelId, { action: 'new', ownerId, channelName }, directory);
}

function publishChannelAction(channelId, details, directory) {
  if (!/^\d+$/.test(channelId)) throw new Error('Invalid channel ID');
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const marker = { ...details, id: randomUUID(), at: Date.now() };
  if (details.action === 'stop') {
    const previous = stopMarkers(directory)[channelId];
    const reset = previous?.action === 'new' ? previous : previous?.reset;
    if (reset) marker.reset = reset;
  }
  const temporary = path.join(directory, `${channelId}.${marker.id}.tmp`);
  fs.writeFileSync(temporary, JSON.stringify(marker), { mode: 0o600 });
  fs.renameSync(temporary, path.join(directory, `${channelId}.json`));
  return marker.id;
}

function watchStops(onStop, { directory = DEFAULT_DIR, intervalMs = 500, onNewConversation } = {}) {
  const seen = Object.fromEntries(Object.entries(stopMarkers(directory))
    .filter(([, marker]) => marker.action !== 'new' && !marker.reset).map(([channelId, marker]) => [channelId, marker.id]));
  const refresh = () => {
    for (const [channelId, marker] of Object.entries(stopMarkers(directory))) {
      if (seen[channelId] !== marker.id) {
        if (marker.action === 'new') onNewConversation?.(channelId, marker);
        else {
          if (marker.reset) onNewConversation?.(channelId, marker.reset);
          onStop(channelId, marker.at);
        }
        seen[channelId] = marker.id;
      }
    }
  };
  const timer = setInterval(refresh, intervalMs);
  timer.unref();
  return { refresh, close: () => clearInterval(timer) };
}

module.exports = { publishStop, publishNewConversation, watchStops, stopMarkers, withChannelTurnLock };
