#!/usr/bin/env node
// Standalone WhatsApp pairing — run once to link this machine to the WA account.
// Usage: WHATSAPP_STATE_DIR=~/.claude/channels/whatsapp node pair.cjs
// Optional: PAIR_PHONE="<E.164 number>" enables pairing-code flow (else QR only).
const { default: makeWASocket, useMultiFileAuthState, makeCacheableSignalKeyStore, fetchLatestBaileysVersion, DisconnectReason } = require("@whiskeysockets/baileys");
const qrcode = require("qrcode-terminal");
const pino = require("pino");
const path = require("path");
const os = require("os");

const STATE_DIR = process.env.WHATSAPP_STATE_DIR || path.join(os.homedir(), ".claude", "channels", "whatsapp");
const AUTH_DIR = path.join(STATE_DIR, "auth");
const PAIR_PHONE = process.env.PAIR_PHONE || null;

console.log("WhatsApp pairing — auth dir:", AUTH_DIR);
console.log("Connecting...\n");

(async () => {
  require("fs").mkdirSync(AUTH_DIR, { recursive: true, mode: 0o700 });
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();
  const logger = pino({ level: "silent" });

  const sock = makeWASocket({
    auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, logger) },
    version,
    logger,
    browser: ["Mac OS", "Safari", "1.0.0"],
    syncFullHistory: false,
    markOnlineOnConnect: false,
  });

  sock.ev.on("creds.update", saveCreds);

  // Request pairing code (phone-based, optional alternative to QR)
  if (!state.creds.registered && PAIR_PHONE) {
    setTimeout(async () => {
      try {
        const code = await sock.requestPairingCode(PAIR_PHONE);
        console.log(`\n📱 PAIRING CODE: ${code}\n`);
        console.log("WhatsApp > Linked Devices > Link a Device > Link with phone number");
        console.log("Enter the code above.\n");
      } catch (e) {
        console.error("Pairing code failed, waiting for QR instead...");
      }
    }, 3000);
  }

  sock.ev.on("connection.update", (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      qrcode.generate(qr, { small: true }, (code) => {
        console.log("\n📱 Or scan this QR:\n");
        console.log(code);
      });
    }

    if (connection === "open") {
      console.log("\n✅ WhatsApp connected! Auth saved. Closing in 3s...");
      setTimeout(() => process.exit(0), 3000);
    }

    if (connection === "close") {
      const reason = lastDisconnect?.error?.output?.statusCode;
      if (reason === DisconnectReason.loggedOut || reason === 440 || reason === 515) {
        console.log(`❌ Error ${reason}. Delete auth/ and try again after a few minutes.`);
        process.exit(1);
      }
      console.log(`Connection closed (${reason}), retrying...`);
      setTimeout(() => process.exit(1), 1000);
    }
  });
})();
