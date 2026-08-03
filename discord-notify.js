#!/usr/bin/env node
/*
 * discord-notify.js — Claude Code -> Discord DM notifier
 *
 * Zero dependencies (built-in Node only). One file does everything:
 *   node discord-notify.js install     set up bot token, config, and hooks
 *   node discord-notify.js test        send a test DM using saved config
 *   node discord-notify.js uninstall   remove hook entries (add --purge to delete config)
 *   node discord-notify.js help        show help
 *   (no args, JSON on stdin)           hook mode: send a DM for the event
 *
 * As a Claude Code hook it reads the event JSON from stdin, sends you a
 * Discord DM via the bot REST API, and ALWAYS exits 0 so it can never hang
 * or break a session.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const readline = require('readline');

// ---------------------------------------------------------------------------
// Paths (everything installed lives under ~/.claude)
// ---------------------------------------------------------------------------
const CLAUDE_DIR = path.join(os.homedir(), '.claude');
const HOOKS_DIR = path.join(CLAUDE_DIR, 'hooks');
const CONFIG_PATH = path.join(HOOKS_DIR, 'discord-notify.config.json');
const STATE_PATH = path.join(HOOKS_DIR, 'discord-notify.state.json');
const DEBUG_PATH = path.join(HOOKS_DIR, 'discord-notify.debug.log');
const SCRIPT_DEST = path.join(HOOKS_DIR, 'discord-notify.js');
const SETTINGS_PATH = path.join(CLAUDE_DIR, 'settings.json');

const DEFAULT_USER_ID = '595603276787875840';
const DISCORD_HOST = 'discord.com';
const API_BASE = '/api/v10';
const HTTP_TIMEOUT_MS = 5000;
const MAX_CONTENT = 2000; // Discord message content hard limit

// ---------------------------------------------------------------------------
// Config / state helpers
// ---------------------------------------------------------------------------
function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch {
    return null;
  }
}

function saveConfig(c) {
  fs.mkdirSync(HOOKS_DIR, { recursive: true });
  const clean = {};
  for (const k of ['botToken', 'userId', 'machineName', 'throttleSeconds', 'dmChannelId', 'events', 'ignoreNotificationPatterns', 'debug']) {
    if (c[k] !== undefined) clean[k] = c[k];
  }
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(clean, null, 2) + '\n', { mode: 0o600 });
  try { fs.chmodSync(CONFIG_PATH, 0o600); } catch { /* Windows: best effort */ }
}

function saveConfigQuiet(c) {
  try { saveConfig(c); } catch { /* ignore */ }
}

// Diagnostic: only writes when config.debug is true. One line per event.
function dbg(config, line) {
  if (!config || !config.debug) return;
  try { fs.appendFileSync(DEBUG_PATH, new Date().toISOString() + ' ' + line + '\n'); } catch { /* ignore */ }
}

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')); } catch { return { lastSent: {} }; }
}

function isThrottled(config, event) {
  const t = Number(config.throttleSeconds || 0);
  if (!t) return false;
  const st = loadState();
  const last = st.lastSent && st.lastSent[event];
  return !!last && (Date.now() - last) < t * 1000;
}

function markSent(config, event) {
  const t = Number(config.throttleSeconds || 0);
  if (!t) return;
  try {
    const st = loadState();
    st.lastSent = st.lastSent || {};
    st.lastSent[event] = Date.now();
    fs.writeFileSync(STATE_PATH, JSON.stringify(st));
  } catch { /* ignore */ }
}

// ---------------------------------------------------------------------------
// Discord REST
// ---------------------------------------------------------------------------
function apiRequest(method, apiPath, token, bodyObj) {
  return new Promise((resolve) => {
    const body = bodyObj ? JSON.stringify(bodyObj) : null;
    const opts = {
      hostname: DISCORD_HOST,
      path: API_BASE + apiPath,
      method,
      headers: {
        Authorization: 'Bot ' + token,
        'Content-Type': 'application/json',
        'User-Agent': 'claude-code-discord-notify (https://local, 1.0)',
      },
    };
    if (body) opts.headers['Content-Length'] = Buffer.byteLength(body);
    const req = https.request(opts, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        let json = null;
        try { json = data ? JSON.parse(data) : null; } catch { /* non-JSON */ }
        resolve({ status: res.statusCode, data: json, raw: data });
      });
    });
    req.on('error', (e) => resolve({ status: 0, error: e }));
    req.setTimeout(HTTP_TIMEOUT_MS, () => { req.destroy(); resolve({ status: 0, error: new Error('request timed out') }); });
    if (body) req.write(body);
    req.end();
  });
}

async function openDmChannel(token, userId) {
  const r = await apiRequest('POST', '/users/@me/channels', token, { recipient_id: userId });
  if (r.status === 200 || r.status === 201) return r.data.id;
  const msg = (r.data && r.data.message) || r.raw || (r.error && r.error.message) || ('HTTP ' + r.status);
  const err = new Error('Could not open a DM channel: ' + msg);
  err.discord = r;
  throw err;
}

async function sendDm(config, content) {
  const token = config.botToken;
  const userId = config.userId;
  if (!token) throw new Error('No bot token in config.');
  if (!userId) throw new Error('No recipient userId in config.');

  let channelId = config.dmChannelId;
  if (!channelId) {
    channelId = await openDmChannel(token, userId);
    config.dmChannelId = channelId;
    saveConfigQuiet(config);
  }

  let send = await apiRequest('POST', `/channels/${channelId}/messages`, token, { content });
  // Unknown channel (cache went stale) -> re-open and retry once.
  if (send.status === 404 || (send.data && send.data.code === 10003)) {
    channelId = await openDmChannel(token, userId);
    config.dmChannelId = channelId;
    saveConfigQuiet(config);
    send = await apiRequest('POST', `/channels/${channelId}/messages`, token, { content });
  }
  if (send.status < 200 || send.status >= 300) {
    const msg = (send.data && send.data.message) || send.raw || (send.error && send.error.message) || ('HTTP ' + send.status);
    const err = new Error('Could not send the DM: ' + msg);
    err.discord = send;
    throw err;
  }
  return send;
}

// ---------------------------------------------------------------------------
// Message building
// ---------------------------------------------------------------------------
function truncate(str, max) {
  if (str.length <= max) return str;
  return str.slice(0, Math.max(0, max - 1)).trimEnd() + '…';
}

function getLastAssistantMessage(transcriptPath) {
  try {
    if (!transcriptPath || !fs.existsSync(transcriptPath)) return '';
    const lines = fs.readFileSync(transcriptPath, 'utf8').split(/\r?\n/).filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
      let o;
      try { o = JSON.parse(lines[i]); } catch { continue; }
      const m = o.message || o;
      const role = m.role || o.type;
      if (role !== 'assistant') continue;
      let text = '';
      const c = m.content;
      if (typeof c === 'string') text = c;
      else if (Array.isArray(c)) text = c.filter((b) => b && b.type === 'text' && b.text).map((b) => b.text).join('\n');
      text = (text || '').trim();
      if (text) return text;
    }
  } catch { /* ignore */ }
  return '';
}

// Notification `message` texts to skip. Default drops Claude Code's idle
// "waiting for your input" ping — it fires on end-of-turn (already covered by
// the Stop "done" DM) and while a subagent is running (a false "come back"
// alarm). Set `ignoreNotificationPatterns: []` in config to keep everything.
const DEFAULT_IGNORE_NOTIFICATION_PATTERNS = ['waiting for your input'];

function isIgnoredNotification(message, config) {
  const patterns = Array.isArray(config.ignoreNotificationPatterns)
    ? config.ignoreNotificationPatterns
    : DEFAULT_IGNORE_NOTIFICATION_PATTERNS;
  if (!patterns.length) return false;
  const m = String(message || '').toLowerCase();
  return patterns.some((p) => p && m.includes(String(p).toLowerCase()));
}

// Prefer the assistant's final text straight from the Stop payload (no race);
// fall back to parsing the transcript on older Claude Code versions.
function finalAssistantText(payload) {
  return (
    payload.last_assistant_message ||
    payload.assistant_message ||
    getLastAssistantMessage(payload.transcript_path) ||
    ''
  );
}

// Short human detail for a permission prompt (the command / file in question).
function permissionDetail(payload) {
  const ti = payload.tool_input || {};
  return ti.command || ti.file_path || ti.path || ti.url || ti.pattern || '';
}

function quoteLine(base, text) {
  if (!text) return base;
  const budget = MAX_CONTENT - base.length - 4; // room for "\n> "
  const quoted = '> ' + truncate(String(text).replace(/\r?\n+/g, ' '), Math.max(0, budget)).trim();
  return base + '\n' + quoted;
}

function buildContent(payload, config) {
  const machine = config.machineName || os.hostname();
  const cwd = payload.cwd || process.cwd();
  const project = path.basename(cwd) || cwd;
  const event = payload.hook_event_name || '';
  const head = `**${machine}** / \`${project}\``;

  // 🔴 Claude is blocked waiting for you to approve a tool.
  if (event === 'PermissionRequest') {
    const tool = payload.tool_name || 'a tool';
    return truncate(quoteLine(`🔴 ${head} — approve **${tool}**?`, permissionDetail(payload)), MAX_CONTENT);
  }
  // 🟢 Turn finished — it's your move.
  if (event === 'Stop' || event === 'SubagentStop') {
    return truncate(quoteLine(`🟢 ${head} — done`, finalAssistantText(payload)), MAX_CONTENT);
  }
  // Fallback: Notification (no longer registered by default, kept defensively).
  if (event === 'Notification') {
    return truncate(`🔔 ${head} — ${payload.message || 'needs your attention'}`, MAX_CONTENT);
  }
  return truncate(`${head} — ${event || 'event'}`, MAX_CONTENT);
}

// ---------------------------------------------------------------------------
// Hook mode
// ---------------------------------------------------------------------------
function readStdin() {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve('');
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => (data += c));
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', () => resolve(data));
  });
}

async function runHook() {
  const raw = await readStdin();
  let payload = {};
  try { payload = JSON.parse(raw || '{}'); } catch { payload = {}; }

  const config = loadConfig();
  if (!config || !config.botToken || !config.userId) return; // not set up yet

  const event = payload.hook_event_name || '';
  dbg(config, `INVOKED pid=${process.pid} event=${event} sid=${payload.session_id || '?'}`);
  dbg(config, `  RAW ${truncate(raw.replace(/\s+/g, ' '), 1800)}`);
  if (config.events && config.events[event] === false) return; // per-event opt-out
  if (event === 'Notification' && isIgnoredNotification(payload.message, config)) return;
  if (isThrottled(config, event)) return;

  const content = buildContent(payload, config);
  try {
    await sendDm(config, content);
    markSent(config, event);
    dbg(config, `SENT    pid=${process.pid} event=${event}`);
  } catch (e) {
    dbg(config, `FAILED  pid=${process.pid} event=${event} err=${e && e.message}`);
    /* never surface hook errors to Claude */
  }
}

function runHookMode() {
  // Safety net: whatever happens, exit 0 within a bounded time.
  const timer = setTimeout(() => process.exit(0), HTTP_TIMEOUT_MS + 1500);
  if (timer.unref) timer.unref();
  runHook().catch(() => {}).finally(() => { clearTimeout(timer); process.exit(0); });
}

// ---------------------------------------------------------------------------
// settings.json merge
// ---------------------------------------------------------------------------
// Events we register in settings.json. PermissionRequest = 🔴 blocked on
// approval (the reliable, actionable signal); Stop = 🟢 turn finished.
// We deliberately do NOT hook Notification — it conflates permission prompts
// with idle "waiting for input" and was the source of false alarms.
const HOOK_EVENTS = ['PermissionRequest', 'Stop'];

function hookCommand() {
  return 'node "' + SCRIPT_DEST.replace(/\\/g, '/') + '"';
}

function mergeSettings() {
  let settings = {};
  if (fs.existsSync(SETTINGS_PATH)) {
    let raw;
    try { raw = fs.readFileSync(SETTINGS_PATH, 'utf8').replace(/^﻿/, ''); } catch (e) {
      console.error('  Warning: could not read ' + SETTINGS_PATH + ' (' + e.message + '). Skipping settings merge.');
      return false;
    }
    try { settings = raw.trim() ? JSON.parse(raw) : {}; } catch (e) {
      console.error('  Warning: ' + SETTINGS_PATH + ' is not valid JSON (' + e.message + ').');
      console.error('  Skipping settings merge to avoid clobbering it. Add the hooks manually (see README).');
      return false;
    }
    try { fs.copyFileSync(SETTINGS_PATH, SETTINGS_PATH + '.bak'); } catch { /* best effort */ }
  } else {
    fs.mkdirSync(path.dirname(SETTINGS_PATH), { recursive: true });
  }

  settings.hooks = settings.hooks || {};
  const command = hookCommand();
  // Add our command to the events we use.
  for (const ev of HOOK_EVENTS) {
    const arr = (settings.hooks[ev] = settings.hooks[ev] || []);
    const exists = arr.some((g) => Array.isArray(g.hooks) && g.hooks.some((h) => h && h.command === command));
    if (!exists) arr.push({ matcher: '', hooks: [{ type: 'command', command }] });
  }
  // Migrate: strip our command from any event we no longer use (e.g. the old
  // Notification hook), leaving other tools' hooks untouched.
  for (const ev of Object.keys(settings.hooks)) {
    if (HOOK_EVENTS.includes(ev) || !Array.isArray(settings.hooks[ev])) continue;
    settings.hooks[ev] = settings.hooks[ev]
      .map((g) => ({ ...g, hooks: (g.hooks || []).filter((h) => !(h && h.command === command)) }))
      .filter((g) => g.hooks && g.hooks.length);
    if (!settings.hooks[ev].length) delete settings.hooks[ev];
  }
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2) + '\n');
  return true;
}

// ---------------------------------------------------------------------------
// CLI: install / test / uninstall
// ---------------------------------------------------------------------------
function parseFlags(args) {
  const f = {};
  for (let i = 0; i < args.length; i++) {
    let a = args[i];
    if (!a.startsWith('--')) continue;
    a = a.slice(2);
    let v = true;
    const eq = a.indexOf('=');
    if (eq >= 0) { v = a.slice(eq + 1); a = a.slice(0, eq); }
    else if (i + 1 < args.length && !args[i + 1].startsWith('--')) { v = args[++i]; }
    f[a] = v;
  }
  return f;
}

function prompt(question, def) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const q = def ? `${question} [${def}]: ` : `${question}: `;
  return new Promise((resolve) => rl.question(q, (ans) => { rl.close(); resolve((ans && ans.trim()) || def || ''); }));
}

function promptSecret(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    const q = question + ': ';
    rl.question(q, (ans) => { rl.output.write('\n'); rl.close(); resolve((ans || '').trim()); });
    // Mask typed characters.
    rl._writeToOutput = function (s) {
      if (s.includes(question)) rl.output.write(q);
      else if (s.trim().length === 0) rl.output.write(s);
      else rl.output.write('*');
    };
  });
}

function printDmError(e) {
  const dc = e && e.discord;
  const code = dc && dc.data && dc.data.code;
  const status = dc && dc.status;
  const msg = String((e && e.message) || '');
  console.error('  ' + (e.message || e));
  if (code === 50007 || /mutual guild|cannot send messages to this user/i.test(msg)) {
    console.error('  → Discord is blocking the bot from DMing you. Both must be true:');
    console.error('     1. The bot shares a server with you — invite it to any server you\'re both in');
    console.error('        (a private personal server works fine).');
    console.error('     2. In that server\'s privacy settings, "Direct Messages" from members is allowed.');
  } else if (code === 50033 || code === 50035) {
    console.error('  → The recipient user ID looks wrong. In Discord enable Developer Mode, then');
    console.error('     right-click your name → Copy User ID.');
  } else if (status === 401) {
    console.error('  → The bot token is invalid. Reset it in the Discord Developer Portal → Bot → Reset Token.');
  }
}

async function install(args) {
  const flags = parseFlags(args);
  const existing = loadConfig() || {};
  const interactive = !flags['no-input'];

  let token = (typeof flags.token === 'string' && flags.token) || existing.botToken || '';
  let userId = (typeof flags.user === 'string' && flags.user) || existing.userId || DEFAULT_USER_ID;
  let machineName = (typeof flags.name === 'string' && flags.name) || existing.machineName || os.hostname();
  let throttle = flags.throttle != null && flags.throttle !== true ? Number(flags.throttle) : (existing.throttleSeconds || 0);

  if (interactive) {
    if (!token) token = await promptSecret('Discord bot token (input hidden)');
    userId = await prompt('Your Discord user ID (DM recipient)', userId);
    machineName = await prompt('Machine name (shown in messages)', machineName);
  }
  if (!token) {
    console.error('A bot token is required. Pass --token <token> or run without --no-input.');
    process.exit(1);
  }

  fs.mkdirSync(HOOKS_DIR, { recursive: true });
  if (path.resolve(__filename) !== path.resolve(SCRIPT_DEST)) {
    fs.copyFileSync(__filename, SCRIPT_DEST);
  }

  // Start from the existing config so custom fields (debug, events,
  // ignoreNotificationPatterns, …) survive a re-install; overwrite only the
  // fields this installer manages.
  const config = {
    ...existing,
    botToken: token,
    userId,
    machineName,
    throttleSeconds: Number.isFinite(throttle) ? throttle : 0,
  };
  // Drop the cached DM channel if the recipient changed (it's user-specific).
  if (!(existing.dmChannelId && existing.userId === userId)) delete config.dmChannelId;
  saveConfig(config);

  const merged = mergeSettings();

  process.stdout.write('Sending a test DM... ');
  let ok = false;
  try {
    await sendDm(config, `✅ Claude Code notifier is set up on **${machineName}**. You'll get a DM when Claude needs you or finishes a turn.`);
    saveConfig(config); // persist dmChannelId cache
    console.log('sent! Check your Discord DMs.');
    ok = true;
  } catch (e) {
    console.log('failed.');
    printDmError(e);
  }

  console.log('\nInstalled:');
  console.log('  script:   ' + SCRIPT_DEST);
  console.log('  config:   ' + CONFIG_PATH + '  (contains the bot token; chmod 600)');
  console.log('  settings: ' + SETTINGS_PATH + (merged ? '  (PermissionRequest + Stop hooks)' : '  (NOT updated — see warning above)'));
  if (!ok) {
    console.log('\nConfig is saved; fix the DM issue above, then verify with:');
    console.log('  node "' + SCRIPT_DEST.replace(/\\/g, '/') + '" test');
  }
}

async function testCmd() {
  const config = loadConfig();
  if (!config) {
    console.error('No config found at ' + CONFIG_PATH + '. Run: node discord-notify.js install');
    process.exit(1);
  }
  process.stdout.write('Sending a test DM... ');
  try {
    await sendDm(config, `🔔 Test DM from the Claude Code notifier on **${config.machineName || os.hostname()}**.`);
    saveConfig(config);
    console.log('sent! Check your Discord DMs.');
  } catch (e) {
    console.log('failed.');
    printDmError(e);
    process.exit(1);
  }
}

function uninstall(args) {
  const flags = parseFlags(args);
  const command = hookCommand();
  if (fs.existsSync(SETTINGS_PATH)) {
    try {
      const raw = fs.readFileSync(SETTINGS_PATH, 'utf8').replace(/^﻿/, '');
      const s = raw.trim() ? JSON.parse(raw) : {};
      if (s.hooks) {
        for (const ev of Object.keys(s.hooks)) {
          if (!Array.isArray(s.hooks[ev])) continue;
          s.hooks[ev] = s.hooks[ev]
            .map((g) => ({ ...g, hooks: (g.hooks || []).filter((h) => !(h && h.command === command)) }))
            .filter((g) => g.hooks && g.hooks.length);
          if (!s.hooks[ev].length) delete s.hooks[ev];
        }
        if (!Object.keys(s.hooks).length) delete s.hooks;
      }
      fs.writeFileSync(SETTINGS_PATH, JSON.stringify(s, null, 2) + '\n');
      console.log('Removed notifier hook entries from ' + SETTINGS_PATH);
    } catch (e) {
      console.error('Could not update settings: ' + e.message);
    }
  }
  if (flags.purge) {
    for (const p of [CONFIG_PATH, STATE_PATH, SCRIPT_DEST]) {
      try { if (fs.existsSync(p)) fs.unlinkSync(p); } catch { /* ignore */ }
    }
    console.log('Purged config, state, and the installed script copy.');
  } else {
    console.log('Left config at ' + CONFIG_PATH + ' (re-run with --purge to delete it and the script copy).');
  }
}

function printHelp() {
  console.log(`discord-notify.js — Claude Code -> Discord DM notifier

Usage:
  node discord-notify.js install [--token T] [--user ID] [--name NAME] [--throttle SECONDS] [--no-input]
  node discord-notify.js test
  node discord-notify.js uninstall [--purge]
  node discord-notify.js help

As a hook it reads Claude Code event JSON on stdin and DMs you. It always
exits 0 so it can never hang or break a session.

Config lives at: ${CONFIG_PATH}
Installs into:   ${SETTINGS_PATH} (PermissionRequest + Stop hooks)`);
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------
function main() {
  const sub = process.argv[2];
  if (sub === 'install') {
    install(process.argv.slice(3)).catch((e) => { console.error(e); process.exit(1); });
  } else if (sub === 'test') {
    testCmd();
  } else if (sub === 'uninstall') {
    uninstall(process.argv.slice(3));
  } else if (sub === 'help' || sub === '--help' || sub === '-h') {
    printHelp();
  } else {
    runHookMode();
  }
}

if (require.main === module) {
  main();
} else {
  // Imported as a module (e.g. for testing) — expose the pure helpers.
  module.exports = { buildContent, getLastAssistantMessage, truncate, parseFlags, hookCommand, isIgnoredNotification };
}
