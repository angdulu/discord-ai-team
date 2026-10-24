const { randomUUID } = require('crypto');
const { ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder,
  ModalBuilder, TextInputBuilder, TextInputStyle } = require('discord.js');

function button(id, label, style = ButtonStyle.Secondary) {
  return new ButtonBuilder().setCustomId(id).setLabel(label).setStyle(style);
}

function controlComponents() {
  return [new ActionRowBuilder().addComponents(
    button('control:settings', 'Agent settings'), button('control:model', 'Model'),
    button('control:usage', 'Usage'),
  ), new ActionRowBuilder().addComponents(
    button('control:new', 'New conversation'), button('control:resume', 'Resume'),
    button('control:rename', 'Rename'),
  )];
}

function panelView(name) {
  return { content: `**${name} controls**\nManage this agent and conversations here. Use /panel to open a private panel you can dismiss.`,
    components: controlComponents(), allowedMentions: { parse: [] } };
}

function taskComponents(task, canSteer = false) {
  const buttons = [button(`task:${task.id}:stop`, 'Stop', ButtonStyle.Danger),
    button('control:stop-all', 'Stop all', ButtonStyle.Danger)];
  if (canSteer) buttons.push(button(`task:${task.id}:steer`, 'Send update', ButtonStyle.Primary));
  buttons.push(button('control:queue', 'Queue'));
  return [new ActionRowBuilder().addComponents(buttons)];
}

function inputModal(id, title, label) {
  return new ModalBuilder().setCustomId(id).setTitle(title).addComponents(
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('value')
      .setLabel(label).setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(4000)));
}

function createTaskStore() {
  const tasks = new Map();
  return {
    add(channelId, userId, text, notify = false) {
      const task = { id: randomUUID(), channelId, userId, text, notify, status: 'queued' };
      tasks.set(task.id, task);
      return task;
    },
    get: (id) => tasks.get(id),
    list: (channelId) => [...tasks.values()].filter((task) => task.channelId === channelId && task.status !== 'cancelled'),
    finish(task) { tasks.delete(task.id); },
    cancelQueued(channelId) {
      for (const task of tasks.values()) {
        if (task.channelId === channelId && task.status === 'queued') task.status = 'cancelled';
      }
    },
  };
}

function queuePanel(tasks, channelId, userId, name) {
  const list = tasks.list(channelId);
  const active = list.filter((task) => task.status === 'running').length;
  const queued = list.filter((task) => task.status === 'queued');
  const mine = queued.filter((task) => task.userId === userId);
  const rows = [new ActionRowBuilder().addComponents(button('control:queue', 'Refresh'))];
  if (mine.length) rows.unshift(new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder().setCustomId('control:cancel-queued').setPlaceholder('Cancel one of your queued requests')
      .addOptions(mine.slice(0, 25).map((task) => ({
        label: task.text.replace(/\s+/g, ' ').slice(0, 100) || 'Attachment request', value: task.id,
      })))));
  return {
    content: `**${name} queue**\nRunning: **${active}** · Queued: **${queued.length}**\n` +
      (queued.length ? queued.slice(0, 10).map((task, index) =>
        `${index + 1}. ${task.userId === userId ? task.text.replace(/\s+/g, ' ').slice(0, 100) || 'Attachment request' : 'Another user’s request'}`).join('\n') : 'No requests waiting.'),
    components: rows, allowedMentions: { parse: [] },
  };
}

module.exports = { controlComponents, panelView, taskComponents, inputModal, createTaskStore, queuePanel };
