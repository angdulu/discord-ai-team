#!/usr/bin/env node
// Andrew's to-dos as Discord scheduled events in the Nexus server (Andrew, 2026-11-24).
// Events are the only store: no vault page mirrors them. An event starts at 09:00 KST on its
// due date and ends a year later, so a past-due to-do stays "live" (visibly overdue) until
// someone deletes it as done. Discord only notifies users who pressed "Interested" and bots
// can't press it, so reminders go through the nightly DM instead.
// CLI: list | add "<title>" [--due YYYY-MM-DD] [--note "..."] | done <eventId>
const fs = require('fs');
const path = require('path');
const { REST, Routes } = require('discord.js');

const DAY_MS = 24 * 3600 * 1000;
const UNDATED = '마감 미정';

function kstDate(date) {
  return new Date(date.getTime() + 9 * 3600 * 1000).toISOString().slice(0, 10);
}

function todoPayload({ title, due, note }, now = new Date()) {
  const name = String(title || '').trim().slice(0, 100);
  if (!name) throw new Error('A to-do needs a title');
  if (due && !/^\d{4}-\d{2}-\d{2}$/.test(due)) throw new Error('due must be YYYY-MM-DD');
  // Undated to-dos surface after a week; Discord rejects a start time in the past.
  const planned = due ? Date.parse(due + 'T09:00:00+09:00') : now.getTime() + 7 * DAY_MS;
  const start = new Date(Math.max(planned, now.getTime() + 2 * 60 * 1000));
  return {
    name,
    description: String(note || '').slice(0, 1000) || undefined,
    privacy_level: 2,
    entity_type: 3,
    entity_metadata: { location: due ? '마감 ' + due : UNDATED },
    scheduled_start_time: start.toISOString(),
    scheduled_end_time: new Date(start.getTime() + 365 * DAY_MS).toISOString(),
  };
}

function toTodo(event) {
  return {
    id: event.id,
    title: event.name,
    due: event.entity_metadata?.location === UNDATED ? null : kstDate(new Date(event.scheduled_start_time)),
  };
}

// Overdue, today and tomorrow, in KST; undated to-dos never count as due.
function dueSoon(todos, now = new Date()) {
  const today = kstDate(now);
  const tomorrow = kstDate(new Date(now.getTime() + DAY_MS));
  const pick = test => todos.filter(t => t.due && test(t.due)).map(t => t.title);
  return { overdue: pick(d => d < today), today: pick(d => d === today), tomorrow: pick(d => d === tomorrow) };
}

function reminderLines(todos, now = new Date()) {
  const soon = dueSoon(todos, now);
  const lines = [];
  if (soon.overdue.length) lines.push('⚠️ 기한 지남: ' + soon.overdue.join(', '));
  if (soon.today.length) lines.push('📅 오늘 마감: ' + soon.today.join(', '));
  if (soon.tomorrow.length) lines.push('📅 내일 마감: ' + soon.tomorrow.join(', '));
  return lines;
}

// One line for the weekly pulse: open count plus everything due within seven days.
function weekLine(todos, now = new Date()) {
  const end = kstDate(new Date(now.getTime() + 7 * DAY_MS));
  const due = todos.filter(t => t.due && t.due <= end).sort((a, b) => a.due.localeCompare(b.due))
    .map(t => `${t.title}(${t.due.slice(5).replace('-', '/')})`);
  return `📅 할 일 ${todos.length}개` + (due.length ? ' · 7일 내 마감: ' + due.join(', ') : '');
}

function client(config) {
  const guild = config.todoGuildId;
  if (!guild) throw new Error('Set todoGuildId in the schedule config');
  const bot = config.todoBot || 'claude';
  const env = require('dotenv').parse(fs.readFileSync(path.join(__dirname, '..', 'bots', bot + '.env')));
  const rest = new REST({ version: '10', timeout: 20000, retries: 2 }).setToken(env.DISCORD_BOT_TOKEN);
  return {
    async list() {
      const events = await rest.get(Routes.guildScheduledEvents(guild));
      return events.filter(e => e.status === 1 || e.status === 2).map(toTodo)
        .sort((a, b) => (a.due || '9999').localeCompare(b.due || '9999'));
    },
    async add(todo, now = new Date()) {
      return toTodo(await rest.post(Routes.guildScheduledEvents(guild), { body: todoPayload(todo, now) }));
    },
    async done(id) {
      await rest.delete(Routes.guildScheduledEvent(guild, id));
    },
  };
}

function loadConfig() {
  const file = process.env.NEXUS_SCHEDULE_CONFIG || path.join(require('os').homedir(), '.config/discord-ai-team/nexus-schedule.json');
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

async function cli(argv) {
  const [command, ...rest] = argv;
  const flag = name => { const i = rest.indexOf(name); return i >= 0 ? rest.splice(i, 2)[1] : undefined; };
  const todos = client(loadConfig());
  if (command === 'list') return todos.list();
  if (command === 'add') {
    const due = flag('--due'), note = flag('--note');
    return todos.add({ title: rest.join(' '), due, note });
  }
  if (command === 'done') {
    if (!rest[0]) throw new Error('done needs an event id from list');
    await todos.done(rest[0]);
    return { done: rest[0] };
  }
  throw new Error('Usage: nexus-todo.cjs list | add "<title>" [--due YYYY-MM-DD] [--note "..."] | done <eventId>');
}

if (require.main === module) {
  cli(process.argv.slice(2)).then(out => console.log(JSON.stringify(out, null, 2)))
    .catch(error => { console.error(error.message); process.exitCode = 1; });
}
module.exports = { todoPayload, toTodo, dueSoon, reminderLines, weekLine, client, loadConfig, kstDate };
