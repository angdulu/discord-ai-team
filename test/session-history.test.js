const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { discoverBotSessions, rememberSession, listResumableSessions, assignSession } = require('../src/session-history');
const { resumePanel } = require('../src/runner');

const claudeId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const otherId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

test('discovers only actual Discord bot conversations and keeps old ones after reset', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-test-'));
  try {
    const directory = path.join(home, '.claude', 'projects', 'project');
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, `${claudeId}.jsonl`), JSON.stringify({
      type: 'user', message: { content: 'You are Claire, an AI agent answering in Discord.\nRequest from owner:\nReview the draft' },
    }) + '\n');
    fs.writeFileSync(path.join(directory, `${otherId}.jsonl`), JSON.stringify({
      type: 'user', message: { content: 'A private CLI conversation' },
    }) + '\n');
    const found = discoverBotSessions('claude', 'Claire', { home });
    assert.deepEqual(found.entries.map((entry) => entry.id), [claudeId]);
    const historyFile = path.join(home, 'state', 'claire.history.json');
    rememberSession(historyFile, { id: claudeId, ownerId: 'owner', channelId: 'channel', title: 'Review the draft' });
    const entries = listResumableSessions({
      file: historyFile, sessions: {}, providerId: 'claude', name: 'Claire',
      userId: 'owner', allowedUserIds: ['owner'], home,
    });
    assert.deepEqual(entries.map((entry) => entry.id), [claudeId]);
    assert.deepEqual(listResumableSessions({
      file: historyFile, sessions: {}, providerId: 'claude', name: 'Claire',
      userId: 'someone-else', allowedUserIds: ['owner'], home,
    }), []);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('resume menu shows selectable real session IDs and paginates', () => {
  const entries = Array.from({ length: 26 }, (_, i) => ({
    id: `${String(i).padStart(8, '0')}-aaaa-4aaa-8aaa-aaaaaaaaaaaa`,
    title: `Conversation ${i}`, updatedAt: 0,
  }));
  const first = resumePanel('claire', 'Claire', 'channel', 'owner', entries, null, 0);
  assert.match(first.content, /Select a previous Discord bot conversation/);
  assert.equal(first.components[0].components[0].options.length, 25);
  assert.equal(first.components[0].components[0].data.placeholder, 'Select a conversation to resume');
  assert.equal(first.components[0].components[0].options[0].data.value, entries[0].id);
  assert.equal(first.components.length, 2);
  assert.equal(first.components[1].components[1].data.label, 'Next');
  const second = resumePanel('claire', 'Claire', 'channel', 'owner', entries, null, 1);
  assert.equal(second.components[0].components[0].options.length, 1);
  assert.match(resumePanel('claire', 'Claire', 'channel', 'owner', [], null).content, /No previous Discord bot conversations/);
});

test('resuming a conversation moves its channel binding', () => {
  const sessions = { old: claudeId, current: otherId };
  assignSession(sessions, 'current', claudeId);
  assert.deepEqual(sessions, { current: claudeId });
});

test('Codex and Gemini histories include only their Discord bot sessions', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-providers-test-'));
  try {
    const codexDir = path.join(home, '.codex', 'sessions', '2026', '09', '24');
    fs.mkdirSync(codexDir, { recursive: true });
    fs.writeFileSync(path.join(codexDir, 'rollout.jsonl'), [
      { type: 'session_meta', payload: { id: claudeId } },
      { type: 'response_item', payload: { role: 'user', content: [{ type: 'input_text', text: 'You are Cody, an AI agent answering in Discord.\nRequest from owner:\nSummarize this' }] } },
    ].map((item) => JSON.stringify(item)).join('\n'));
    const geminiDir = path.join(home, '.gemini', 'antigravity-cli', 'conversations');
    fs.mkdirSync(geminiDir, { recursive: true });
    fs.writeFileSync(path.join(geminiDir, `${otherId}.db`), 'You are Minnie, an AI agent answering in Discord.\nRequest from owner:\nCheck the image');
    assert.deepEqual(discoverBotSessions('codex', 'Cody', { home }).entries.map((entry) => entry.title), ['Summarize this']);
    assert.deepEqual(discoverBotSessions('gemini', 'Minnie', { home }).entries.map((entry) => entry.title), ['Check the image']);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
