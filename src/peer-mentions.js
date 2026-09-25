function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Convert names the model can read into Discord mentions only for eligible debate peers.
function resolvePeerMentions(text, peers) {
  const aliases = new Map();
  for (const peer of peers) {
    if (!/^\d+$/.test(String(peer.id || ''))) continue;
    for (const value of [peer.name, peer.displayName, peer.username]) {
      const alias = String(value || '').trim().replace(/^@/, '');
      if (!alias) continue;
      const key = alias.toLocaleLowerCase();
      if (aliases.has(key) && aliases.get(key) !== peer.id) aliases.set(key, null);
      else if (!aliases.has(key)) aliases.set(key, peer.id);
    }
  }
  const names = [...aliases].filter(([, id]) => id).map(([name]) => name);
  if (!names.length) return text;
  const pattern = new RegExp(`(^|[^\\p{L}\\p{N}_@])@(${names.sort((a, b) => b.length - a.length).map(escapeRegex).join('|')})(?![\\p{L}\\p{N}_-])`, 'giu');
  // Code and URLs can describe an @name without calling that agent.
  return text.split(/(```[\s\S]*?(?:```|$)|`[^`\n]*`|https?:\/\/[^\s<>]+)/g)
    .map((part) => part.startsWith('`') || /^https?:\/\//.test(part) ? part : part.replace(pattern, (match, prefix, alias) =>
      `${prefix}<@${aliases.get(alias.toLocaleLowerCase())}>`))
    .join('');
}

module.exports = { resolvePeerMentions };
