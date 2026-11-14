// Every message is parsed independently by Discord. Keep a continued fence
// balanced in each piece, reserving space for the generated delimiters.
function splitMarkdown(text, limit = 1900) {
  const chunks = [], blocks = [];
  let pieces = [], nativeCount = 0, activePre = 0;
  function appendBody(value) {
    if (!fence) return;
    const block = blocks[fence.block];
    let part = pieces.at(-1);
    if (!part || part.block !== fence.block || part.pre !== activePre) {
      part = { block: fence.block, pre: activePre, part: block.parts.length, start: block.text.length, text: '' };
      pieces.push(part);
      block.parts.push(part);
    }
    part.text += value;
    block.text += value;
  }
  let chunk = '', fence = null, hasText = false;
  const closing = (current, value = chunk) => current ? `${value.endsWith('\n') ? '' : '\n'}${current.marker}` : '';
  function flush() {
    if (!hasText) return;
    chunks.push({ content: chunk + closing(fence), pieces });
    pieces = [];
    nativeCount = fence ? 1 : 0;
    activePre = 0;
    chunk = fence ? `${fence.opener}\n` : '';
    hasText = false;
  }
  for (let line of text.match(/[^\n]*\n|[^\n]+$/g) || []) {
    const marker = /^[ \t]{0,3}(`{3,})([^\r\n]*)\r?\n?$/.exec(line);
    let next = fence;
    if (marker) {
      if (fence && marker[1].length >= fence.marker.length && !marker[2].trim()) next = null;
      else if (!fence && !marker[2].includes('`')) {
        const opener = line.replace(/\r?\n$/, '');
        // An overlong fence header cannot be repeated inside a message. Leave
        // such malformed/oversized headers on the ordinary bounded text path.
        if (opener.length + marker[1].length + 3 < limit) next = { marker: marker[1], opener };
      }
    }
    if (next !== fence) {
      if (chunk.length + line.length + closing(next, chunk + line).length > limit) flush();
      if (chunk.length + line.length + closing(next, chunk + line).length <= limit) {
        chunk += line;
        hasText = true;
        if (!fence && next) {
          next.block = blocks.length;
          blocks.push({ text: '', parts: [] });
          activePre = nativeCount++;
        }
        fence = next;
        continue;
      }
    }
    while (line) {
      const room = limit - chunk.length - (fence ? fence.marker.length + 1 : 0);
      if (line.length <= room) {
        chunk += line;
        appendBody(line);
        hasText = true;
        break;
      }
      // Prefer a new message over breaking an otherwise fitting source line.
      if (hasText) {
        // A fence opener alone is not a useful empty code-block message.
        const openerOnly = fence && (chunk === fence.opener + '\n' || chunk === fence.opener + '\r\n');
        if (!openerOnly) { flush(); continue; }
      }
      let cut = room;
      const space = line.lastIndexOf(' ', room);
      if (space > room / 2) cut = space;
      // JavaScript lengths are UTF-16; never cut an emoji surrogate pair.
      if (cut > 0 && /[\uD800-\uDBFF]/.test(line[cut - 1]) && /[\uDC00-\uDFFF]/.test(line[cut])) cut--;
      if (cut > 0 && line[cut - 1] === '\r' && line[cut] === '\n') cut--;
      chunk += line.slice(0, cut);
      appendBody(line.slice(0, cut));
      hasText = true;
      line = line.slice(cut);
      flush();
    }
  }
  flush();
  return { chunks, blocks };
}

function markdownChunks(text, limit = 1900) {
  return splitMarkdown(text, limit).chunks.map(chunk => chunk.content);
}

// The marker identifies explicit pieces, not neighboring blocks guessed from DOM.
// It is a same-origin link with no request payload or external storage.
function codeCopyChunks(text, limit = 1900, replyId = require('crypto').randomBytes(8).toString('hex')) {
  const { createHash } = require('crypto');
  if (!/^[a-f0-9]{16}$/.test(replyId)) throw new Error('Invalid reply ID');
  let reserve = 0;
  for (;;) {
    const { chunks, blocks } = splitMarkdown(text, limit - reserve);
    const hashes = blocks.map(block => createHash('sha256').update(block.text).digest('hex'));
    let overhead = 0;
    const result = chunks.map(chunk => {
      const entries = chunk.pieces.filter(part => blocks[part.block].parts.length > 1).map(part => {
        const block = blocks[part.block];
        const lines = part.text.match(/\r?\n/g) || [];
        const cr = lines.flatMap((line, i) => line === '\r\n' ? [i] : []);
        // Compact common CRLF pieces; mixed newline styles retain their positions.
        let endings = !!cr.length;
        if (cr.length && cr.length !== lines.length) {
          const bits = Buffer.alloc(Math.ceil(lines.length / 8));
          for (const index of cr) bits[index >> 3] |= 1 << (index % 8);
          endings = bits.toString('base64url');
        }
        return [part.pre, part.block, part.part, block.parts.length,
          part.start, part.text.length, block.text.length, hashes[part.block], endings];
      });
      if (!entries.length) return chunk.content;
      const data = Buffer.from(JSON.stringify([replyId, entries])).toString('base64url');
      const label = entries.length === 1 ? `Code block · ${entries[0][2] + 1}/${entries[0][3]}` : 'Code blocks · full copy';
      const marker = `\n[${label}](<https://discord.com/#dme-code-v1=${data}>)`;
      overhead = Math.max(overhead, marker.length);
      return chunk.content + marker;
    });
    if (result.every(chunk => chunk.length <= limit)) return result;
    reserve = Math.max(reserve + 1, overhead);
    if (limit - reserve < 128) throw new Error('Code-copy metadata exceeds the message budget');
  }
}

function stripCodeCopyMarkers(text) {
  return text.replace(/\n\[(?:Code block · \d+\/\d+|Code blocks · full copy)\]\(<https:\/\/discord\.com\/#dme-code-v1=[A-Za-z0-9_-]+>\)(?=\n|$)/g, '');
}

module.exports = { markdownChunks, codeCopyChunks, stripCodeCopyMarkers };
