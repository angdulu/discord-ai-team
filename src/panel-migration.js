const { Routes } = require('discord.js');
const { panelView } = require('./task-ui');

function isControlPanel(message, botId) {
  if (message.author?.id !== botId || !/^\*\*[^\n]+ controls\*\*\n(?:Open settings, change models, or manage tasks here\.|Manage this agent and conversations here\.)/.test(message.content || '')) return false;
  const ids = new Set((message.components || []).flatMap((row) => (row.components || []).map((component) => component.custom_id)));
  return ['control:settings', 'control:model', 'control:usage', 'control:new'].every((id) => ids.has(id));
}

async function refreshControlPanels({ rest, botId, channelIds, name }) {
  let updated = 0;
  let inaccessible = 0;
  for (const channelId of new Set(channelIds)) {
    const messages = new Map();
    try {
      let before;
      do {
        const query = new URLSearchParams({ limit: '50', ...(before ? { before } : {}) });
        const pins = await rest.get(`/channels/${channelId}/messages/pins`, { query });
        for (const item of pins.items) if (item.message) messages.set(item.message.id, item.message);
        const next = pins.has_more && pins.items.at(-1)?.pinned_at;
        if (!next || next === before) break;
        before = next;
      } while (true);
      const recent = await rest.get(Routes.channelMessages(channelId), { query: new URLSearchParams({ limit: '100' }) });
      for (const message of recent) messages.set(message.id, message);
    } catch (error) {
      if ([10003, 50001, 50013].includes(error.code)) { inaccessible++; continue; }
      throw error;
    }
    for (const message of messages.values()) {
      if (!isControlPanel(message, botId)) continue;
      const view = panelView(name);
      await rest.patch(Routes.channelMessage(channelId, message.id), { body: {
        content: view.content, components: view.components.map((row) => row.toJSON()), allowed_mentions: { parse: [] },
      } });
      updated++;
    }
  }
  return { updated, inaccessible };
}

module.exports = { isControlPanel, refreshControlPanels };
