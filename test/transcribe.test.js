const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { audioAttachments } = require('../src/attachments');
const { transcribeAudio, DEFAULT_MODEL } = require('../src/transcribe');

const OGG = Buffer.from('OggS fake voice bytes');
const url = 'https://cdn.discordapp.com/attachments/123/456/voice-message.ogg';
const fetchFn = async () => new Response(OGG, { status: 200 });

test('detects voice messages and audio files but not other attachments', () => {
  const message = { attachments: new Map([
    ['voice', { name: 'voice-message.ogg', contentType: 'audio/ogg', flags: 8192, url }],
    ['flagOnly', { name: 'blob', contentType: '', flags: { has: (bit) => bit === 8192 }, url }],
    ['mp3', { name: 'memo.mp3', contentType: null, url }],
    ['image', { name: 'photo.png', contentType: 'image/png', url }],
    ['video', { name: 'clip.webm', contentType: 'video/webm', url }],
  ]) };
  assert.deepEqual(audioAttachments(message).map((a) => a.name), ['voice-message.ogg', 'blob', 'memo.mp3']);
});

test('transcribes with a one-off agy call on the cheap model and cleans up', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'discord-audio-test-'));
  let call;
  const execFn = (cmd, args, opts, cb) => {
    const file = args[args.length - 1].split('\n').pop().replace(/^1\. /, '');
    call = { cmd, args, opts, file };
    fs.readFile(file).then((bytes) => {
      call.bytes = bytes;
      cb(null, '  1. 안녕하세요 테스트입니다  \n', '');
    });
  };
  try {
    const text = await transcribeAudio([{ name: 'voice-message.ogg', size: OGG.length, url }],
      { directory: root, fetchFn, execFn, model: DEFAULT_MODEL });
    assert.equal(text, '안녕하세요 테스트입니다');
    assert.equal(call.cmd, 'agy');
    assert.ok(call.args.includes('--model') && call.args.includes('gemini-3.8-flash-medium'));
    assert.equal(call.args[call.args.indexOf('--add-dir') + 1], path.dirname(call.file));
    assert.ok(!call.args.includes('--conversation'), 'must not join a chat session');
    assert.equal(path.extname(call.file), '.ogg');
    assert.deepEqual(call.bytes, OGG);
    assert.deepEqual(await fs.readdir(root), [], 'temp audio removed');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('reports CLI failures and refuses too many files', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'discord-audio-test-'));
  const audio = { name: 'a.ogg', size: OGG.length, url };
  try {
    const denied = (cmd, args, opts, cb) => cb(null, 'jetski: no output produced — a tool required the "command" permission', '');
    await assert.rejects(transcribeAudio([audio], { directory: root, fetchFn, execFn: denied }), /Voice transcription failed: jetski/);
    const missing = (cmd, args, opts, cb) => cb(Object.assign(new Error('spawn agy ENOENT'), { code: 'ENOENT' }), '', '');
    await assert.rejects(transcribeAudio([audio], { directory: root, fetchFn, execFn: missing }), /agy\) is not installed/);
    await assert.rejects(transcribeAudio([audio, audio, audio], { directory: root, fetchFn, execFn: denied }), /at most 2/);
    assert.deepEqual(await fs.readdir(root), []);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
