const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');

const DEFAULT_DIR = path.join(__dirname, '..', 'state', 'team-stop');

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
  if (!/^\d+$/.test(channelId)) throw new Error('Invalid channel ID');
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const marker = { id: randomUUID(), at: Date.now() };
  const temporary = path.join(directory, `${channelId}.${marker.id}.tmp`);
  fs.writeFileSync(temporary, JSON.stringify(marker), { mode: 0o600 });
  fs.renameSync(temporary, path.join(directory, `${channelId}.json`));
  return marker.id;
}

function watchStops(onStop, { directory = DEFAULT_DIR, intervalMs = 500 } = {}) {
  const seen = Object.fromEntries(Object.entries(stopMarkers(directory)).map(([channelId, marker]) => [channelId, marker.id]));
  const refresh = () => {
    for (const [channelId, marker] of Object.entries(stopMarkers(directory))) {
      if (seen[channelId] !== marker.id) {
        seen[channelId] = marker.id;
        onStop(channelId, marker.at);
      }
    }
  };
  const timer = setInterval(refresh, intervalMs);
  timer.unref();
  return { refresh, close: () => clearInterval(timer) };
}

module.exports = { publishStop, watchStops, stopMarkers };
