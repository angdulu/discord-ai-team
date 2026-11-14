const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { codeCopyChunks, stripCodeCopyMarkers } = require('../src/markdown-chunks');
const marker = /\n\[([^\]]+)\]\(<https:\/\/discord\.com\/#dme-code-v1=([A-Za-z0-9_-]+)>\)$/;
function metadata(chunk) {
  const match = marker.exec(chunk);
  return match ? JSON.parse(Buffer.from(match[2], 'base64url')) : null;
}
test('short replies and complete independent code blocks receive no markers', () => {
  for (const text of ['plain', '\`\`\`js\nx();\n\`\`\`', '\`\`\`text\none\n\`\`\`\n\`\`\`text\ntwo\n\`\`\`']) {
    assert.deepEqual(codeCopyChunks(text), [text]);
  }
});
test('split markers encode original source offsets, group hashes and message-local code indices', () => {
  const first = 'alpha🙂\r\n'.repeat(220), second = 'beta\n'.repeat(400);
  const chunks = codeCopyChunks('Intro\n\`\`\`text\n' + first + '\`\`\`\nNote\n\`\`\`js\n' + second + '\`\`\`\nAfter', 1900, '0123456789abcdef');
  const grouped = [[], []];
  for (const chunk of chunks) {
    assert.ok(chunk.length <= 1900);
    const data = metadata(chunk); assert.ok(data);
    assert.equal(data[0], '0123456789abcdef');
    const content = chunk.replace(marker, '');
    // These fixtures contain no nested fences; inspect each native block independently.
    const codes = [...content.matchAll(/^\`\`\`(?:text|js)\n([\s\S]*?)^\`\`\`/gm)];
    for (const row of data[1]) {
      const [pre, block, part, count, start, length, total, hash, endings] = row;
      const body = [first, second][block];
      assert.equal(total, body.length);
      assert.equal(hash, createHash('sha256').update(body).digest('hex'));
      assert.equal(codes[pre][1], body.slice(start, start + length));
      assert.ok(count > 1 && part < count);
      assert.ok(typeof endings === 'boolean' || typeof endings === 'string');
      grouped[block].push({ part, start, text: codes[pre][1], count });
    }
  }
  grouped.forEach((parts, block) => {
    parts.sort((a, b) => a.part - b.part);
    assert.equal(parts.length, parts[0].count);
    assert.equal(parts.map(part => part.text).join(''), [first, second][block]);
  });
});
test('very long lines, blank lines, four-backtick nested examples and Unicode stay bounded', () => {
  for (const body of ['🙂'.repeat(3500), '\r\n'.repeat(4000), 'a\r\nb\nc\r\n'.repeat(600), '# Heading\n'.repeat(1000)]) {
    const chunks = codeCopyChunks('\`\`\`\`text\n' + body + '\n\`\`\`js\nliteral\n\`\`\`\n\`\`\`\`');
    assert.ok(chunks.length > 1);
    assert.ok(chunks.every(chunk => chunk.length <= 1900 && metadata(chunk)));
  }
});
test('separate replies get separate identities', () => {
  const input = '\`\`\`text\n' + 'line\n'.repeat(500) + '\`\`\`';
  assert.notEqual(metadata(codeCopyChunks(input)[0])[0], metadata(codeCopyChunks(input)[0])[0]);
});

test('model context strips copy markers while retaining ordinary links and code', () => {
  const chunks = codeCopyChunks('\`\`\`text\n' + 'line\n'.repeat(500) + '\`\`\`');
  assert.ok(chunks.every(chunk => !stripCodeCopyMarkers(chunk).includes('#dme-code-v1=')));
  assert.equal(stripCodeCopyMarkers('[reference](https://example.com/)'), '[reference](https://example.com/)');
});
