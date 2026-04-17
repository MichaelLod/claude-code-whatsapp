#!/usr/bin/env node
/**
 * WhatsApp daemon — v0.1.0
 *
 * Single Baileys connection, fanout to N Claude Code sessions via Unix socket.
 * Solves WhatsApp's 4-linked-device cap when running multiple Claude terminals.
 *
 * Architecture:
 *   Phone  ↔  Baileys  ↔  wa-daemon.cjs  ↔  /tmp/claude-wa.sock  ↔  N x session-client.cjs  ↔  MCP stdio  ↔  N x Claude Code
 *
 * Connection stability logic preserved from upstream (server.cjs v0.0.3 OpenClaw-derived):
 *   - 515 is a normal restart, reconnect in 2s
 *   - 440 (conflict) / 401 (logout) stop permanently
 *   - Exponential backoff with jitter, reset after healthy period
 *   - Watchdog detects stale connections
 *   - Creds backup/restore
 */

const net = require("net");
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const {
  makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  downloadMediaMessage,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
} = require("@whiskeysockets/baileys");
const pino = require("pino");
const qrcode = require("qrcode-terminal");

// ── Config ──────────────────────────────────────────────────────────

const STATE_DIR = process.env.WHATSAPP_STATE_DIR || path.join(os.homedir(), ".claude", "channels", "whatsapp");
const ACCESS_FILE = path.join(STATE_DIR, "access.json");
const AUTH_DIR = path.join(STATE_DIR, "auth");
const INBOX_DIR = path.join(STATE_DIR, "inbox");
const LOG_FILE = path.join(STATE_DIR, "daemon.log");
const PID_FILE = path.join(STATE_DIR, "daemon.pid");
const PANIC_FILE = path.join(STATE_DIR, "PANIC");
const SOCKET_PATH = process.env.WA_DAEMON_SOCKET || "/tmp/claude-wa.sock";

fs.mkdirSync(AUTH_DIR, { recursive: true, mode: 0o700 });
fs.mkdirSync(INBOX_DIR, { recursive: true });
try { fs.chmodSync(STATE_DIR, 0o700); } catch {}

const logger = pino({ level: "silent" });

const logStream = (() => {
  try { return fs.createWriteStream(LOG_FILE, { flags: "a" }); } catch { return null; }
})();

function log(msg) {
  const line = `${new Date().toISOString()} [daemon] ${msg}\n`;
  if (logStream) logStream.write(line);
  process.stderr.write(line);
}

// Permission-reply spec from claude-cli-internal channelPermissions.ts
const PERMISSION_REPLY_RE = /^\s*(y|yes|n|no)\s+([a-km-z]{5})\s*$/i;

const RECONNECT = { initialMs: 2000, maxMs: 30000, factor: 1.8, jitter: 0.25 };
const WATCHDOG_INTERVAL = 60 * 1000;
const STALE_TIMEOUT = 30 * 60 * 1000;
const HEALTHY_THRESHOLD = 60 * 1000;

const OUTBOUND_TRACK_TTL = 60 * 60 * 1000;
const PERMISSION_TTL = 10 * 60 * 1000;
const OUTBOUND_RATE_MAX = 20;
const OUTBOUND_RATE_WINDOW = 60 * 1000;

// ── Singleton lock ──────────────────────────────────────────────────

function acquirePidLock() {
  try {
    const existing = Number(fs.readFileSync(PID_FILE, "utf8").trim());
    if (existing && existing !== process.pid) {
      try {
        process.kill(existing, 0);
        log(`daemon already running (pid ${existing}) — exiting`);
        process.exit(0);
      } catch {
        // stale pid, fall through
      }
    }
  } catch {}
  fs.writeFileSync(PID_FILE, String(process.pid), { mode: 0o644 });
}

// ── Access Control ──────────────────────────────────────────────────

function defaultAccess() {
  return { allowFrom: [], allowGroups: false, allowedGroups: [], requireAllowFromInGroups: false, confirmToken: null };
}

function loadAccess() {
  try {
    const parsed = JSON.parse(fs.readFileSync(ACCESS_FILE, "utf8"));
    return { ...defaultAccess(), ...parsed };
  } catch (err) {
    if (err.code === "ENOENT") return defaultAccess();
    try { fs.renameSync(ACCESS_FILE, `${ACCESS_FILE}.corrupt-${Date.now()}`); } catch {}
    return defaultAccess();
  }
}

function toJid(phone) {
  if (phone.includes("@")) return phone;
  return `${phone.replace(/[^0-9]/g, "")}@s.whatsapp.net`;
}

function isAllowed(jid, participant) {
  const access = loadAccess();
  const isGroup = jid.endsWith("@g.us");
  if (isGroup) {
    if (!access.allowGroups) return false;
    if (access.allowedGroups.length > 0 && !access.allowedGroups.includes(jid)) return false;
    if (access.requireAllowFromInGroups && participant) {
      return access.allowFrom.some((a) => toJid(a) === participant || a === participant);
    }
    return true;
  }
  if (access.allowFrom.length === 0) return true;
  return access.allowFrom.some((a) => toJid(a) === jid || a === jid);
}

// ── Path safety for outbound files ──────────────────────────────────

function assertSendable(f) {
  try {
    const real = fs.realpathSync(f);
    const stateReal = fs.realpathSync(STATE_DIR);
    const inbox = path.join(stateReal, "inbox");
    if (real.startsWith(stateReal + path.sep) && !real.startsWith(inbox + path.sep)) {
      throw new Error(`refusing to send channel state: ${f}`);
    }
  } catch (e) {
    if (e.message?.startsWith("refusing")) throw e;
  }
}

// ── Message caches ──────────────────────────────────────────────────

const rawMessages = new Map();
const RAW_MSG_CAP = 1000;
const recentMessages = new Map();
const MAX_RECENT = 100;
const seenMessages = new Map();
const SEEN_TTL = 20 * 60 * 1000;
const SEEN_MAX = 5000;

function isDuplicate(key) {
  if (seenMessages.has(key)) return true;
  seenMessages.set(key, Date.now());
  if (seenMessages.size > SEEN_MAX) {
    const now = Date.now();
    for (const [k, t] of seenMessages) if (now - t > SEEN_TTL) seenMessages.delete(k);
  }
  return false;
}

function storeRaw(msg) {
  const id = msg.key?.id;
  if (!id) return;
  rawMessages.set(id, msg);
  if (rawMessages.size > RAW_MSG_CAP) {
    const first = rawMessages.keys().next().value;
    if (first) rawMessages.delete(first);
  }
}

function storeRecent(chatId, entry) {
  if (!recentMessages.has(chatId)) recentMessages.set(chatId, []);
  const arr = recentMessages.get(chatId);
  arr.push(entry);
  if (arr.length > MAX_RECENT) arr.shift();
}

// ── Outbound msg_id → session mapping for quote-reply routing ───────

const outboundTracking = new Map(); // sent_msg_id → { sessionId, ts }

function trackOutbound(msgId, sessionId) {
  if (!msgId || !sessionId) return;
  outboundTracking.set(msgId, { sessionId, ts: Date.now() });
}

function lookupOutbound(msgId) {
  const entry = outboundTracking.get(msgId);
  if (!entry) return null;
  if (Date.now() - entry.ts > OUTBOUND_TRACK_TTL) { outboundTracking.delete(msgId); return null; }
  return entry.sessionId;
}

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of outboundTracking) {
    if (now - v.ts > OUTBOUND_TRACK_TTL) outboundTracking.delete(k);
  }
}, 5 * 60 * 1000).unref();

// ── Pending permissions: request_id → session_id ────────────────────

const pendingPermissions = new Map(); // request_id → { sessionId, ts }

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of pendingPermissions) {
    if (now - v.ts > PERMISSION_TTL) pendingPermissions.delete(k);
  }
}, 60 * 1000).unref();

// ── Creds backup/restore ────────────────────────────────────────────

function maybeRestoreCredsFromBackup() {
  const credsPath = path.join(AUTH_DIR, "creds.json");
  const backupPath = path.join(AUTH_DIR, "creds.json.bak");
  try { JSON.parse(fs.readFileSync(credsPath, "utf8")); return; } catch {}
  try {
    JSON.parse(fs.readFileSync(backupPath, "utf8"));
    fs.copyFileSync(backupPath, credsPath);
    try { fs.chmodSync(credsPath, 0o600); } catch {}
    log("restored creds.json from backup");
  } catch {}
}

let credsSaveQueue = Promise.resolve();
let saveCreds = null;

function enqueueSaveCreds() {
  if (!saveCreds) return;
  credsSaveQueue = credsSaveQueue
    .then(() => {
      const credsPath = path.join(AUTH_DIR, "creds.json");
      const backupPath = path.join(AUTH_DIR, "creds.json.bak");
      try {
        JSON.parse(fs.readFileSync(credsPath, "utf8"));
        fs.copyFileSync(credsPath, backupPath);
        try { fs.chmodSync(backupPath, 0o600); } catch {}
      } catch {}
      return saveCreds();
    })
    .then(() => { try { fs.chmodSync(path.join(AUTH_DIR, "creds.json"), 0o600); } catch {} })
    .catch((err) => {
      log(`creds save error: ${err} — retrying in 1s`);
      setTimeout(enqueueSaveCreds, 1000);
    });
}

// ── Baileys connection ──────────────────────────────────────────────

let sock = null;
let connectionReady = false;
let retryCount = 0;
let connectedAt = 0;
let lastInboundAt = 0;
let watchdogTimer = null;

function computeDelay(attempt) {
  const base = Math.min(RECONNECT.initialMs * Math.pow(RECONNECT.factor, attempt), RECONNECT.maxMs);
  const jitter = base * RECONNECT.jitter * (Math.random() * 2 - 1);
  return Math.max(250, Math.round(base + jitter));
}

function cleanupSocket() {
  if (watchdogTimer) { clearInterval(watchdogTimer); watchdogTimer = null; }
  if (sock) {
    try { sock.ev.removeAllListeners(); } catch {}
    try { sock.end(undefined); } catch {}
    sock = null;
  }
  connectionReady = false;
  broadcastConnectionStatus(false);
}

async function connectWhatsApp() {
  cleanupSocket();
  maybeRestoreCredsFromBackup();

  const authState = await useMultiFileAuthState(AUTH_DIR);
  saveCreds = authState.saveCreds;
  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    auth: {
      creds: authState.state.creds,
      keys: makeCacheableSignalKeyStore(authState.state.keys, logger),
    },
    version,
    logger,
    printQRInTerminal: false,
    browser: ["Mac OS", "Safari", "1.0.0"],
    syncFullHistory: false,
    markOnlineOnConnect: false,
    getMessage: async (key) => {
      const cached = rawMessages.get(key.id);
      if (cached?.message) return cached.message;
      return { conversation: "" };
    },
  });

  sock.ev.on("creds.update", enqueueSaveCreds);

  sock.ev.on("connection.update", (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      qrcode.generate(qr, { small: true }, (code) => {
        log("scan QR code with WhatsApp > Linked Devices > Link a Device");
        process.stderr.write(code + "\n");
      });
    }

    if (connection === "close") {
      connectionReady = false;
      broadcastConnectionStatus(false);
      const reason = lastDisconnect?.error?.output?.statusCode;

      if (reason === 440) { log("session conflict (440) — re-link required"); return; }
      if (reason === DisconnectReason.loggedOut) { log("logged out (401) — re-pair needed"); return; }
      if (reason === 515) { log("WhatsApp restart (515) — reconnecting in 2s"); setTimeout(connectWhatsApp, 2000); return; }

      if (connectedAt && Date.now() - connectedAt > HEALTHY_THRESHOLD) retryCount = 0;
      if (retryCount >= 15) { log("max retries — waiting 5 min"); retryCount = 0; setTimeout(connectWhatsApp, 5 * 60 * 1000); return; }

      const delay = computeDelay(retryCount);
      retryCount++;
      log(`connection closed (${reason}), retry ${retryCount} in ${delay}ms`);
      setTimeout(connectWhatsApp, delay);
    }

    if (connection === "open") {
      connectionReady = true;
      connectedAt = Date.now();
      retryCount = 0;
      log("connected");
      broadcastConnectionStatus(true);
      if (watchdogTimer) clearInterval(watchdogTimer);
      watchdogTimer = setInterval(() => {
        if (!connectionReady) return;
        if (lastInboundAt && Date.now() - lastInboundAt > STALE_TIMEOUT) {
          log(`no messages in ${STALE_TIMEOUT / 60000}min — forcing reconnect`);
          connectWhatsApp();
        }
      }, WATCHDOG_INTERVAL);
    }
  });

  if (sock.ws && typeof sock.ws.on === "function") {
    sock.ws.on("error", (err) => log(`WebSocket error: ${err}`));
  }

  sock.ev.on("messages.upsert", async ({ messages }) => {
    for (const msg of messages) {
      if (!msg.message) continue;
      if (msg.key.fromMe) continue;
      const jid = msg.key.remoteJid;
      if (!jid) continue;
      if (jid.endsWith("@broadcast") || jid.endsWith("@status")) continue;
      const msgId = msg.key.id;
      const participant = msg.key.participant;
      if (msgId && isDuplicate(`${jid}:${msgId}`)) continue;
      if (!isAllowed(jid, participant || undefined)) continue;
      try { await sock.readMessages([msg.key]); } catch {}
      lastInboundAt = Date.now();
      storeRaw(msg);
      try { await handleInbound(msg, jid, participant || undefined); } catch (e) { log(`handleInbound error: ${e}`); }
    }
  });
}

// ── Message helpers ─────────────────────────────────────────────────

function extractText(msg) {
  return (
    msg.conversation ||
    msg.extendedTextMessage?.text ||
    msg.imageMessage?.caption ||
    msg.videoMessage?.caption ||
    msg.documentMessage?.caption ||
    ""
  );
}

function extractMediaInfo(msg) {
  if (msg.imageMessage) return { type: "image", mimetype: msg.imageMessage.mimetype || "image/jpeg", size: Number(msg.imageMessage.fileLength) || 0 };
  if (msg.videoMessage) return { type: "video", mimetype: msg.videoMessage.mimetype || "video/mp4", size: Number(msg.videoMessage.fileLength) || 0 };
  if (msg.audioMessage) return { type: "audio", mimetype: msg.audioMessage.mimetype || "audio/ogg", size: Number(msg.audioMessage.fileLength) || 0 };
  if (msg.documentMessage) return { type: "document", mimetype: msg.documentMessage.mimetype || "application/octet-stream", size: Number(msg.documentMessage.fileLength) || 0, filename: msg.documentMessage.fileName };
  if (msg.stickerMessage) return { type: "sticker", mimetype: msg.stickerMessage.mimetype || "image/webp", size: Number(msg.stickerMessage.fileLength) || 0 };
  return null;
}

function mimeToExt(mimetype) {
  const map = {
    "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif",
    "video/mp4": "mp4", "audio/ogg; codecs=opus": "ogg", "audio/ogg": "ogg",
    "audio/mpeg": "mp3", "audio/mp4": "m4a", "application/pdf": "pdf",
  };
  return map[mimetype] || "bin";
}

function formatJid(jid) {
  return jid.replace(/@s\.whatsapp\.net$/, "").replace(/@g\.us$/, "").replace(/@lid$/, "").replace(/:\d+$/, "");
}

function getQuotedStanzaId(msg) {
  return msg?.extendedTextMessage?.contextInfo?.stanzaId
    || msg?.imageMessage?.contextInfo?.stanzaId
    || msg?.videoMessage?.contextInfo?.stanzaId
    || msg?.documentMessage?.contextInfo?.stanzaId
    || null;
}

// ── Session registry ────────────────────────────────────────────────

const sessions = new Map(); // sessionId → { socket, pid, cwd, tag, lastSeen }
const socketToSession = new WeakMap(); // socket → sessionId
let activeSessionId = null;

function registerSession(sock, { sessionId, pid, cwd, tag }) {
  const prev = sessions.get(sessionId);
  if (prev && prev.socket && prev.socket !== sock) {
    try { prev.socket.end(); } catch {}
  }
  sessions.set(sessionId, { socket: sock, pid, cwd, tag, lastSeen: Date.now() });
  socketToSession.set(sock, sessionId);
  if (!activeSessionId) activeSessionId = sessionId; // first session = default active
  log(`session registered: ${sessionId.slice(0, 8)} pid=${pid} tag=${tag} cwd=${cwd}`);
}

function unregisterSession(sessionId) {
  const s = sessions.get(sessionId);
  if (!s) return;
  sessions.delete(sessionId);
  if (activeSessionId === sessionId) {
    const next = sessions.keys().next().value;
    activeSessionId = next || null;
  }
  log(`session unregistered: ${sessionId.slice(0, 8)}`);
}

function findSessionsByTag(tag) {
  const lower = tag.toLowerCase();
  const exact = [];
  const prefix = [];
  for (const [id, s] of sessions) {
    const t = (s.tag || "").toLowerCase();
    if (t === lower) exact.push(id);
    else if (t.startsWith(lower)) prefix.push(id);
  }
  return exact.length ? exact : prefix;
}

// ── IPC protocol ────────────────────────────────────────────────────

function sendFrame(sock, obj) {
  if (!sock || sock.destroyed) return;
  try { sock.write(JSON.stringify(obj) + "\n"); } catch (e) { log(`write failed: ${e}`); }
}

function ack(sock, reqId, data) {
  if (reqId) sendFrame(sock, { op: "ack", req_id: reqId, ok: true, data: data || {} });
}

function err(sock, reqId, message) {
  if (reqId) sendFrame(sock, { op: "ack", req_id: reqId, ok: false, error: String(message) });
}

function broadcastConnectionStatus(connected) {
  for (const { socket } of sessions.values()) {
    sendFrame(socket, { op: "connection_status", connected });
  }
}

// ── Inbound routing ─────────────────────────────────────────────────

async function handleInbound(msg, jid, participant) {
  const message = msg.message;
  const text = extractText(message);
  const media = extractMediaInfo(message);
  const msgId = msg.key.id || `${Date.now()}`;
  const isGroup = jid.endsWith("@g.us");
  const senderJid = participant || jid;
  const senderNumber = formatJid(senderJid);

  storeRecent(jid, {
    id: msgId, from: senderNumber,
    text: text || (media ? `(${media.type})` : ""),
    ts: (Number(msg.messageTimestamp) || Date.now() / 1000) * 1000,
    hasMedia: !!media, mediaType: media?.type,
  });

  // 1. Permission reply?
  const permMatch = PERMISSION_REPLY_RE.exec(text);
  if (permMatch) {
    const behavior = permMatch[1].toLowerCase().startsWith("y") ? "allow" : "deny";
    const request_id = permMatch[2].toLowerCase();
    const pending = pendingPermissions.get(request_id);
    if (pending) {
      const session = sessions.get(pending.sessionId);
      if (session?.socket) {
        sendFrame(session.socket, {
          op: "permission_response",
          request_id, behavior,
        });
      }
      pendingPermissions.delete(request_id);
    }
    try { await sock.sendMessage(jid, { react: { text: behavior === "allow" ? "✅" : "❌", key: msg.key } }); } catch {}
    return;
  }

  // Build base content + meta
  let content = text || (media ? `(${media.type})` : "(empty)");
  const meta = {
    chat_id: jid, message_id: msgId, user: senderNumber,
    ts: new Date((Number(msg.messageTimestamp) || Date.now() / 1000) * 1000).toISOString(),
    origin: "whatsapp",
  };
  if (media) {
    const kb = (media.size / 1024).toFixed(0);
    const name = media.filename || `${media.type}.${mimeToExt(media.mimetype)}`;
    meta.attachment_count = "1";
    meta.attachments = `${name} (${media.mimetype}, ${kb}KB)`;
  }
  if (isGroup) meta.group = "true";

  // 2. Routing classification
  let targets = []; // list of session IDs
  let routedBy = null;

  const hashMatch = /^#([a-zA-Z0-9_-]+)\s+([\s\S]*)$/.exec(text);
  const allMatch = /^!all\s+([\s\S]*)$/i.exec(text);
  const quotedId = getQuotedStanzaId(message);

  if (hashMatch) {
    const tag = hashMatch[1];
    const stripped = hashMatch[2];
    targets = findSessionsByTag(tag);
    if (targets.length) { content = stripped; meta.route_tag = tag; routedBy = "tag"; }
  }

  if (!targets.length && allMatch) {
    content = allMatch[1];
    targets = [...sessions.keys()];
    meta.route_broadcast = "true";
    routedBy = "broadcast";
  }

  if (!targets.length && quotedId) {
    const sid = lookupOutbound(quotedId);
    if (sid && sessions.has(sid)) {
      targets = [sid];
      meta.route_quoted = quotedId;
      routedBy = "quoted";
    }
  }

  if (!targets.length) {
    if (activeSessionId && sessions.has(activeSessionId)) {
      targets = [activeSessionId];
      routedBy = "active";
    }
  }

  if (!targets.length) {
    log(`inbound dropped (no route): ${text.slice(0, 60)}`);
    try { await sock.sendMessage(jid, { react: { text: "❓", key: msg.key } }); } catch {}
    return;
  }

  // Confirm-token gate: if access.json defines confirmToken and the (possibly
  // routing-stripped) content starts with it, strip and mark origin_confirmed.
  // Signal to Claude that destructive operations are authorized.
  const access = loadAccess();
  if (access.confirmToken) {
    const tokenRe = new RegExp(`^\\s*${access.confirmToken.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s+`);
    if (tokenRe.test(content)) {
      content = content.replace(tokenRe, "");
      meta.origin_confirmed = "true";
    } else {
      meta.origin_confirmed = "false";
    }
  }

  log(`inbound routed via ${routedBy} → ${targets.length} session(s): ${text.slice(0, 60)}`);
  for (const sid of targets) {
    const session = sessions.get(sid);
    if (!session?.socket) continue;
    sendFrame(session.socket, {
      op: "inbound",
      to_session: sid,
      content,
      meta: { ...meta, to_session: sid },
    });
  }
}

// ── Outbound: permission request (Claude → WhatsApp) ────────────────

async function sendPermissionRequest(sessionId, { request_id, tool_name, description, input_preview }) {
  if (!sock || !connectionReady) throw new Error("WhatsApp not connected");
  const session = sessions.get(sessionId);
  const tag = session?.tag || "?";
  const access = loadAccess();
  const text = `🔐 [${tag}] Permission request [${request_id}]\n\n` +
    `${tool_name}: ${description}\n` +
    `${input_preview}\n\n` +
    `Reply "yes ${request_id}" or "no ${request_id}"`;
  pendingPermissions.set(request_id, { sessionId, ts: Date.now() });
  for (const phone of access.allowFrom) {
    const jid = toJid(phone);
    try { await sock.sendMessage(jid, { text }); } catch (e) { log(`permission_request send to ${jid} failed: ${e}`); }
  }
}

// ── Outbound rate limit ─────────────────────────────────────────────

const outboundCounters = new Map(); // sessionId → [timestamps]

function checkOutboundRate(sessionId) {
  const now = Date.now();
  let arr = outboundCounters.get(sessionId);
  if (!arr) { arr = []; outboundCounters.set(sessionId, arr); }
  while (arr.length && now - arr[0] > OUTBOUND_RATE_WINDOW) arr.shift();
  if (arr.length >= OUTBOUND_RATE_MAX) return false;
  arr.push(now);
  return true;
}

// ── Outbound: reply / react / download / fetch ──────────────────────

async function handleReply(sessionId, { chat_id, text, reply_to, files }) {
  if (!sock || !connectionReady) throw new Error("WhatsApp not connected");
  if (!checkOutboundRate(sessionId)) throw new Error(`outbound rate limit exceeded (${OUTBOUND_RATE_MAX}/min)`);
  files = files || [];
  for (const f of files) {
    assertSendable(f);
    if (fs.statSync(f).size > 64 * 1024 * 1024) throw new Error(`file too large: ${f}`);
  }
  const quoted = reply_to ? rawMessages.get(reply_to) : undefined;
  let lastSentId = null;
  if (text) {
    const sent = await sock.sendMessage(chat_id, { text }, quoted ? { quoted } : undefined);
    lastSentId = sent?.key?.id || null;
    if (lastSentId) trackOutbound(lastSentId, sessionId);
  }
  for (const f of files) {
    const ext = path.extname(f).toLowerCase();
    const buf = fs.readFileSync(f);
    let sent;
    if ([".jpg", ".jpeg", ".png", ".gif", ".webp"].includes(ext)) {
      sent = await sock.sendMessage(chat_id, { image: buf });
    } else if ([".ogg", ".mp3", ".m4a", ".wav"].includes(ext)) {
      sent = await sock.sendMessage(chat_id, { audio: buf, mimetype: ext === ".ogg" ? "audio/ogg; codecs=opus" : "audio/mpeg", ptt: ext === ".ogg" });
    } else if ([".mp4", ".mov", ".avi"].includes(ext)) {
      sent = await sock.sendMessage(chat_id, { video: buf });
    } else {
      sent = await sock.sendMessage(chat_id, { document: buf, mimetype: "application/octet-stream", fileName: path.basename(f) });
    }
    const id = sent?.key?.id;
    if (id) { trackOutbound(id, sessionId); lastSentId = id; }
  }
  return { message_id: lastSentId };
}

async function handleReact(sessionId, { chat_id, message_id, emoji }) {
  if (!sock || !connectionReady) throw new Error("WhatsApp not connected");
  await sock.sendMessage(chat_id, { react: { text: emoji, key: { remoteJid: chat_id, id: message_id } } });
  return { ok: true };
}

async function handleDownload({ message_id }) {
  const raw = rawMessages.get(message_id);
  if (!raw?.message) throw new Error("message not found in cache");
  const media = extractMediaInfo(raw.message);
  if (!media) throw new Error("message has no attachments");
  const buffer = await downloadMediaMessage(raw, "buffer", {}, { logger, reuploadRequest: sock.updateMediaMessage });
  const ext = mimeToExt(media.mimetype);
  const filename = media.filename || `${Date.now()}.${ext}`;
  const filePath = path.join(INBOX_DIR, `${Date.now()}-${filename}`);
  fs.writeFileSync(filePath, buffer);
  return { path: filePath, type: media.type, bytes: buffer.length };
}

function handleFetchMessages({ chat_id, limit }) {
  const cap = Math.min(limit || 20, 100);
  const msgs = recentMessages.get(chat_id) || [];
  return { messages: msgs.slice(-cap) };
}

// ── IPC server ──────────────────────────────────────────────────────

function startIpcServer() {
  try { fs.unlinkSync(SOCKET_PATH); } catch {}
  const server = net.createServer((c) => {
    c.setEncoding("utf8");
    let buf = "";

    // Enforce same-uid: Unix peer credentials aren't exposed by node,
    // but socket file is mode 0700 and owned by this user — that's the gate.

    c.on("data", (chunk) => {
      buf += chunk;
      let idx;
      while ((idx = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        if (line.trim()) handleFrame(c, line).catch((e) => log(`frame handler error: ${e}`));
      }
    });

    c.on("close", () => {
      const sid = socketToSession.get(c);
      if (sid) unregisterSession(sid);
    });
    c.on("error", (e) => log(`client socket error: ${e.message}`));
  });

  server.listen(SOCKET_PATH, () => {
    try { fs.chmodSync(SOCKET_PATH, 0o700); } catch {}
    log(`ipc listening at ${SOCKET_PATH}`);
  });

  server.on("error", (e) => {
    log(`ipc server error: ${e}`);
    process.exit(1);
  });

  return server;
}

async function handleFrame(clientSock, line) {
  let frame;
  try { frame = JSON.parse(line); } catch { return err(clientSock, null, "bad json"); }
  const reqId = frame.req_id;
  const op = frame.op;

  switch (op) {
    case "register": {
      registerSession(clientSock, {
        sessionId: frame.session_id,
        pid: frame.pid,
        cwd: frame.cwd,
        tag: frame.tag,
      });
      sendFrame(clientSock, { op: "registered", session_id: frame.session_id, connected: connectionReady });
      return;
    }
    case "unregister": {
      unregisterSession(frame.session_id);
      ack(clientSock, reqId, {});
      return;
    }
    case "claim_active": {
      if (!sessions.has(frame.session_id)) return err(clientSock, reqId, "session not registered");
      activeSessionId = frame.session_id;
      log(`active session claimed: ${activeSessionId.slice(0, 8)}`);
      ack(clientSock, reqId, { active: activeSessionId });
      return;
    }
    case "release_active": {
      if (activeSessionId === frame.session_id) {
        activeSessionId = [...sessions.keys()].find((k) => k !== frame.session_id) || null;
        log(`active session released; now: ${activeSessionId ? activeSessionId.slice(0, 8) : "none"}`);
      }
      ack(clientSock, reqId, { active: activeSessionId });
      return;
    }
    case "list_sessions": {
      const list = [...sessions.entries()].map(([id, s]) => ({
        session_id: id, tag: s.tag, cwd: s.cwd, pid: s.pid, active: id === activeSessionId,
      }));
      ack(clientSock, reqId, { sessions: list, connected: connectionReady });
      return;
    }
    case "reply": {
      try {
        const sid = frame.from_session || socketToSession.get(clientSock);
        const data = await handleReply(sid, frame);
        ack(clientSock, reqId, data);
      } catch (e) { err(clientSock, reqId, e.message || e); }
      return;
    }
    case "react": {
      try {
        const sid = frame.from_session || socketToSession.get(clientSock);
        const data = await handleReact(sid, frame);
        ack(clientSock, reqId, data);
      } catch (e) { err(clientSock, reqId, e.message || e); }
      return;
    }
    case "download_attachment": {
      try {
        const data = await handleDownload(frame);
        ack(clientSock, reqId, data);
      } catch (e) { err(clientSock, reqId, e.message || e); }
      return;
    }
    case "fetch_messages": {
      try {
        const data = handleFetchMessages(frame);
        ack(clientSock, reqId, data);
      } catch (e) { err(clientSock, reqId, e.message || e); }
      return;
    }
    case "permission_request": {
      try {
        const sid = frame.from_session || socketToSession.get(clientSock);
        await sendPermissionRequest(sid, frame);
        ack(clientSock, reqId, {});
      } catch (e) { err(clientSock, reqId, e.message || e); }
      return;
    }
    case "ping": {
      ack(clientSock, reqId, { pong: true });
      return;
    }
    default:
      err(clientSock, reqId, `unknown op: ${op}`);
  }
}

// ── Startup ─────────────────────────────────────────────────────────

process.on("unhandledRejection", (e) => {
  const msg = String(e).toLowerCase();
  if ((msg.includes("unable to authenticate data") || msg.includes("bad mac")) &&
      (msg.includes("baileys") || msg.includes("noise-handler") || msg.includes("signal"))) {
    log("Baileys crypto error — forcing reconnect");
    setTimeout(connectWhatsApp, 2000);
    return;
  }
  log(`unhandled rejection: ${e}`);
});
process.on("uncaughtException", (e) => log(`uncaught exception: ${e}`));
process.setMaxListeners(100);

let shuttingDown = false;
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  log("shutting down");
  cleanupSocket();
  try { fs.unlinkSync(SOCKET_PATH); } catch {}
  try { fs.unlinkSync(PID_FILE); } catch {}
  setTimeout(() => process.exit(0), 1000);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

// PANIC file kill-switch
setInterval(() => {
  try { fs.accessSync(PANIC_FILE); log("PANIC file present — shutting down"); shutdown(); } catch {}
}, 5000).unref();

async function main() {
  acquirePidLock();
  startIpcServer();
  await connectWhatsApp();
}

main().catch((e) => { log(`fatal: ${e}`); process.exit(1); });
