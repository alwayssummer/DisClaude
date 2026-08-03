# Claude Code status notifier — project plan & handoff

> Durable handoff so work can resume even if the session ends. Covers current
> state, the decisions behind it, and the forward roadmap. Last updated during
> the "Phase 0" work (Discord notifier switched to traffic-light events).

## Goal

Know, at a glance and remotely, what every Claude Code session across the
user's dev boxes is doing — **🟡 working / 🔴 needs-you / 🟢 idle-done / offline** —
and optionally get pushed when a session needs attention. Evolving from a
fire-and-forget Discord DM into a real **state dashboard**.

## Where we are now

**Phase 0 is DONE and committed** (`git log`: "Phase 0: switch Discord notifier
to traffic-light events"). A working Discord **bot DM** notifier is installed on
this box (`acn2wi25`).

### What exists (this repo, `D:\AgentProjects\DiscordHook`)
- `discord-notify.js` — single zero-dependency Node script. Hook-mode notifier +
  `install` / `test` / `uninstall` / `help` subcommands. Reads Claude Code hook
  JSON on stdin, DMs via Discord bot REST, **always exits 0** so it can't hang a
  session (5s HTTP timeout + safety timer).
- `README.md` — setup, per-box install, troubleshooting.
- `config.example.json` — config template (no secrets).
- `.gitignore` — blocks `*.config.json`, `discord-notify.state.json`, and
  `claudialogs/` (session transcripts — they can contain pasted secrets; keep
  local, never commit).
- `PLAN.md` — this file.

### How the notifier works
- Delivery: a Discord **bot** (not a webhook) DMs the user over plain REST —
  `POST /users/@me/channels {recipient_id}` → `POST /channels/{id}/messages`.
  A bot can only DM a user it **shares a server with**; that constraint is why
  install sends a test DM and prints a "no mutual guild" hint on failure.
- Config lives at `~/.claude/hooks/discord-notify.config.json` (chmod 600):
  `botToken`, `userId`, `machineName` (defaults to hostname), `dmChannelId`
  (cached), `throttleSeconds`, `debug`, `ignoreNotificationPatterns` (legacy).
- Hooks registered into user-level `~/.claude/settings.json` under
  `HOOK_EVENTS = ['PermissionRequest', 'Stop']`, both calling
  `node "<home>/.claude/hooks/discord-notify.js"`. `install` **migrates** older
  installs by stripping our command from any other event (e.g. the old
  `Notification` hook) while leaving other tools' hooks alone.
- Messages (traffic-light):
  - 🔴 `PermissionRequest` → `🔴 **<machine>** / `<project>` — approve **<tool>**?`
    + the command/file from `tool_input` quoted.
  - 🟢 `Stop` → `🟢 **<machine>** / `<project>` — done` + Claude's final message.
- Final message for 🟢 is read from the **Stop payload** (`last_assistant_message`,
  then `assistant_message`) and only falls back to parsing the transcript
  `.jsonl` on older versions — this fixes an earlier stale/off-by-one quote that
  came from a transcript-write race.

### Live environment specifics (this machine)
- Claude Code **v2.1.220**, Node **v25**.
- Bot: **ClaudeHook**, client_id **1533237457611522179**, joined guild
  **EA NEOH** (`1339387849681932348`).
- Recipient: user **595603276787875840** (chris.lons / Chris Lons) — verified
  via API.
- `machineName` = `acn2wi25` (was mistakenly `Insp17` from the original example;
  corrected). Future boxes should just let it default to their hostname.
- `debug: true` is currently ON to capture raw payloads. **Flip off** once the
  `last_assistant_message` field is confirmed.
- User's `~/.claude/settings.json` also has an unrelated `SessionEnd` →
  `claudialogs` PowerShell hook (leave it alone).

### SECURITY — action pending
The bot token was pasted in chat and is present in local `claudialogs/*.jsonl`.
It is **not** in git (verified: scanned all objects, purged a dangling commit).
Recommend the user **reset the token** in the Discord Developer Portal and
re-run `node discord-notify.js install` (reuses everything else). Never write the
token into any repo file.

## Key decisions & research findings

1. **Use purpose-built events, not `Notification`.** Claude Code's `Notification`
   conflates real permission prompts (`permission_prompt`) with idle
   "waiting for your input" (`idle_prompt`) — the root cause of false alarms
   (e.g. pinging while a subagent ran) and the "double notify" feel. The
   community "traffic light" builders instead wire distinct events:
   - 🟡 working ← `PreToolUse` (+ `UserPromptSubmit`)
   - 🔴 needs-you ← **`PermissionRequest`** (reliable, actionable)
   - 🟢 idle/done ← `Stop` (+ `SessionEnd` for offline)
   For **DMs** we only send the edges that matter (🔴, 🟢); 🟡 would be spam. For
   a **dashboard** we use all of them.
2. **`Stop` payload carries the final text**, so don't parse the transcript
   (avoids the write race). Verify exact field name per version via debug log.
3. **Viewer = PWA**, not native Android: one codebase serves the web portal and
   installs on Android with an icon + Web Push, no Play Store, no native build.
   Android web-push support is solid.
4. **Hosting = public managed** (user's choice) so hooks on every PC and the
   phone (incl. cellular) can reach it. Leaning **Fly.io** (always-on tiny
   instance, ~free at this size, normal debuggable Node app). Cloudflare Workers
   is the zero-server alternative if preferred.
5. **Home Assistant** is the *eventual* dream home (could unify Claude status +
   the user's Aqara temp-sensor archival they never set up), but it's
   self-hosted and a bigger commitment the user already bounced off — so NOT
   step one. Build the reporting side **HA-compatible** (can publish to MQTT
   later) so nothing is wasted.
6. Reference tools seen: `busylight-for-humans` (drives Luxafor/Blynclight),
   `claude-status-bar` (macOS), Chive (multi-session, desktop). No existing
   Android multi-PC Claude monitor — hence we build.

### User preferences learned (apply going forward)
- Wants to be **steered** on infra choices they don't know well; give a
  recommendation and proceed, don't dump options.
- Values reliability over band-aids ("this is not very reliable so far" drove
  the event re-architecture).
- Owns Aqara sensors; latent intent to run Home Assistant for data archival.
- Fine leaving `claudialogs` local; not worried about local logs.

## Roadmap

### Phase 0 — Discord traffic-light mode ✅ DONE
Switched notifier to `PermissionRequest` (🔴) + `Stop` (🟢), dropped
`Notification`, payload-based final message, added debug payload logging,
auto-migration on install. Committed.

**Immediate open items:**
- Read `~/.claude/hooks/discord-notify.debug.log` after a real `Stop` /
  `PermissionRequest` fires to confirm payload field names on v2.1.220
  (esp. `last_assistant_message`). Adjust `finalAssistantText()` if needed.
- Then set `debug: false` in the config.

### Phase 1 — Live light-board dashboard ✅ CODE DONE (deploy pending)
`dashboard/server.js` (auth on report/viewer, SSE, /state, /healthz) +
`dashboard/public/index.html` light-board (tile per session, host rollup,
staleness, offline removes). `report-hook.js` = client hook that POSTs states
(SessionStart→online, UserPromptSubmit/PreToolUse→working,
PermissionRequest→needs-you, Stop→idle, SessionEnd→offline); self-installer,
coexists with the Discord hooks. Full lifecycle verified locally.

### Phase 2 — PWA + Web Push ✅ CODE DONE (deploy pending)
Server: shared-secret auth (Bearer or `?token=`), static assets, VAPID/Web
Push (`web-push` dep), `/subscribe`, push on rising edge into needs-you.
Client: installable PWA (`manifest.webmanifest`, `sw.js`, `icon.svg`), token
gate in localStorage, Enable-notifications subscribe flow. Deploy scaffolding:
`Dockerfile`, `fly.toml`, `.dockerignore`, `DEPLOY.md`. `node_modules`
gitignored; `package-lock.json` tracked.

### LIVE ✅ (deployed 2026-08-02)
- Dashboard deployed to **Fly.io**, app `claudedash`, URL
  **https://claudedash.fly.dev** (GitHub repo: `alwayssummer/ClaudeDash`,
  deployed from the `dashboard/` subdir via Fly's "Working directory" field).
- Secrets set in Fly (`DASH_TOKEN`, `VAPID_*`) — verified: `/healthz` 200,
  auth gate 401 without token, push/VAPID ready.
- Reporter installed on `acn2wi25`; sessions report live (confirmed this
  session showed as working/Bash). Discord notifier still runs in parallel.
- Fly first-deploy hiccup ("could not create a fly.toml from any machines") was
  transient — a retry created the first machine.

### Remaining (optional)
- Phone: open the URL, enter DASH_TOKEN, Add to Home Screen, tap 🔔 Enable.
- Other boxes: `node report-hook.js install --url https://claudedash.fly.dev --token <DASH_TOKEN>`.
- Retire Discord when happy: `node discord-notify.js uninstall --purge`.

### (historical) Remaining to go live — see dashboard/DEPLOY.md
1. `fly launch` + `fly secrets set DASH_TOKEN / VAPID_*` + `fly deploy`
   (needs their Fly.io account/login — cannot be done for them).
2. On each PC: `node report-hook.js install --url <fly-url> --token <DASH_TOKEN>`,
   then restart Claude Code.
3. Phone: open URL, enter token, Add to Home Screen, tap 🔔 Enable.
4. Retire Discord when happy: `node discord-notify.js uninstall --purge`.

- **Backend** (~150 lines, Node, deploy to Fly.io):
  - `POST /report` — hooks push status. Auth via per-PC bearer token. Body:
    `{ host, session_id, project, state, tool?, detail?, ts }`.
  - State store: in-memory + SQLite (or a small JSON file) keyed by
    `host + session_id`; keep `last_seen`.
  - `GET /` — serves the dashboard page.
  - `GET /events` — **SSE** stream pushing state changes to open dashboards
    (auto-reconnect, simpler than WebSocket).
  - Staleness: derive **grey/offline** from `last_seen` age (PCs that sleep
    won't send `SessionEnd`); optional lightweight heartbeat.
- **State model / mapping** (reuse Phase 0 event knowledge):
  `SessionStart`→online, `PreToolUse`→🟡 working, `PermissionRequest`→🔴,
  `Stop`→🟢 idle, `SessionEnd`→offline. Each **session** is a tile; a **PC**
  rollup light = most-urgent of its sessions (🔴 > 🟡 > 🟢). This naturally
  fixes the "single lamp only shows the last session" caveat.
- **Reporter**: a new mode/script (or extend `discord-notify.js`) that POSTs
  status instead of DMing. Register the full event set in `settings.json`.
- **Auth/secrets**: shared secret per PC; dashboard behind a token/login.
- **Dashboard UI**: responsive grid of colored tiles (host, project, state,
  age, current tool), live via SSE. Theme-aware.

### Phase 2 — PWA install + Web Push
- Add `manifest.json` + service worker → installable on Android home screen.
- **Web Push** (VAPID keys) so the phone buzzes on 🔴 needs-you (configurable),
  even when the app is closed. This properly *replaces* the Discord DM.

### Phase 3 — Home Assistant bridge (optional, later)
- Also publish status to **MQTT** so Home Assistant can render tiles and
  **archive history** (ties into the user's Aqara/HA ambition). Managed MQTT
  (e.g. HiveMQ Cloud free tier) or the user's own broker.

## Verification checklist (per phase)
- **Phase 0**: `node discord-notify.js test` DMs; a real permission prompt yields
  🔴 with the command; end-of-turn yields 🟢 with correct final text; debug log
  shows one INVOKED per event (no doubles); `settings.json` has
  PermissionRequest+Stop only (Notification gone), SessionEnd preserved. ✅
- **Phase 1**: fake a session via `curl POST /report`; dashboard tile updates
  live over SSE; staleness turns a tile grey; two sessions on one host roll up
  correctly; deployed URL reachable from phone on cellular.
- **Phase 2**: install PWA on Android; receive a push on 🔴 with the app closed.
- **Phase 3**: HA shows the sessions as entities; history recorded.

## How to resume quickly
1. Read this file + `README.md`.
2. `git log --oneline` for recent state; run `node discord-notify.js help`.
3. Check `~/.claude/hooks/discord-notify.debug.log` for real payload shapes.
4. Confirm hooks: inspect `~/.claude/settings.json` (`PermissionRequest`, `Stop`).
5. Ask the user before Phase 1 build/deploy (needs their Fly.io account).
