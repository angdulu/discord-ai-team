#!/usr/bin/env node
// Standby watchdog (macOS): run your bots on an always-on server, keep this Mac as a manual standby.
//
// Run every 60 s by a LaunchAgent (see README, "Optional: Mac standby for a server").
// Server up   : refresh a local copy of the shared workspace every MIRROR_EVERY_MIN (rsync, optional),
//               and stop any bot this script started here (one token on two hosts = double replies).
// Server down : after FAIL_LIMIT straight minutes, a random bot DMs you one alert with a reaction per
//               bot. Nothing starts by itself: react, and the next run starts that bot on this Mac.
// Works with every bot offline: reactions are read over Discord's REST API, no gateway needed.
//
// Config: ~/.config/discord-ai-team/standby.env (or STANDBY_CONFIG=path). Each bot's token is read
// from bots/<name>.env. Test without starting anything:
//   DRY_RUN=1 PRIMARY_HOSTS=10.255.255.1 FAIL_LIMIT=1 node scripts/standby-watchdog.mjs
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HOME = os.homedir();
const REPO = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const expand = (p) => p.replace(/^~(?=\/|$)/, HOME);
const parseEnv = (text) => Object.fromEntries(text.split('\n')
  .map((l) => l.replace(/\s+#.*$/, '').trim()).filter((l) => l && !l.startsWith('#') && l.includes('='))
  .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^(["'])(.*)\1$/, '$2')]; }));
const confFile = expand(process.env.STANDBY_CONFIG || '~/.config/discord-ai-team/standby.env');
const conf = parseEnv(fs.readFileSync(confFile, 'utf8'));
const env = (k, d = '') => process.env[k] || conf[k] || d;

const DRY = !!process.env.DRY_RUN;
const HOSTS = env('PRIMARY_HOSTS').split(/\s+/).filter(Boolean);
const PORT = Number(env('PRIMARY_PORT', 22));
const SERVER = env('PRIMARY_NAME', 'The server');
const FAIL_LIMIT = Number(env('FAIL_LIMIT', 5));
const USER = env('ALERT_USER_ID');
const MIRROR_SOURCE = env('MIRROR_SOURCE');
const MIRROR = expand(env('MIRROR_DIR', '~/workspace-mirror'));
const MIRROR_EVERY = Number(env('MIRROR_EVERY_MIN', 1440)) * 60000;
// "claude:🟣 codex:🟢 gemini:🔵" — bots/<name>.env keys and the reaction that starts each one
const BOTS = env('STANDBY_BOTS', 'claude:🟣 codex:🟢 gemini:🔵').split(/\s+/).filter(Boolean)
  .map((pair) => { const [bot, ...emoji] = pair.split(':'); return { bot, emoji: emoji.join(':') }; });
const PATH_ENV = [path.dirname(process.execPath), `${HOME}/.local/bin`, '/opt/homebrew/bin', '/usr/local/bin',
  '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(':');
if (!HOSTS.length || !USER) throw new Error(`${confFile}: PRIMARY_HOSTS and ALERT_USER_ID are required`);

const dir = path.join(HOME, 'Library/Application Support/discord-ai-team/standby');
fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
const stateFile = path.join(dir, 'state.json');
const state = (() => { try { return JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch { return {}; } })();
state.fails ??= 0; state.started ??= [];
const save = () => fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
const tag = DRY ? '[test] ' : '';
const log = (m) => fs.appendFileSync(path.join(dir, 'standby.log'), `${new Date().toISOString()} ${tag}${m}\n`);

const reachable = (host, port) => new Promise((resolve) => {
  const s = net.connect({ host, port, timeout: 5000 });
  const done = (ok) => { s.destroy(); resolve(ok); };
  s.once('connect', () => done(true)).once('timeout', () => done(false)).once('error', () => done(false));
});

function tokenOf(bot) {
  try { return parseEnv(fs.readFileSync(path.join(REPO, 'bots', `${bot}.env`), 'utf8')).DISCORD_BOT_TOKEN || ''; }
  catch (e) { log(`cannot read bots/${bot}.env: ${e.code}`); return ''; }
}
async function discord(bot, method, route, body) {
  const res = await fetch(`https://discord.com/api/v10${route}`, {
    method, headers: { Authorization: `Bot ${tokenOf(bot)}`, 'Content-Type': 'application/json' },
    body: body && JSON.stringify(body), signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`${bot}: ${method} ${route.split('?')[0]} → HTTP ${res.status}`);
  return res.status === 204 ? null : res.json();
}
const dmChannel = async (bot) => (await discord(bot, 'POST', '/users/@me/channels', { recipient_id: USER })).id;
const say = async (bot, content) => {
  try { await discord(bot, 'POST', `/channels/${await dmChannel(bot)}/messages`, { content: tag + content }); }
  catch (e) { log(`DM failed: ${e.message}`); }
};
const nameOf = async (bot) => (await discord(bot, 'GET', '/users/@me').catch(() => null))?.username || bot;

const label = (bot) => `com.discord-ai-team.${bot}`; // same labels as ctl.sh
const running = (bot) => execFileSync('launchctl', ['list'], { encoding: 'utf8' })
  .split('\n').some((l) => { const f = l.split('\t'); return f[2] === label(bot) && /^\d+$/.test(f[0]); });
const mirrorNote = () => !MIRROR_SOURCE ? ''
  : ` My workspace copy was synced ${state.lastMirror ? `${Math.round((Date.now() - state.lastMirror) / 60000)} min ago` : 'never'}; anything I save there is temporary.`;

async function serverUp() {
  state.fails = 0;
  if (state.started.length || state.alertId) {
    for (const bot of state.started) {
      if (!DRY) { try { execFileSync('launchctl', ['remove', label(bot)]); } catch {} }
      await say(bot, `${SERVER} is back, so I'm shutting down on this Mac. Replies come from the server again.`);
    }
    if (!state.started.length) await say(state.alertBot, `${SERVER} is back. No bots were started on this Mac.`);
    log(`server back; stopped: ${state.started.join(', ') || 'none'}`);
    state.started = []; delete state.alertId; delete state.alertChannel; delete state.alertBot;
  }
  if (MIRROR_SOURCE && !DRY && Date.now() - (state.lastMirror || 0) >= MIRROR_EVERY) {
    try {
      fs.mkdirSync(MIRROR, { recursive: true });
      execFileSync('rsync', ['-a', '--delete', MIRROR_SOURCE, `${MIRROR}/`],
        { timeout: 300000, env: { ...process.env, PATH: PATH_ENV } });
      state.lastMirror = Date.now();
    } catch (e) { log(`mirror failed: ${String(e.message).slice(0, 200)}`); }
  }
}

async function serverDown() {
  if (!(await reachable('discord.com', 443))) return log('server and discord.com unreachable: this Mac is offline, skipping');
  state.fails += 1;
  log(`server unreachable (${state.fails}/${FAIL_LIMIT})`);
  if (state.fails < FAIL_LIMIT) return;

  if (!state.alertId) {
    const candidates = BOTS.map((b) => b.bot).filter(tokenOf);
    if (!candidates.length) return log('no bot token found in bots/*.env');
    state.alertBot = candidates[Math.floor(Math.random() * candidates.length)];
    const names = await Promise.all(BOTS.map(async (b) => `${b.emoji} ${await nameOf(b.bot)}`));
    state.alertChannel = await dmChannel(state.alertBot);
    const msg = await discord(state.alertBot, 'POST', `/channels/${state.alertChannel}/messages`, { content: tag +
      `⚠️ ${SERVER} has been unreachable for ${state.fails} min. React to pick which bot to start on this Mac: ` +
      `${names.join(' · ')} (starts within a minute). They shut down automatically once the server is back.` });
    state.alertId = msg.id;
    for (const { emoji } of BOTS) {
      await discord(state.alertBot, 'PUT', `/channels/${state.alertChannel}/messages/${msg.id}/reactions/${encodeURIComponent(emoji)}/@me`)
        .catch((e) => log(`reaction failed: ${e.message}`));
      await new Promise((r) => setTimeout(r, 400));
    }
    return;
  }

  for (const { bot, emoji } of BOTS) {
    if (state.started.includes(bot)) continue;
    const users = await discord(state.alertBot, 'GET',
      `/channels/${state.alertChannel}/messages/${state.alertId}/reactions/${encodeURIComponent(emoji)}?limit=100`).catch(() => []);
    if (!users.some((u) => u.id === USER)) continue;
    if (!DRY && running(bot)) { log(`${bot} already running on this Mac (not started by the watchdog)`); continue; }
    if (!DRY) {
      const logs = path.join(HOME, 'Library/Logs/discord-ai-team/standby');
      fs.mkdirSync(logs, { recursive: true, mode: 0o700 });
      try { execFileSync('launchctl', ['remove', label(bot)]); } catch {}
      execFileSync('launchctl', ['submit', '-l', label(bot), '-o', `${logs}/${bot}.log`, '-e', `${logs}/${bot}.err.log`,
        '--', '/usr/bin/env', `PATH=${PATH_ENV}`, process.execPath, path.join(REPO, 'src/bot.js'), bot]);
    }
    state.started.push(bot);
    log(`started ${bot}`);
    await say(bot, `${SERVER} is unreachable, so I'm now running on this Mac.${mirrorNote()}`);
  }
}

try {
  const up = (await Promise.all(HOSTS.map((h) => reachable(h, PORT)))).some(Boolean);
  await (up ? serverUp() : serverDown());
} catch (e) {
  log(`error: ${e.message}`);
} finally {
  save();
}
