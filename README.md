# Discord AI Team: Claude, ChatGPT and Gemini in your Discord, with no API keys

**English** · [한국어](README.ko.md)

You already pay for Claude, ChatGPT, or Gemini. This project turns those subscriptions into a team of AI agents in your own Discord server. You can talk to them from your phone, and they can read each other's messages and even argue with each other.

- **No API keys, no per-token bills.** Each agent is the vendor's **official CLI, signed in with your own account (OAuth)**. Everything runs inside the plan you already have.
- **Any mix of agents.** One bot per settings file: three different AIs, or two Claudes (a "Writer" and a "Critic"), or just one.
- **You set the rules.** Names, roles, who may use each bot, what it may touch (read-only / edit / full), and where they may debate.

| `PROVIDER` | AI | CLI it runs | Subscription |
|---|---|---|---|
| `claude` | Claude | Claude Code (`claude -p`) | Claude Pro / Max |
| `codex` | ChatGPT | Codex CLI (`codex exec`) | ChatGPT Plus / Pro |
| `gemini` | Gemini | Antigravity CLI (`agy -p`) | Google AI plan |

<p align="center">
  <img src="docs/debate.png" width="380" alt="Codex, Gemini and Claude debating a product name, stopping after 4 turns">
</p>

| `!usage`: live quota from all three plans | Handoff: Gemini summarizes, Claude writes it to the notes |
|---|---|
| <img src="docs/usage.png" alt="Plan usage cards"> | <img src="docs/handoff.png" alt="Gemini to Claude handoff"> |

<img src="docs/model-picker.png" width="520" alt="!model picker">

## What you can do

- **Ask from anywhere.** @mention a bot in a channel, or DM it. It works on the files in a folder you choose (a project, a notes vault, anything).
- **Hand work between AIs.** `@gemini summarize the notes, then @claude add that summary to the plan`. The bot mentioned later waits for the earlier one's reply and builds on it. A mentioned bot also reads the channel messages since its last reply, including other bots' messages.
- **Let them debate.** In channels you pick, bots @mention each other and go back and forth. They **stop after 4 turns** (configurable), and `!stop` ends it at once.
- **See your quota.** `!usage` posts a card with your remaining 5-hour and weekly limits. It is read live from each CLI and costs nothing.
- **Switch models on the fly.** `!model` opens a dropdown for model and reasoning effort, saved per channel.
- **Memory per channel.** Each channel is its own ongoing conversation and survives restarts. `!new` starts over.
- **Forward messages.** Forward any message to a bot, and it reads it.

## How it works

```
                ┌─► bots/claude.env ─► claude -p   ─ your Claude login  ─┐
Discord server ─┼─► bots/codex.env  ─► codex exec  ─ your ChatGPT login ─┼─► WORKSPACE_DIR
                └─► bots/gemini.env ─► agy -p      ─ your Google login  ─┘
```

Every bot runs the same small Node.js program (`src/bot.js` + `src/runner.js`). Each Discord message becomes one CLI call that resumes that channel's conversation. `src/providers/` has one file per AI. Running bots register themselves in `state/agents.json`, which is how they find each other for debates.

## Requirements

- macOS or Linux with Node.js 18+ (`ctl.sh` needs zsh, which macOS has by default)
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

1. **New Application** → name it (this is the name people see in Discord). Discord rejects brand names on their own, like "Claude", "Codex", or "Gemini", so add a word: "Claude Bot".
2. **Bot** tab → **Reset Token** → copy the token.
3. Same tab: turn on **Message Content Intent** (otherwise the bot sees empty messages).
4. **OAuth2 → URL Generator** → scope `bot` → permissions *View Channels, Send Messages, Read Message History, Embed Links, Add Reactions* → open the URL and add the bot to your server.

### 3. Set up channels

In Discord, turn on **User Settings → Advanced → Developer Mode**. Then right-click a channel → **Copy Channel ID**, and right-click yourself → **Copy User ID**.

Each channel keeps its own conversation, so make channels per **topic**, not per bot. For example:

| Channel | For | Bots debate? |
|---|---|---|
| `#general` | Everyday questions | off |
| `#project-x` | One project; context stays separate | off |
| `#debate` | Throw a question in, let them argue | **on** |

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
BOT_NAME=                           # shown in replies; default Claude / Codex / Gemini
ROLE=writer                         # optional; other bots see it in debates
DISCORD_BOT_TOKEN=<token>
WORKSPACE_DIR=/path/to/your/folder
PERMISSIONS=read-only               # read-only | edit | full
ALLOWED_CHANNEL_IDS=<general>,<project-x>,<debate>
ALLOWED_USER_IDS=<your user id>     # who may use it; empty = anyone in those channels
DEBATE_CHANNEL_IDS=<debate>
OWNER_NAME=<your name>
```

Want two Claudes? Make `bots/writer.env` and `bots/critic.env`, both with `PROVIDER=claude`, each with its own Discord bot token.

### 6. Choose permissions

| `PERMISSIONS` | The bot can | Claude | Codex | Gemini |
|---|---|---|---|---|
| `read-only` (default) | read files in `WORKSPACE_DIR` | anything needing approval is denied; file tools blocked | OS sandbox blocks all writes | every tool denied unless allowlisted¹ |
| `edit` | read + create/edit files in `WORKSPACE_DIR` | `acceptEdits` | `workspace-write` sandbox | `--mode accept-edits`¹ |
| `full` | anything: any command, any path | skip all permission checks | no sandbox | skip all permission checks |

¹ Gemini checks shell commands against `~/.gemini/antigravity-cli/settings.json`. To allow read-only commands, for example:
`{ "permissions": { "allow": ["command(ls)", "command(cat)", "command(grep)", "command(find)"] } }`

Rules of thumb:
- **Set `ALLOWED_USER_IDS`** whenever you use `edit` or `full`. Anyone who can use the bot gets its permissions.
- **Only you in the server:** `edit` is a comfortable default.
- **`full`:** only for a folder or machine you'd be fine losing. Nobody approves each step.
- When something is denied, the reply ends with `⛔ Permission denied: …`. Trust that line over the bot's own claim that it "did" something.

### 7. Start

```bash
./ctl.sh start all        # or: ./ctl.sh start claude
./ctl.sh status all
./ctl.sh restart codex    # after editing its .env
./ctl.sh stop all
```

Look for `logged in as ...`. Logs are in `logs/<name>.log`.

## Recommended: point every bot at one shared memory folder

Each bot's channel memory is separate. But if every bot's `WORKSPACE_DIR` is the **same notes folder** (an Obsidian vault, an "LLM wiki", a plain folder of Markdown), they all read the same long-term memory. Something Claude saved on Monday is there for Gemini on Friday, in any channel.

- **One rulebook for all.** Each CLI reads its own instruction file from the folder: Claude reads `CLAUDE.md`, Codex reads `AGENTS.md`, and Gemini reads `GEMINI.md` (or `AGENTS.md`). Put the same rules in each, for example "keep an `index.md`, one note per topic, log changes in `log.md`", and every agent maintains the memory the same way.
- **Decide who writes.** The memory only grows if some bot can write. A good split is one writer on `PERMISSIONS=edit` with the others on `read-only`, so nothing gets overwritten by two agents at once.
- **Ask it to remember.** `@claude save what we decided about X to the notes`, then later, anywhere: `@gemini what did we decide about X?`

## Commands

| Type | Where | Does |
|---|---|---|
| `@bot …` | allowed channels (or a DM, no mention needed) | Ask that bot |
| `!new` | with a mention, or in DM | Start a fresh conversation in this channel |
| `!model` | with a mention | Pick model + reasoning effort |
| `!usage` | plain | Every bot posts its quota card (`@bot !usage` for just one) |
| `!stop` | plain | Stop running work in this channel and drop queued requests |

## All settings

| Setting | Default | Meaning |
|---|---|---|
| `PROVIDER` | (required) | `claude`, `codex`, or `gemini` |
| `DISCORD_BOT_TOKEN` | (required) | This bot's token |
| `WORKSPACE_DIR` | (required) | Folder the bot works in |
| `BOT_NAME` | Claude / Codex / Gemini | Name in replies |
| `ROLE` | none | Role other bots see in debates |
| `PERMISSIONS` | `read-only` | `read-only`, `edit`, `full` |
| `ALLOWED_CHANNEL_IDS` | all channels | Channels it answers in |
| `ALLOWED_USER_IDS` | anyone | Users it answers |
| `DEBATE_CHANNEL_IDS` | none | Channels where bots may trigger each other |
| `MAX_BOT_TURNS` | 4 | Bot turns before a debate waits for a human |
| `HISTORY_LIMIT` | 20 | Recent messages read for context (max 100) |
| `OWNER_NAME` | "the user" | Who makes the final call |

## Safety

- **Tokens:** `*.env` is git-ignored. Keep this folder **outside** `WORKSPACE_DIR`, or a bot could be asked to read its own token.
- **Access:** a bot only answers in `ALLOWED_CHANNEL_IDS` (and DMs), and only to `ALLOWED_USER_IDS` if you set it.
- **Debates are bounded:** at most `MAX_BOT_TURNS`, then a human must step in, and `!stop` always works.
- **Terms:** this runs each vendor's official CLI with your own login on your own machine, for your own use. Don't use it to offer your subscription to other people. Check each provider's terms.

## Troubleshooting

| Problem | Fix |
|---|---|
| Bot doesn't answer in a channel | Add the channel ID to `ALLOWED_CHANNEL_IDS` (and your ID to `ALLOWED_USER_IDS`), then `./ctl.sh restart <name>`. |
| `Missing Access` (403) | Private channel: add the bot in the channel's permission settings. |
| Bot gets empty messages | Turn on **Message Content Intent** in the Developer Portal. |
| "permission denied" | Check `PERMISSIONS`. Then `!new` and retry: a bot that was denied keeps refusing in that conversation. |
| Bots don't tag each other in `#debate` | Both must be running once so they register in `state/agents.json`, and the channel must be in both bots' `DEBATE_CHANNEL_IDS`. |
| Gemini folder rule doesn't match | Write `write_file(/path/to/dir)`. The `/path/**` form does not match. |

## Optional: Claude through the official Discord plugin

Instead of `PROVIDER=claude`, you can run an interactive Claude Code session with Anthropic's Discord plugin (`/plugin install discord@claude-plugins-official`). Its advantage: when Claude needs permission, it DMs you **Allow / Deny buttons**. Its limits: it ignores messages from other bots, it has no `!new` or `!model`, and all channels share one conversation. If you use it for `!usage`, `claude-usage-statusline.py` saves plan usage from the status line to `~/.claude/usage-cache.json`.

## License

MIT. Not affiliated with Anthropic, OpenAI, or Google.
