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

function availablePeers(peers) {
  return peers.filter((peer) => /^\d+$/.test(String(peer.id || '')));
}

function debatePeerInstructions(peers) {
  const available = availablePeers(peers);
  if (!available.length) return '';
  return `Agents available for the next debate turn:\n${available.map((peer) =>
    `- ${peer.displayName || peer.name || peer.username}: <@${peer.id}>`).join('\n')}\n` +
    'To invite another turn, address one of these agents with its exact <@ID> mention. ' +
    'Do not invent an agent or use a plain @name. Only the listed agents can receive a handoff.';
}

function resolveDebateHandoff(text, peers, { recoverInvalidHandoff = false } = {}) {
  const available = availablePeers(peers);
  const resolved = resolvePeerMentions(text, available);
  if (!recoverInvalidHandoff || !available.length) return resolved;

  // A bot may address a made-up agent at the start of its closing paragraph.
  // Replace only that attempted handoff; ordinary @names elsewhere remain text.
  const closing = resolved.match(/(?:^|\n\s*\n)(\s*)@([^\s,，:：]+)(?=\s*(?:[,，:：]|$))/gu);
  if (!closing?.length) return resolved;
  const last = closing[closing.length - 1];
  const target = last.match(/@([^\s,，:：]+)/u)?.[1];
  if (!target || /^(everyone|here)$/i.test(target)) return resolved;
  const at = resolved.lastIndexOf(last);
  const mentionAt = at + last.lastIndexOf('@');
  const next = available.find((peer) => !resolved.includes(`<@${peer.id}>`)) || available[0];
  return `${resolved.slice(0, mentionAt)}<@${next.id}>${resolved.slice(mentionAt + target.length + 1)}`;
}

module.exports = { resolvePeerMentions, debatePeerInstructions, resolveDebateHandoff };
