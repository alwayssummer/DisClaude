# Claude Code → Discord DM notifier

Get a **Discord direct message** when a Claude Code session needs your
attention or finishes a turn — on any of your dev boxes.

- 🔴 **`PermissionRequest`** → `🔴 **<machine>** / `<project>` — approve **<tool>**?` + the command/file in question. Fires *only* when Claude is genuinely blocked waiting for your approval.
- 🟢 **`Stop`** → `🟢 **<machine>** / `<project>` — done` + Claude's last message. Fires when the turn ends and it's your move.

It deliberately does **not** hook `Notification`: that event conflates real
permission prompts with idle "waiting for your input" pings, which caused false
alarms (e.g. while a subagent was running). `PermissionRequest` is the
purpose-built, reliable "needs you" signal.

It's a single **zero-dependency Node script** (Node ships with Claude Code, so
there's nothing else to install). Messages are delivered by a Discord **bot**
over plain REST — no `discord.js`, no gateway connection. The script always
exits 0, so a network hiccup can never hang or break your session.

---

## One-time Discord setup (per person, not per machine)

You need a bot that is allowed to DM you.

1. **Create the bot.** Go to the [Discord Developer Portal](https://discord.com/developers/applications)
   → **New Application** → name it (e.g. "Claude Notifier") → **Bot** tab →
   **Reset Token** → **Copy** the token. Keep it secret.
2. **Invite the bot to a server you're both in.** A bot can only DM you if it
   shares a server with you. Any server works — a private, empty personal
   server is ideal. Build an invite URL:
   ```
   https://discord.com/api/oauth2/authorize?client_id=YOUR_APPLICATION_ID&scope=bot&permissions=0
   ```
   (Application ID is on the bot's **General Information** page.) Open it and
   add the bot to your server. No special permissions are needed — DMs bypass
   channel permissions.
3. **Allow DMs from server members.** In that server: **Privacy Settings** →
   enable **Direct Messages**. (Also check User Settings → Content & Social /
   Privacy if you've globally locked DMs down.)
4. **Get your user ID.** Discord → **Settings → Advanced → Developer Mode: on**,
   then right-click your own name → **Copy User ID**.

---

## Install on a machine

Copy this folder to the box (git clone, `scp`, or drag it over), then:

```sh
node discord-notify.js install
```

It will:
- prompt for the **bot token** (hidden input), your **user ID**, and a
  **machine name** (defaults to the hostname),
- copy itself to `~/.claude/hooks/discord-notify.js`,
- write `~/.claude/hooks/discord-notify.config.json` (the token lives here,
  `chmod 600`),
- merge **PermissionRequest** + **Stop** hooks into `~/.claude/settings.json`
  (existing hooks are preserved; a backup `.bak` is made),
- send a **test DM** and confirm it arrived.

Non-interactive (e.g. scripted provisioning):

```sh
node discord-notify.js install --no-input --token "<BOT_TOKEN>" --user 595603276787875840 --name "Insp17"
```

Restart Claude Code (or start a new session) so it picks up the new hooks.

---

## Verify

```sh
node discord-notify.js test        # re-send a test DM anytime
```

Simulate a real event without a session:

```sh
echo '{"hook_event_name":"PermissionRequest","cwd":"/path/to/proj","tool_name":"Bash","tool_input":{"command":"npm run deploy"}}' | node ~/.claude/hooks/discord-notify.js
```

You should get: `🔴 **<host>** / `proj` — approve **Bash**?` with `> npm run deploy`.

---

## Configuration

`~/.claude/hooks/discord-notify.config.json`:

| Field | Meaning |
|---|---|
| `botToken` | Discord bot token (secret). |
| `userId` | Your Discord user ID — the DM recipient. |
| `machineName` | Label shown in every message. Defaults to the hostname. |
| `throttleSeconds` | Suppress a repeat DM for the *same event* within N seconds. `0` = off. |
| `debug` | When `true`, append one line per hook invocation (event + raw payload) to `discord-notify.debug.log` for troubleshooting. Default off. |
| `ignoreNotificationPatterns` | Legacy: substrings to skip *if* a `Notification` event ever reaches the script. Unused by default now that `Notification` isn't hooked. |
| `dmChannelId` | Cached DM channel — filled in automatically, safe to leave `null`. |
| `events` | Optional. e.g. `{ "Stop": false }` to disable one event without uninstalling. |

Edit and it takes effect on the next event — no reinstall needed.

---

## Uninstall

```sh
node discord-notify.js uninstall           # remove the hooks from settings.json
node discord-notify.js uninstall --purge   # also delete the config + installed script
```

---

## Troubleshooting

- **Test DM says "Cannot send messages to this user" (code 50007).** The bot
  doesn't share a server with you, or that server blocks member DMs. Redo setup
  steps 2–3.
- **"401 / invalid token".** Reset the token in the Developer Portal and
  re-run `install`.
- **Wrong user ID (code 50033 / 50035).** Re-copy it via Developer Mode.
- **No DM but no error.** Confirm you restarted Claude Code, and check the hook
  is present in `~/.claude/settings.json`.

## Security

The bot token is a bearer secret — anyone with it can act as the bot. It's
never committed (it lives in `~/.claude`, and `.gitignore` blocks stray
`*.config.json`). Rotate it in the Developer Portal if it leaks.
