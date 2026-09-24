const fs = require('fs');
const os = require('os');
const path = require('path');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const READ_BYTES = 2 * 1024 * 1024;

function loadHistory(file) {
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
  } catch {
    return {};
  }
}

function cleanTitle(value) {
  return String(value || '').replace(/<@!?\d+>/g, '@bot').replace(/<@&\d+>/g, '@role')
    .replace(/[\x00-\x1f\x7f\ufffd]/gi, ' ').replace(/\s+/g, ' ').trim().slice(0, 90);
}

function rememberSession(file, entry) {
  if (!UUID.test(entry.id)) return;
  const history = loadHistory(file);
  const previous = history[entry.id] || {};
  history[entry.id] = {
    id: entry.id,
    ownerId: previous.ownerId || entry.ownerId || null,
    channelId: entry.channelId || previous.channelId || null,
    channelName: entry.channelName || previous.channelName || '',
    title: previous.title && !['Previous conversation', 'Current conversation'].includes(previous.title)
      ? previous.title : cleanTitle(entry.title) || previous.title || 'Previous conversation',
    updatedAt: entry.updatedAt || Date.now(),
  };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(history, null, 2), { mode: 0o600 });
}

function walkFiles(root, extension) {
  const files = [];
  function walk(directory) {
    let items;
    try { items = fs.readdirSync(directory, { withFileTypes: true }); } catch { return; }
    for (const item of items) {
      const file = path.join(directory, item.name);
      if (item.isDirectory()) walk(file);
      else if (item.isFile() && item.name.endsWith(extension)) files.push(file);
    }
  }
  walk(root);
  return files.map((file) => {
    try { return { file, modified: fs.statSync(file).mtimeMs }; } catch { return null; }
  }).filter(Boolean).sort((a, b) => b.modified - a.modified).slice(0, 300).map((item) => item.file);
}

function firstBytes(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const bytes = Buffer.alloc(READ_BYTES);
    const length = fs.readSync(fd, bytes, 0, bytes.length, 0);
    return bytes.subarray(0, length);
  } finally {
    fs.closeSync(fd);
  }
}

function requestTitle(prompt) {
  const request = prompt.match(/Request from [^:\n]+:\s*([^\n]+)/);
  return cleanTitle(request && request[1]) || 'Previous Discord conversation';
}

function jsonlBotPrompt(bytes, providerId, name) {
  for (const line of bytes.toString('utf8').split('\n')) {
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    let prompt = '';
    if (providerId === 'claude' && event.type === 'user') {
      const content = event.message && event.message.content;
      prompt = typeof content === 'string' ? content : '';
    } else if (providerId === 'codex' && event.type === 'response_item' && event.payload?.role === 'user') {
      prompt = (event.payload.content || []).map((part) => part.text || '').join(' ');
    }
    if (prompt.startsWith(`You are ${name}`) && prompt.includes('an AI agent answering in Discord')) return prompt;
  }
  return '';
}

function geminiSummaries(home) {
  const file = path.join(home, '.gemini', 'antigravity-cli', 'cache', 'conversation_metadata.json');
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Object.assign({}, ...Object.values(data).filter((value) => value && typeof value === 'object'));
  } catch {
    return {};
  }
}

function discoverBotSessions(providerId, name, { home = os.homedir() } = {}) {
  const roots = {
    codex: [path.join(home, '.codex', 'sessions'), '.jsonl'],
    claude: [path.join(home, '.claude', 'projects'), '.jsonl'],
    gemini: [path.join(home, '.gemini', 'antigravity-cli', 'conversations'), '.db'],
  };
  if (!roots[providerId]) return { entries: [], validIds: new Set() };
  const [root, extension] = roots[providerId];
  const summaries = providerId === 'gemini' ? geminiSummaries(home) : {};
  const entries = [];
  const validIds = new Set();
  for (const file of walkFiles(root, extension)) {
    let bytes;
    try { bytes = firstBytes(file); } catch { continue; }
    let id = path.basename(file, extension);
    if (providerId === 'codex') {
      try {
        const first = JSON.parse(bytes.toString('utf8').split('\n')[0]);
        id = first.payload?.id || first.payload?.session_id || id;
      } catch { continue; }
    }
    if (!UUID.test(id)) continue;
    validIds.add(id);
    let title = '';
    if (providerId === 'gemini') {
      const start = bytes.indexOf(Buffer.from(`You are ${name}`));
      const marker = bytes.indexOf(Buffer.from('an AI agent answering in Discord'), start);
      const request = bytes.indexOf(Buffer.from('Request from '), start);
      if (start >= 0 && marker > start && marker - start < 500 && request > marker && request - start < 3000) {
        title = cleanTitle(summaries[id]?.summary) || requestTitle(bytes.subarray(request, request + 300).toString('utf8'));
      }
    } else {
      const prompt = jsonlBotPrompt(bytes, providerId, name);
      if (prompt) title = requestTitle(prompt);
    }
    if (title) entries.push({ id, title, updatedAt: fs.statSync(file).mtimeMs, channelId: null, channelName: '' });
  }
  return { entries, validIds };
}

function listResumableSessions({ file, sessions, providerId, name, userId, allowedUserIds, home }) {
  const { entries: discovered, validIds } = discoverBotSessions(providerId, name, { home });
  const soleOwner = allowedUserIds.length === 1 && allowedUserIds[0] === userId;
  const history = loadHistory(file);
  const byId = new Map();
  if (soleOwner) for (const entry of discovered) byId.set(entry.id, entry);
  for (const entry of Object.values(history)) {
    if (!validIds.has(entry.id) || (entry.ownerId !== userId && !(soleOwner && !entry.ownerId))) continue;
    byId.set(entry.id, { ...byId.get(entry.id), ...entry });
  }
  if (soleOwner) for (const [channelId, id] of Object.entries(sessions)) {
    if (!validIds.has(id) || byId.has(id)) continue;
    byId.set(id, { id, title: 'Current conversation', channelId, channelName: '', updatedAt: 0 });
  }
  return [...byId.values()].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

function assignSession(sessions, channelId, sessionId) {
  for (const [otherChannel, currentId] of Object.entries(sessions)) {
    if (otherChannel !== channelId && currentId === sessionId) delete sessions[otherChannel];
  }
  sessions[channelId] = sessionId;
}

module.exports = { loadHistory, rememberSession, discoverBotSessions, listResumableSessions, assignSession, cleanTitle };
