const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { imageAttachments, imagesForTurn, saveImageAttachments } = require('../src/attachments');

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/gAAAAABJRU5ErkJggg==',
  'base64',
);
const url = 'https://cdn.discordapp.com/attachments/123/456/test.png';

test('selects image attachments and saves them only until cleanup', async () => {
  const message = { attachments: new Map([
    ['image', { name: 'photo.png', contentType: 'image/png', size: PNG.length, url }],
    ['other', { name: 'notes.pdf', contentType: 'application/pdf', size: 10, url }],
  ]) };
  const attachments = imageAttachments(message);
  assert.equal(attachments.length, 1);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'discord-images-test-'));
  try {
    const saved = await saveImageAttachments(attachments, {
      directory: root,
      fetchFn: async () => new Response(PNG, { status: 200 }),
    });
    assert.equal(saved.paths.length, 1);
    assert.deepEqual(await fs.readFile(saved.paths[0]), PNG);
    assert.equal((await fs.stat(saved.paths[0])).mode & 0o777, 0o600);
    await saved.cleanup();
    await assert.rejects(fs.stat(saved.paths[0]), { code: 'ENOENT' });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('rejects oversized and non-Discord image URLs', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'discord-images-test-'));
  const fetchFn = async () => new Response(PNG, { status: 200 });
  try {
    await assert.rejects(
      saveImageAttachments([{ size: 21 * 1024 * 1024, url }], { directory: root, fetchFn }),
      /larger than 20 MB/,
    );
    await assert.rejects(
      saveImageAttachments([{ size: PNG.length, url: 'https://example.com/image.png' }], { directory: root, fetchFn }),
      /not a Discord attachment/,
    );
    assert.deepEqual(await fs.readdir(root), []);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('debate peers receive images from the latest authorized human request', async () => {
  const image = { name: 'photo.png', contentType: 'image/png', size: PNG.length, url };
  const human = { author: { bot: false, id: 'owner' }, attachments: new Map([['image', image]]) };
  const history = new Map([['bot', { author: { bot: true } }], ['human', human]]);
  const message = {
    author: { bot: true }, guild: {}, id: 'reply', attachments: new Map(),
    channel: { messages: { fetch: async () => history } },
  };
  assert.deepEqual(await imagesForTurn(message, (id) => id === 'owner'), [image]);
  assert.deepEqual(await imagesForTurn(message, () => false), []);
});
