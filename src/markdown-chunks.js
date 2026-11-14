// Every message is parsed independently by Discord. Keep a continued fence
// balanced in each piece, reserving space for the generated delimiters.
function markdownChunks(text, limit = 1900) {
  const chunks = [];
  let chunk = '', fence = null, hasText = false;
  const closing = (current, value = chunk) => current ? `${value.endsWith('\n') ? '' : '\n'}${current.marker}` : '';
  function flush() {
    if (!hasText) return;
    chunks.push(chunk + closing(fence));
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
        fence = next;
        continue;
      }
    }
    while (line) {
      const room = limit - chunk.length - (fence ? fence.marker.length + 1 : 0);
      if (line.length <= room) {
        chunk += line;
        hasText = true;
        break;
      }
      // Prefer a new message over breaking an otherwise fitting source line.
      if (hasText) { flush(); continue; }
      let cut = room;
      const space = line.lastIndexOf(' ', room);
      if (space > room / 2) cut = space;
      // JavaScript lengths are UTF-16; never cut an emoji surrogate pair.
      if (cut > 0 && /[\uD800-\uDBFF]/.test(line[cut - 1]) && /[\uDC00-\uDFFF]/.test(line[cut])) cut--;
      chunk += line.slice(0, cut);
      hasText = true;
      line = line.slice(cut);
      flush();
    }
  }
  flush();
  return chunks;
}

module.exports = { markdownChunks };
