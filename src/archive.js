const fs = require('fs/promises');
const path = require('path');

// Opt-in conversation archive: one JSON line per answered turn (the request and the
// final reply only, no tool output), appended to <ARCHIVE_DIR>/YYYY-MM.jsonl (UTC month).
// Unset ARCHIVE_DIR = disabled. Failures are logged and never break a turn.

function archiveFile(dir, date = new Date()) {
  return path.join(dir, `${date.toISOString().slice(0, 7)}.jsonl`);
}

async function archiveTurn(entry, { dir = process.env.ARCHIVE_DIR, now = new Date() } = {}) {
  if (!dir || !String(dir).trim()) return false;
  const record = { ts: now.toISOString(), ...entry };
  try {
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    await fs.appendFile(archiveFile(dir, now), `${JSON.stringify(record)}\n`, { mode: 0o600 });
    return true;
  } catch (error) {
    console.error('[archive] write failed:', error.message);
    return false;
  }
}

module.exports = { archiveTurn, archiveFile };
