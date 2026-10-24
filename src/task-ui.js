const { randomUUID } = require('crypto');
const { ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder,
  ModalBuilder, TextInputBuilder, TextInputStyle, MessageFlags } = require('discord.js');

const QUESTION_INSTRUCTIONS = [
  'Discord interface: write questions, option labels, and progress updates in English.',
  'When useful, briefly explain what you are doing before using tools.',
  'To ask the user a question or offer choices, end your response with exactly one discord-question fenced JSON block.',
  'Format: ```discord-question\n{"questions":[{"id":"style","question":"Which design do you prefer?","options":[{"label":"Minimal","description":"A simple layout"},{"label":"Liquid glass","description":"Translucent surfaces"}]}]}\n```',
  'Ask at most 3 questions at a time, with up to 25 options each; options may be empty for free text.',
  'The bot shows real Discord controls, waits for the user, then continues this same conversation with their answers.',
  'Do not continue dependent work or invent an answer while waiting. Do not use a terminal-only question tool.',
  'Use the block only to request an actual answer, never as an example or inside your final explanation. Never ask for passwords or secrets.',
].join('\n');

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
  buttons.push(button('control:queue', 'Queue'),
    button(`task:${task.id}:notify`, task.notify ? 'Notify: ON' : 'Notify when done'));
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

function normalizeQuestions(input) {
  if (!Array.isArray(input) || !input.length || input.length > 3) throw new Error('Expected 1–3 questions.');
  const ids = new Set();
  return input.map((item, index) => {
    if (!item || typeof item.question !== 'string' || !item.question.trim() || item.question.length > 1200 || item.isSecret) {
      throw new Error('Invalid question.');
    }
    const id = typeof item.id === 'string' && item.id ? item.id : `question-${index + 1}`;
    if (ids.has(id) || ['__proto__', 'constructor', 'prototype'].includes(id)) throw new Error('Invalid question ID.');
    ids.add(id);
    const options = item.options ?? [];
    if (!Array.isArray(options) || options.length > 25) throw new Error('Expected at most 25 options.');
    const labels = new Set();
    return { id, question: item.question.trim(), multiSelect: item.multiSelect === true,
      options: options.map((option) => {
        const label = typeof option === 'string' ? option : option?.label;
        if (typeof label !== 'string' || !label.trim() || label.length > 100 || labels.has(label)) throw new Error('Invalid option.');
        labels.add(label);
        return { label, description: typeof option?.description === 'string' ? option.description.slice(0, 100) : undefined };
      }) };
  });
}

function parseQuestion(text) {
  const match = String(text).match(/(?:^|\n)```discord-question\s*\n([\s\S]*?)\n```\s*$/);
  if (!match) return null;
  try {
    const questions = normalizeQuestions(JSON.parse(match[1]).questions);
    return { questions, preamble: text.slice(0, match.index).trim() };
  } catch { return null; }
}

// Hold back an unfinished protocol block, even when its opening fence spans deltas.
function visibleDraft(text) {
  const start = text.indexOf('```discord-question');
  if (start >= 0) return text.slice(0, start).trimEnd();
  for (let length = Math.min(text.length, 20); length > 0; length--) {
    if ('```discord-question'.startsWith(text.slice(-length))) return text.slice(0, -length).trimEnd();
  }
  return text;
}

async function runInteractive({ prompt, sessionId, runTurn, ask, signal, onQuestion, onSession }) {
  while (true) {
    if (signal.aborted) throw new Error('aborted');
    const result = await runTurn(prompt, sessionId);
    if (signal.aborted) throw new Error('aborted');
    if (result?.sessionId) onSession?.(result.sessionId);
    const question = parseQuestion(typeof result === 'string' ? result : result.text);
    if (!question) return result;
    if (!ask) return { ...result, text: question.preamble || question.questions.map((item) => item.question).join('\n') };
    if (!result.sessionId) throw new Error('Could not preserve the conversation for this question.');
    sessionId = result.sessionId;
    await onQuestion?.(question.preamble);
    const answer = await ask(question.questions);
    if (signal.aborted) throw new Error('aborted');
    prompt = `The user answered your Discord questions:\n${JSON.stringify(answer)}\nContinue the original task using these answers.\n\n${QUESTION_INSTRUCTIONS}`;
  }
}

function questionPanel(id, question, index, total) {
  const rows = [];
  if (question.options.length && question.options.length <= 4 && !question.multiSelect && question.options.every((option) => option.label.length <= 80)) {
    rows.push(new ActionRowBuilder().addComponents(question.options.map((option, i) =>
      button(`question:${id}:pick:${i}`, option.label.slice(0, 80)))));
  } else if (question.options.length) {
    rows.push(new ActionRowBuilder().addComponents(new StringSelectMenuBuilder()
      .setCustomId(`question:${id}:select`).setPlaceholder(question.multiSelect ? 'Choose one or more options' : 'Choose an option')
      .setMinValues(1).setMaxValues(question.multiSelect ? question.options.length : 1)
      .addOptions(question.options.map((option, i) => ({ ...option, value: String(i) })))));
  }
  rows.push(new ActionRowBuilder().addComponents(
    button(`question:${id}:custom`, 'Custom answer', ButtonStyle.Primary),
    button(`question:${id}:cancel`, 'Cancel task', ButtonStyle.Danger)));
  return { content: `**Question ${index + 1} of ${total}**\n${question.question}\nOnly the requester can answer.`,
    components: rows, allowedMentions: { parse: [] } };
}

function createQuestionBroker({ timeoutMs = 30 * 60 * 1000 } = {}) {
  const pending = new Map();

  async function ask(input, { channel, userId, signal }) {
    const questions = normalizeQuestions(input);
    const answers = {};
    for (const [index, question] of questions.entries()) {
      if (signal?.aborted) throw new Error('aborted');
      const id = randomUUID();
      const answer = await new Promise((resolve, reject) => {
        const entry = { channelId: channel.id, userId, question, message: null, finished: false };
        const finish = (error, value) => {
          if (entry.finished) return false;
          entry.finished = true;
          clearTimeout(timer);
          signal?.removeEventListener('abort', abort);
          pending.delete(id);
          entry.closedText = error ? `**${question.question}**\n${error.message === 'aborted' ? 'Task stopped.' : error.message}`
            : `**${question.question}**\nAnswer received.`;
          void entry.message?.edit({ content: entry.closedText, components: [], allowedMentions: { parse: [] } }).catch(() => {});
          if (error) reject(error);
          else resolve(value);
          return true;
        };
        const abort = () => finish(new Error('aborted'));
        const timer = setTimeout(() => finish(new Error('Question expired. Send a new message to continue.')), timeoutMs);
        timer.unref?.();
        entry.finish = finish;
        pending.set(id, entry);
        signal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted) { abort(); return; }
        channel.send(questionPanel(id, question, index, questions.length)).then((message) => {
          entry.message = message;
          if (entry.finished) void message.edit({ content: entry.closedText, components: [], allowedMentions: { parse: [] } }).catch(() => {});
        }, (error) => finish(error));
      });
      answers[question.id] = { answers: answer };
    }
    return { answers };
  }

  async function handle(interaction) {
    const [, id, action, choice] = interaction.customId.split(':');
    const entry = pending.get(id);
    const deny = (content) => interaction.reply({ content, flags: MessageFlags.Ephemeral });
    if (!entry || entry.finished) return deny('This question is no longer waiting for an answer.');
    if (entry.userId !== interaction.user.id || entry.channelId !== interaction.channelId) return deny('Only the requester can answer in the original channel.');
    if (action === 'custom' && interaction.isButton()) {
      return interaction.showModal(inputModal(`question:${id}:submit`, 'Custom answer', 'Your answer'));
    }
    let answer;
    if (action === 'submit' && interaction.isModalSubmit()) {
      const text = interaction.fields.getTextInputValue('value').trim();
      if (!text || text.length > 4000) return deny('Enter an answer of 1–4,000 characters.');
      answer = [text];
    } else if (action === 'pick' && interaction.isButton()) {
      if (!/^(0|[1-9]\d*)$/.test(choice) || !entry.question.options[Number(choice)] || entry.question.multiSelect) return deny('Choose a valid option.');
      answer = [entry.question.options[Number(choice)].label];
    } else if (action === 'select' && interaction.isStringSelectMenu()) {
      if (!interaction.values.length || (!entry.question.multiSelect && interaction.values.length !== 1) ||
          interaction.values.some((value) => !/^(0|[1-9]\d*)$/.test(value) || !entry.question.options[Number(value)])) return deny('Choose a valid option.');
      answer = interaction.values.map((value) => entry.question.options[Number(value)].label);
    } else if (!(action === 'cancel' && interaction.isButton())) return deny('Invalid question action.');
    await interaction.deferUpdate();
    entry.finish(action === 'cancel' ? new Error('Question cancelled. Task stopped.') : null, answer);
  }

  return { ask, handle };
}

module.exports = { QUESTION_INSTRUCTIONS, controlComponents, panelView, taskComponents, inputModal, createTaskStore,
  queuePanel, normalizeQuestions, parseQuestion, visibleDraft, createQuestionBroker, runInteractive };
