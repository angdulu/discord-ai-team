# Discord AI Team: Claude, ChatGPT and Gemini in your Discord, with no API keys

**English** · [한국어](README.ko.md)

You already pay for Claude, ChatGPT, or Gemini. This project turns those subscriptions into a team of AI agents in your own Discord server. You can talk to them from your phone, and they can read each other's messages and even argue with each other.

- **No API keys, no per-token bills.** Each agent is the vendor's **official CLI, signed in with your own account (OAuth)**. Everything runs inside the plan you already have.
- **Any mix of agents.** One bot per settings file: three different AIs, or two Claudes (a "Writer" and a "Critic"), or just one.
- **You set the rules.** Names, roles, who may use each bot, what it may touch (read-only / edit / full), and where they may debate.

| `PROVIDER` | AI | CLI it runs | Subscription |
|---|---|---|---|
| `claude` | Claude | Claude Code (`claude -p`) | Claude Pro / Max |
| `codex` | ChatGPT | Codex CLI (`codex app-server`) | ChatGPT Plus / Pro |
| `gemini` | Gemini | Antigravity CLI (`agy -p`) | Google AI plan |

<p align="center">
  <img src="docs/demo.gif" width="760" alt="Codex, Gemini and Claude debating a product name in Discord, stopping after 4 turns">
</p>

<img src="docs/handoff.png" width="760" alt="Gemini to Claude handoff">

## What you can do

- **Ask from anywhere.** @mention a bot in a channel, or DM it. In a private channel with only one accessible AI bot, you can talk without mentioning it. It works on the files in a folder you choose (a project, a notes vault, anything).
- **Send images.** Attach a photo with a bot mention in a channel, or send one in a DM. PNG, JPEG, GIF, and WebP are supported, up to four images per message and 20 MB each.
- **Send documents.** Attach PDF, TXT, DOCX, Markdown (`.md`, `.markdown`), or CSV files and the bot reads their text. Up to four documents per message and 10 MB each are supported. Long files are limited to 25,000 characters each and 60,000 characters total; PDFs are limited to the first 30 pages. Scanned PDFs need OCR, which is not supported.
- **Hand work between AIs.** `@gemini summarize the notes, then @claude add that summary to the plan`. The bot mentioned later waits for the earlier one's reply and builds on it. A mentioned bot also reads the channel messages since its last reply, including other bots' messages.
- **Let them debate.** Debate defaults to ON in server channels where at least two running bots can access them. Ask an agent to tag another by name to continue; the bot converts an eligible `@name` to a Discord mention. The exchange can end before its 4-turn maximum (configurable per channel). Use `/debate settings` to turn a channel OFF, and `/stop-all` to end an active debate.
- **See your quota.** `/usage-all` shows the running bots' remaining 5-hour and weekly limits. It is read live from each CLI and costs nothing.
- **Switch models on the fly.** `/model` opens a dropdown for model and reasoning effort, saved per channel.
- **Manage agents in Discord.** Each bot has its own `/agent settings` for its name, server and channel prompts, and idle timer. `/debate settings` is available through every bot for the shared channel setting.
- **Memory per channel.** Each channel is its own ongoing conversation and survives restarts. `/new` starts over, `/resume` privately lists past Discord conversations, and `/rename` gives them names.
- **See replies as they arrive.** The bots keep their local connections open between turns, refresh Discord's typing indicator, and update a draft message during a direct one-to-one reply. Debates and multi-bot requests post only completed replies.
- **Ask from a message.** Right-click or long-press a message and choose **Apps → Ask** under the bot's app. That bot reads the selected message and its attachments, then replies in the channel.
- **Forward text messages.** Forward a text message to a bot, and it reads it.

### Slash commands

`/usage-all` shows plan limits for the running bots. Only the requester sees the response.

<img src="docs/usage.png" width="600" alt="Discord /usage-all showing plan usage for ChatGPTbot, Geminibot, and Claudebot">

`/model` lets you choose a model and reasoning effort for the current channel.

<img src="docs/model-picker.png" width="760" alt="Discord /model showing Claude model and effort dropdowns">

## How it works

```
                ┌─► bots/claude.env ─► claude -p   ─ your Claude login  ─┐
Discord server ─┼─► bots/codex.env  ─► codex app-server ─ ChatGPT login ─┼─► WORKSPACE_DIR
                └─► bots/gemini.env ─► agy -p      ─ your Google login  ─┘
```

Every bot runs the same small Node.js program (`src/bot.js` + `src/runner.js`). Claude and Antigravity keep a streaming CLI process per active conversation; Codex keeps one app-server connection and routes turns to its threads. Sessions can resume after a bot restart. `src/providers/` has one file per AI. Image attachments are briefly saved in `state/attachments/` for the CLIs and deleted after the reply. Document text is extracted in memory and included in the request. Running bots register themselves in `state/agents.json`, which is how they find each other for debates.

## Requirements

- macOS or Linux with Node.js 20.16–20.x or 22.3+ (`ctl.sh` needs zsh, which macOS has by default)
- The CLI for each AI you want, installed and signed in (step 1)
- A Discord server you own (a free private server is fine)

## Setup

### 1. Sign in to each CLI (one time)

```bash
claude             # type /login if it asks
codex login        # choose "Sign in with ChatGPT"
agy                # first run asks you to sign in with Google, then exit
```

The CLIs keep their own login. This project never touches passwords or API keys.

### 2. Create a Discord bot for each agent

At <https://discord.com/developers/applications>, once per bot:

1. **New Application** → name the application. Set its bot username separately on the **Bot** tab or in `/agent settings`. Discord may reject a username containing a brand name, even with "Bot" added; choose another distinct name if it does.
2. **Bot** tab → **Reset Token** → copy the token.
3. Same tab: turn on **Message Content Intent** (otherwise the bot sees empty messages).
4. **OAuth2 → URL Generator** → scopes `bot` and `applications.commands` → permissions *View Channels, Send Messages, Read Message History, Embed Links, Add Reactions* → open the URL and add the bot to your server.

### 3. Set up channels

For debates, give at least two bots **View Channel**, **Send Messages**, and **Read Message History** permissions. Debate is ON by default; `/debate settings` shows whether a channel uses the default or has its own setting. If you set `ALLOWED_USER_IDS`, turn on **User Settings → Advanced → Developer Mode** and right-click yourself → **Copy User ID**.

Each channel keeps its own conversation, so make channels per **topic**, not per bot. For example:

| Channel | For | Bots debate? |
|---|---|---|
| `#general` | Everyday questions | on by default; turn off if wanted |
| `#project-x` | One project; context stays separate | on by default; turn off if wanted |
| `#debate` | Throw a question in, let them argue | on by default when two bots can access it |

**Just want to try it?** Copy the included example out of this folder (`cp -r example-workspace ~/leftover-demo`) and point `WORKSPACE_DIR` at the copy. Don't point bots at a folder inside this repo, since your tokens live here. The example is a made-up side project ("Leftover", a fridge-to-dinner app) with notes and shared rules. Ask the bots to debate its open questions.

### 4. Install

```bash
git clone https://github.com/angdulu/discord-ai-team
cd discord-ai-team
npm install
```

### 5. Create one settings file per bot

Copy an example and name the copy whatever you like. **The file name is the bot's name in `ctl.sh`.**

```bash
cp bots/claude.env.example bots/claude.env
cp bots/codex.env.example  bots/codex.env
cp bots/gemini.env.example bots/gemini.env
chmod 600 bots/*.env
```

Then fill each one in. Every option is explained inside the file:

```ini
PROVIDER=claude                     # claude | codex | gemini
DISCORD_BOT_TOKEN=<token>
WORKSPACE_DIR=/path/to/your/folder
PERMISSIONS=read-only               # read-only | edit | full
ALLOWED_CHANNEL_IDS=                  # empty = every channel the bot can access
ALLOWED_USER_IDS=<your user id>     # who may use it; empty = anyone in those channels
```

Want two Claudes? Make `bots/writer.env` and `bots/critic.env`, both with `PROVIDER=claude`, each with its own Discord bot token.

### 6. Choose permissions

| `PERMISSIONS` | The bot can | Claude | Codex | Gemini |
|---|---|---|---|---|
| `read-only` (default) | read files in `WORKSPACE_DIR` | read and search tools only; editing tools and shell commands blocked | OS sandbox blocks all writes | every tool denied unless allowlisted¹ |
| `edit` | read + create/edit files in `WORKSPACE_DIR` | `acceptEdits` | `workspace-write` sandbox | `--mode accept-edits`¹ |
| `full` | anything: any command, any path | skip all permission checks | no sandbox | skip all permission checks |

¹ Gemini also checks file reads against `~/.gemini/antigravity-cli/settings.json`. To let it read vault images and Discord attachments, add these two rules to `permissions.allow`, replacing the placeholders with absolute paths:
`"read_file(/absolute/path/to/WORKSPACE_DIR)"`, `"read_file(/absolute/path/to/discord-ai-team/state/attachments)"`.

Rules of thumb:
- **Set `ALLOWED_USER_IDS`** whenever you use `edit` or `full`. Anyone who can use the bot gets its permissions.
- **Only you in the server:** `edit` is a comfortable default.
- **`full`:** only for a folder or machine you'd be fine losing. Nobody approves each step.
- When something is denied, the reply ends with `⛔ Permission denied: …`. Trust that line over the bot's own claim that it "did" something.

### 7. Start

```bash
npm run register-commands  # register slash commands and message menus for every bot
./ctl.sh start all        # or: ./ctl.sh start claude
./ctl.sh status all
./ctl.sh restart codex    # after editing its .env
./ctl.sh stop all
```

Look for `logged in as ...`. Logs are in `logs/<name>.log`.
The registration script removes any duplicate server commands from older installs. New global commands can take a short time to appear in Discord.

## Recommended: point every bot at one shared memory folder

Each bot's channel memory is separate. But if every bot's `WORKSPACE_DIR` is the **same notes folder** (an Obsidian vault, an "LLM wiki", a plain folder of Markdown), they all read the same long-term memory. Something Claude saved on Monday is there for Gemini on Friday, in any channel.

- **One rulebook for all.** Each CLI reads its own instruction file from the folder: Claude reads `CLAUDE.md`, Codex reads `AGENTS.md`, and Gemini reads `GEMINI.md` (or `AGENTS.md`). Put the same rules in each, for example "keep an `index.md`, one note per topic, log changes in `log.md`", and every agent maintains the memory the same way.
- **Decide who writes.** The memory only grows if some bot can write. A good split is one writer on `PERMISSIONS=edit` with the others on `read-only`, so nothing gets overwritten by two agents at once.
- **Ask it to remember.** `@claude save what we decided about X to the notes`, then later, anywhere: `@gemini what did we decide about X?`

## Commands

| Type | Where | Does |
|---|---|---|
| `@bot …` | allowed channels (or a DM, no mention needed) | Ask that bot |
| `/new` | choose a bot | Start a fresh conversation in this channel |
| `/resume` | choose a bot | Privately pick a previous Discord conversation to continue here |
| `/rename name [conversation]` | choose a bot | Name the current or a selected past conversation |
| `/model` | choose a bot | Pick model + reasoning effort |
| `/usage`, `/usage-all` | choose a bot | Show one bot's usage or every running bot's usage |
| `/stop`, `/stop-all` | choose a bot | Stop one bot or every agent in this channel |
| `/agent settings` | server manager, choose a bot | View and edit that bot's name, prompts, idle timer, recent history limit, and file access privately |
| `/debate settings` | server manager, choose any bot | View and edit this channel's debate ON/OFF and maximum turns |
| **Apps → Ask** | right-click or long-press a message | Send that message and its attachments to the chosen bot |

Slash command responses are visible only to the requester. Prompt edit forms start with the current text; clearing a server or channel prompt removes it. Choosing a conversation from another channel in `/resume` detaches it there. Normal requests use @mentions or DMs. In a private channel with only one accessible running AI bot, unmentioned messages also reach that bot; adding another bot requires mentions again. Idle closes the agent process or connection, not its conversation; the next turn resumes it. Channel deletion and `/new` still clear the channel's active session separately.

`ALLOWED_CHANNEL_IDS` in the bot's `.env` controls which server channels it can answer in. Leave it empty to allow every channel the bot can access; change it in `.env` and restart the bot to update the restriction. The recent history limit is per agent and channel (1–100 messages). Clearing its input restores the `.env` default. Recent history passed to the model is also capped at 8,000 characters. The panel also shows allowed users, workspace folder, and whether a Discord token is configured; it never displays the token itself.

The settings panels and forms are in English. **File access** applies to the entire agent and offers `Read-only`, `Edit`, `Full`, and `Use bot default`. Changing it interrupts active work and closes warm CLI workers so the next request uses the new mode. `Use bot default` restores `PERMISSIONS` from `.env`. Set `ALLOWED_USER_IDS` in that bot's `.env` before selecting `Edit` or `Full`.

**Bot name** applies to one agent in every server and DM. The code defaults to Claudebot, ChatGPTbot, or Geminibot, matching the bot usernames accepted by Discord. Editing the name also changes the Discord bot account's username; it does not rename the Discord application or override a server nickname. Discord limits bot username changes to two per hour, so an API rejection leaves the saved name unchanged. **Use default name** restores the provider-based default. Changing a name requires `ALLOWED_USER_IDS` in that bot's `.env`.

There is no built-in or base prompt. **Server prompt** applies to this agent throughout the current Discord server; **Channel prompt** adds instructions for this channel. DMs have no configurable role prompt. Eligible `@name` tags in agent replies become real Discord mentions in code, and the debate turn limit is enforced in code. Request text and recent channel context are added for each turn.

## All settings

| Setting | Default | Meaning |
|---|---|---|
| `PROVIDER` | (required) | `claude`, `codex`, or `gemini` |
| `DISCORD_BOT_TOKEN` | (required) | This bot's token |
| `WORKSPACE_DIR` | (required) | Folder the bot works in |
| `PERMISSIONS` | `read-only` | `read-only`, `edit`, `full`; can be overridden per agent in `/agent settings` |
| `ALLOWED_CHANNEL_IDS` | all channels | Channels it answers in |
| `ALLOWED_USER_IDS` | anyone | Users it answers |
| `HISTORY_LIMIT` | 20 | Recent messages read for context (max 100); can be overridden per channel in `/agent settings` |

## Safety

- **Tokens:** `*.env` is git-ignored. Keep this folder **outside** `WORKSPACE_DIR`, or a bot could be asked to read its own token.
- **Images:** attachments are downloaded only from Discord's CDN, saved briefly in `state/attachments/`, and deleted after the reply. Unsupported formats and oversized files are rejected.
- **Documents:** supported documents are also downloaded only from Discord's CDN and their text is extracted in memory. Images in PDFs or DOCX files, including scanned pages, are not analyzed.
- **Access:** with `ALLOWED_CHANNEL_IDS` empty, a bot answers in channels it can access (and DMs). A nonempty list restricts it to those IDs. `ALLOWED_USER_IDS` still restricts which people can call it.
- **Debates are bounded:** after the channel's maximum agent turns (default 4, range 1–20), a human must step in; `/stop-all` can end them early.
- **Terms:** this runs each vendor's official CLI with your own login on your own machine, for your own use. Don't use it to offer your subscription to other people. Check each provider's terms.

## Troubleshooting

| Problem | Fix |
|---|---|
| Bot doesn't answer in a channel | Check its Discord View/Send/Read History permissions and `ALLOWED_USER_IDS`. If `ALLOWED_CHANNEL_IDS` is nonempty, clear it or add this channel ID, then restart the bot. |
| `Missing Access` (403) | Private channel: add the bot in the channel's permission settings. |
| Bot gets empty messages | Turn on **Message Content Intent** in the Developer Portal. |
| "permission denied" | Check `PERMISSIONS`. Then run `/new` and retry: a bot that was denied keeps refusing in that conversation. |
| Gemini says `Permission denied: read_file` | Add the vault and `state/attachments` paths to `permissions.allow` as shown above, then run Gemini's `/new` in Discord and retry. |
| Bots don't tag each other in `#debate` | Ask an agent to tag another by `@name`, then check that `/debate settings` shows ON and that both bots are running with View, Send, and Read History permissions in that channel. |
| Gemini folder rule doesn't match | Write `write_file(/path/to/dir)`. The `/path/**` form does not match. |

## Optional: Claude through the official Discord plugin

Instead of `PROVIDER=claude`, you can run an interactive Claude Code session with Anthropic's Discord plugin (`/plugin install discord@claude-plugins-official`). Its advantage: when Claude needs permission, it DMs you **Allow / Deny buttons**. Its limits: it ignores messages from other bots, it lacks this project's `/new` and `/model`, and all channels share one conversation. For usage, `claude-usage-statusline.py` saves plan usage from the status line to `~/.claude/usage-cache.json`.

## License

MIT. Not affiliated with Anthropic, OpenAI, or Google.
