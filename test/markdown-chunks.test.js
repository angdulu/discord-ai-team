const test = require('node:test');
const assert = require('node:assert/strict');
const { markdownChunks } = require('../src/markdown-chunks');

const bounded = (chunks, limit = 1900) => {
  assert.ok(chunks.every(chunk => chunk.length > 0 && chunk.length <= limit));
  for (const chunk of chunks) {
    assert.doesNotMatch(chunk, /^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/);
  }
};

test('short Markdown and multiple complete blocks remain byte-for-byte unchanged', () => {
  for (const text of ['plain', '# Heading\n\n- item\n', '```js\nx();\n```\nNote\n```text\nanswer\n```']) {
    assert.deepEqual(markdownChunks(text), [text]);
  }
  assert.deepEqual(markdownChunks(''), []);
});

test('continued language fences close and reopen within the message limit', () => {
  const lines = Array.from({ length: 12 }, (_, i) => `const value${i} = ${i};\n`);
  const chunks = markdownChunks('```js\n' + lines.join('') + '```\nA following note.', 70);
  bounded(chunks, 70);
  assert.ok(chunks.length > 2);
  assert.ok(chunks[0].startsWith('```js\n'));
  assert.ok(chunks[0].endsWith('\n```'));
  assert.ok(chunks.slice(1, -1).every(chunk => chunk.startsWith('```js\n') && chunk.trimEnd().endsWith('\n```')));
  assert.ok(chunks.at(-1).endsWith('A following note.'));
  for (const line of lines) assert.equal(chunks.join('').split(line).length - 1, 1);
});

test('bare fences, CRLF, four-backtick examples and multiple languages survive splitting', () => {
  for (const marker of ['```', '````']) {
    const body = 'keep this line\r\n'.repeat(40) + (marker.length === 4 ? '```js\r\nliteral nested example\r\n```\r\n' : '');
    const chunks = markdownChunks(marker + '\r\n' + body + marker + '\r\nAfter.', 130);
    bounded(chunks, 130);
    assert.ok(chunks[0].endsWith('\n' + marker));
    assert.ok(chunks[1].startsWith(marker + '\n'));
    assert.ok(chunks.at(-1).endsWith('After.'));
  }
});

test('plain prose retains every newline, space and emoji across splits', () => {
  const text = ('  한글🙂 words\n\n\n').repeat(400) + 'last';
  const chunks = markdownChunks(text);
  bounded(chunks);
  assert.equal(chunks.join(''), text);
  const longLine = '🙂'.repeat(3000);
  const hard = markdownChunks(longLine, 61);
  bounded(hard, 61);
  assert.equal(hard.join(''), longLine);
});

test('a long code line is bounded without splitting an emoji', () => {
  const text = '```text\n' + '🙂'.repeat(3000) + '\n```';
  const chunks = markdownChunks(text, 100);
  bounded(chunks, 100);
  assert.ok(chunks.every(chunk => chunk.startsWith('```text\n') && chunk.endsWith('\n```')));
  assert.equal(chunks.map(chunk => chunk.slice(8, -4).replace(/\n$/, '')).join(''), '🙂'.repeat(3000));
});

test('inline/escaped backticks and other languages inside a fence do not change its state', () => {
  const plain = ('Example `code` and \\```js inline\n').repeat(100);
  assert.equal(markdownChunks(plain).join(''), plain);
  const body = 'literal ```js\n```python\n'.repeat(50);
  const chunks = markdownChunks('```text\n' + body + '```');
  bounded(chunks);
  assert.ok(chunks.slice(0, -1).every(chunk => chunk.endsWith('\n```')));
  assert.equal(chunks.join('').split('```python').length - 1, 50);
});

test('open streaming fences are closed while the original body is preserved', () => {
  assert.deepEqual(markdownChunks('```js\nx();'), ['```js\nx();\n```']);
  assert.deepEqual(markdownChunks('```\n'), ['```\n```']);
});

test('oversized language headers still produce bounded messages', () => {
  const text = '```' + 'x'.repeat(4000) + '\nbody';
  bounded(markdownChunks(text));
});
