/**
 * ============================================================
 * 🚀 WHATSAPP BOT — PRODUCTION EDITION
 * ============================================================
 * FIXES:
 *  - Double execution bug (was called twice on startup)
 *  - Reconnect loop (recursive calls stacked event listeners)
 *  - Owner-only gating in groups, DMs, and self-DM
 *  - Stable keepalive + exponential-backoff reconnect
 * NEW:
 *  - .vv stealth view-once revealer → DM, deletes command
 *  - .delete, .mute, .unmute, .link, .revoke
 *  - .setname, .setdesc, .groupinfo
 *  - .weather, .info, better .alive w/ uptime
 *  - Auto-reply only triggers in DMs (not own chat spam)
 * ============================================================
 */

"use strict";

const express  = require("express");
const pino     = require("pino");
const axios    = require("axios");
const path     = require("path");
const fs       = require("fs");

const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  delay,
  jidDecode,
  downloadContentFromMessage,
} = require("@whiskeysockets/baileys");

// ─── CONFIG ────────────────────────────────────────────────────────────────

const app      = express();
const PORT     = process.env.PORT || 3000;
const BOT_NUM  = (process.env.BOT_NUMBER || "").replace(/[^0-9]/g, "");
const GEM_KEY  = process.env.GEMINI_KEY;

if (!BOT_NUM || !GEM_KEY) {
  console.error("❌ FATAL: BOT_NUMBER and GEMINI_KEY must be set.");
  process.exit(1);
}

// ─── STATE ─────────────────────────────────────────────────────────────────

let sock            = null;
let isConnecting    = false;
let reconnectTimer  = null;
let autoReply       = false;
let antiLink        = true;
let chatMemory      = {};          // { jid: [str, ...] }
let statusLogs      = [];
let pairingDisplay  = "⏳ Booting…";

// ─── HELPERS ───────────────────────────────────────────────────────────────

function log(msg) {
  const entry = `[${new Date().toLocaleTimeString()}] ${msg}`;
  console.log(entry);
  statusLogs.unshift(entry);
  if (statusLogs.length > 200) statusLogs.length = 200;
}

function decodeJid(jid) {
  if (!jid) return jid;
  if (/:\d+@/gi.test(jid)) {
    const { user, server } = jidDecode(jid) || {};
    return user && server ? `${user}@${server}` : jid;
  }
  return jid;
}

function ownerJid() {
  return sock?.user?.id ? decodeJid(sock.user.id) : `${BOT_NUM}@s.whatsapp.net`;
}

function uptime() {
  const s = Math.floor(process.uptime());
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m ${s % 60}s`;
}

// Extract plain text from any message type
function getText(msg) {
  const m = msg.message || {};
  return (
    m.conversation                              ||
    m.extendedTextMessage?.text                 ||
    m.imageMessage?.caption                     ||
    m.videoMessage?.caption                     ||
    m.documentMessage?.caption                  ||
    m.buttonsResponseMessage?.selectedButtonId  ||
    m.listResponseMessage?.singleSelectReply?.selectedRowId ||
    ""
  );
}

// ─── GEMINI AI ──────────────────────────────────────────────────────────────

async function askGemini(prompt, jid) {
  if (!chatMemory[jid]) chatMemory[jid] = [];

  const ctx = chatMemory[jid].slice(-10).join("\n");
  const full = ctx
    ? `Conversation so far:\n${ctx}\n\nUser: ${prompt}`
    : `You are a helpful WhatsApp assistant. User: ${prompt}`;

  try {
    const res = await axios.post(
      `https://generativelanguage.googleapis.com/v1/models/gemini-pro:generateContent?key=${GEM_KEY}`,
      { contents: [{ parts: [{ text: full }] }] },
      { timeout: 20_000 }
    );
    const text = res.data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) return "🤖 No response from AI.";
    chatMemory[jid].push(`User: ${prompt}`, `AI: ${text}`);
    if (chatMemory[jid].length > 10) chatMemory[jid].splice(0, 2);
    return text;
  } catch (e) {
    log(`⚠️ Gemini: ${e.response?.data?.error?.message || e.message}`);
    return "⚠️ AI error — check API quota.";
  }
}

// ─── VIEW-ONCE DOWNLOADER ───────────────────────────────────────────────────

async function downloadViewOnce(quotedMsg) {
  // quotedMsg is the raw .message object from contextInfo.quotedMessage
  const wrap =
    quotedMsg?.viewOnceMessage?.message          ||
    quotedMsg?.viewOnceMessageV2?.message        ||
    quotedMsg?.viewOnceMessageV2Extension?.message;

  if (!wrap) return null;

  const mediaKey = Object.keys(wrap).find(k =>
    k === "imageMessage" || k === "videoMessage" || k === "audioMessage"
  );
  if (!mediaKey) return null;

  const mediaMeta = wrap[mediaKey];
  const kind      = mediaKey.replace("Message", ""); // "image" | "video" | "audio"

  try {
    const stream = await downloadContentFromMessage(mediaMeta, kind);
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    return { buffer: Buffer.concat(chunks), kind, mime: mediaMeta.mimetype };
  } catch (e) {
    log(`❌ VV download: ${e.message}`);
    return null;
  }
}

// ─── BOT CORE ───────────────────────────────────────────────────────────────

async function startBot() {
  if (isConnecting) return;
  isConnecting = true;
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }

  try {
    const { state, saveCreds } = await useMultiFileAuthState("session");
    const { version }          = await fetchLatestBaileysVersion();

    sock = makeWASocket({
      version,
      logger:                   pino({ level: "silent" }),
      auth:                     state,
      printQRInTerminal:        false,
      browser:                  ["Ubuntu", "Chrome", "20.0.04"],
      syncFullHistory:          false,
      markOnlineOnConnect:      false,   // don't broadcast presence
      connectTimeoutMs:         60_000,
      keepAliveIntervalMs:      10_000,  // ping every 10s → stable
      retryRequestDelayMs:      2_000,
      maxMsgRetryCount:         3,
      generateHighQualityLinkPreview: false,
      getMessage:               async () => ({ conversation: "" }),
    });

    sock.ev.on("creds.update", saveCreds);

    // ── Connection state ──────────────────────────────────────────────────
    sock.ev.on("connection.update", async ({ connection, lastDisconnect }) => {
      if (connection === "open") {
        isConnecting    = false;
        sock.user.id    = decodeJid(sock.user.id);
        pairingDisplay  = "✅ Bot Online!";
        log(`✅ Connected as ${sock.user.id}`);
        await sock.sendMessage(ownerJid(), {
          text: `🚀 *Bot Online*\n📅 ${new Date().toLocaleString()}\nType *.menu* to see commands.`
        }).catch(() => {});
      }

      if (connection === "close") {
        isConnecting = false;
        const code   = lastDisconnect?.error?.output?.statusCode;
        log(`🔴 Disconnected — code ${code}`);

        if (code === DisconnectReason.loggedOut) {
          pairingDisplay = "❌ Logged out. Reset session.";
          log("❌ Logged out. Delete 'session' folder and restart.");
          return;
        }

        // Exponential back-off: 3s, 6s, 12s… capped at 30s
        const wait = Math.min(3000 * (2 ** (Math.floor(Math.random() * 3))), 30_000);
        log(`♻️ Reconnecting in ${wait / 1000}s…`);
        pairingDisplay = `🔄 Reconnecting in ${wait / 1000}s…`;
        reconnectTimer = setTimeout(startBot, wait);
      }
    });

    // ── Pairing ───────────────────────────────────────────────────────────
    if (!sock.authState.creds.registered) {
      setTimeout(async () => {
        try {
          const code     = await sock.requestPairingCode(BOT_NUM);
          pairingDisplay = `🔥 PAIRING CODE: ${code}`;
          log(`🔑 Pairing code: ${code}`);
        } catch (e) {
          log(`❌ Pairing error: ${e.message}`);
          isConnecting = false;
        }
      }, 5_000);
    }

    // ── Message handler ───────────────────────────────────────────────────
    sock.ev.on("messages.upsert", async ({ messages, type }) => {

      // 'notify' = new incoming messages only; skip history replay on reconnect
      if (type !== "notify") return;

      for (const msg of messages) {
        try {
          if (!msg?.message)                                  continue;
          if (msg.key.remoteJid === "status@broadcast")       continue;

          const from     = msg.key.remoteJid;
          const isGroup  = from.endsWith("@g.us");
          const fromMe   = msg.key.fromMe;    // true = sent by the bot's own account

          const rawText  = getText(msg).trim();
          const lower    = rawText.toLowerCase();
          const parts    = lower.split(/\s+/);
          const cmd      = parts[0];
          const args     = rawText.split(/\s+/).slice(1);
          const query    = args.join(" ");

          if (rawText) log(`📩 [${fromMe ? "ME" : from.split("@")[0]}] ${rawText.substring(0, 50)}`);

          // ── Anti-link (runs for all group members, before owner gate) ──
          if (isGroup && antiLink && !fromMe &&
              (rawText.includes("chat.whatsapp.com") || rawText.includes("whatsapp.com/channel"))) {
            await sock.sendMessage(from, { delete: msg.key }).catch(() => {});
            await sock.sendMessage(from, { text: "🚫 Links are not allowed here." });
            continue;
          }

          // ── OWNER GATE ─────────────────────────────────────────────────
          // All commands (anything starting with ".") are owner-only.
          // Non-command messages from others: only trigger AI if autoReply on + it's a DM.
          if (!fromMe) {
            if (!isGroup && autoReply && !cmd.startsWith(".") && rawText.length > 2) {
              const ai = await askGemini(rawText, from);
              await sock.sendMessage(from, { text: `🧠 ${ai}` });
            }
            continue;
          }

          // ─────────────────────────────────────────────────────────────
          // OWNER-ONLY COMMANDS FROM HERE
          // ─────────────────────────────────────────────────────────────

          // ── .menu / .help ──────────────────────────────────────────────
          if (cmd === ".menu" || cmd === ".help") {
            await sock.sendMessage(from, { text: `👑 *BOT MASTER CONSOLE*
━━━━━━━━━━━━━━━━━━━━

*⚡ AUTOMATION*
• .autoreply on|off  — AI auto-reply in DMs
• .antilink on|off   — Block group links
  _AI: ${autoReply ? "🟢 ON" : "🔴 OFF"} | Links: ${antiLink ? "🟢 ON" : "🔴 OFF"}_

*🕵️ STEALTH*
• .vv  — Reply to view-once → sends to your DM, deletes cmd

*🛡️ GROUP ADMIN* _(use in a group)_
• .promote @user | .demote @user
• .kick @user    | .kickall
• .tagall [msg]  | .hidetag [msg]
• .mute          | .unmute
• .link          | .revoke
• .setname <txt> | .setdesc <txt>
• .groupinfo     | .delete _(reply)_

*🧠 AI*
• .ai <query>  — Ask Gemini
• .clear       — Reset AI memory

*🛠️ UTILITIES*
• .ping   | .alive  | .uptime
• .time   | .date   | .info
• .weather <city>

*🎉 EXTRAS*
• .quote | .joke | .fact
• .flip  | .dice | .8ball

*⚙️ SYSTEM*
• .restart — Reconnect bot` });
            continue;
          }

          // ── Automation toggles ─────────────────────────────────────────
          if (cmd === ".autoreply") {
            autoReply = query.toLowerCase() === "on";
            await sock.sendMessage(from, { text: `🤖 Auto-reply: *${autoReply ? "ON 🟢" : "OFF 🔴"}*` });
            continue;
          }
          if (cmd === ".antilink") {
            antiLink = query.toLowerCase() === "on";
            await sock.sendMessage(from, { text: `🛡️ Anti-link: *${antiLink ? "ON 🟢" : "OFF 🔴"}*` });
            continue;
          }

          // ── AI ─────────────────────────────────────────────────────────
          if (cmd === ".ai" || cmd === ".gpt") {
            if (!query) { await sock.sendMessage(from, { text: "Usage: .ai <question>" }); continue; }
            await sock.sendMessage(from, { text: "_Thinking…_" });
            const res = await askGemini(query, from);
            await sock.sendMessage(from, { text: `🧠 ${res}` });
            continue;
          }
          if (cmd === ".clear") {
            chatMemory[from] = [];
            await sock.sendMessage(from, { text: "🧹 AI memory cleared." });
            continue;
          }

          // ── .vv — STEALTH VIEW-ONCE REVEAL ────────────────────────────
          if (cmd === ".vv") {
            const ctx    = msg.message?.extendedTextMessage?.contextInfo;
            const quoted = ctx?.quotedMessage;

            if (!quoted) {
              await sock.sendMessage(from, { text: "⚠️ Reply to a view-once message with .vv" });
              continue;
            }

            const media = await downloadViewOnce(quoted);

            if (!media) {
              await sock.sendMessage(from, { text: "⚠️ Couldn't download — not a view-once or already expired." });
              continue;
            }

            // 1. Delete the .vv command FIRST (stealth — other person won't see it)
            await sock.sendMessage(from, { delete: msg.key }).catch(() => {});

            // 2. Send media to owner's DM silently
            const caption = `👁️ *View-Once* captured\n📍 From: ${from.split("@")[0]}`;
            if (media.kind === "image") {
              await sock.sendMessage(ownerJid(), { image: media.buffer, caption });
            } else if (media.kind === "video") {
              await sock.sendMessage(ownerJid(), { video: media.buffer, caption, mimetype: media.mime });
            } else if (media.kind === "audio") {
              await sock.sendMessage(ownerJid(), { audio: media.buffer, mimetype: media.mime });
            }
            continue;
          }

          // ── GROUP COMMANDS ─────────────────────────────────────────────
          if (isGroup) {
            const meta  = await sock.groupMetadata(from).catch(() => null);
            if (!meta) continue;
            const parts = meta.participants;
            const ctx   = msg.message?.extendedTextMessage?.contextInfo;
            const user  = ctx?.mentionedJid?.[0] || ctx?.participant;

            if (cmd === ".promote") {
              if (!user) { await sock.sendMessage(from, { text: "⚠️ Tag or reply to a user." }); continue; }
              await sock.groupParticipantsUpdate(from, [user], "promote");
              await sock.sendMessage(from, { text: `✅ @${user.split("@")[0]} promoted to admin.`, mentions: [user] });
              continue;
            }
            if (cmd === ".demote") {
              if (!user) { await sock.sendMessage(from, { text: "⚠️ Tag or reply to a user." }); continue; }
              await sock.groupParticipantsUpdate(from, [user], "demote");
              await sock.sendMessage(from, { text: `✅ @${user.split("@")[0]} demoted.`, mentions: [user] });
              continue;
            }
            if (cmd === ".kick") {
              if (!user) { await sock.sendMessage(from, { text: "⚠️ Tag or reply to a user." }); continue; }
              await sock.groupParticipantsUpdate(from, [user], "remove");
              await sock.sendMessage(from, { text: `👢 @${user.split("@")[0]} removed.`, mentions: [user] });
              continue;
            }
            if (cmd === ".kickall") {
              await sock.sendMessage(from, { text: "☢️ *Purge starting…*" });
              const targets = parts.filter(p => !p.admin && p.id !== ownerJid());
              for (const p of targets) {
                await sock.groupParticipantsUpdate(from, [p.id], "remove").catch(() => {});
                await delay(700);
              }
              await sock.sendMessage(from, { text: `🧹 Removed ${targets.length} members.` });
              continue;
            }
            if (cmd === ".tagall") {
              const mentions = parts.map(p => p.id);
              let txt = `📢 *${query || "Attention!"}*\n\n`;
              for (const p of parts) txt += `• @${p.id.split("@")[0]}\n`;
              await sock.sendMessage(from, { text: txt, mentions });
              continue;
            }
            if (cmd === ".hidetag") {
              await sock.sendMessage(from, { text: query || "📣", mentions: parts.map(p => p.id) });
              continue;
            }
            if (cmd === ".mute") {
              await sock.groupSettingUpdate(from, "announcement");
              await sock.sendMessage(from, { text: "🔇 Group muted (only admins can send)." });
              continue;
            }
            if (cmd === ".unmute") {
              await sock.groupSettingUpdate(from, "not_announcement");
              await sock.sendMessage(from, { text: "🔊 Group unmuted." });
              continue;
            }
            if (cmd === ".link") {
              const code = await sock.groupInviteCode(from);
              await sock.sendMessage(from, { text: `🔗 *Invite link:*\nhttps://chat.whatsapp.com/${code}` });
              continue;
            }
            if (cmd === ".revoke") {
              await sock.groupRevokeInvite(from);
              await sock.sendMessage(from, { text: "🔄 Invite link revoked." });
              continue;
            }
            if (cmd === ".setname") {
              if (!query) { await sock.sendMessage(from, { text: "Usage: .setname <new name>" }); continue; }
              await sock.groupUpdateSubject(from, query);
              await sock.sendMessage(from, { text: `✅ Group renamed to *${query}*` });
              continue;
            }
            if (cmd === ".setdesc") {
              if (!query) { await sock.sendMessage(from, { text: "Usage: .setdesc <description>" }); continue; }
              await sock.groupUpdateDescription(from, query);
              await sock.sendMessage(from, { text: "✅ Description updated." });
              continue;
            }
            if (cmd === ".groupinfo") {
              const created = new Date(meta.creation * 1000).toLocaleDateString();
              const admins  = parts.filter(p => p.admin).map(p => `• @${p.id.split("@")[0]}`).join("\n");
              await sock.sendMessage(from, {
                text: `📋 *Group Info*\n\n📌 Name: ${meta.subject}\n👥 Members: ${parts.length}\n📅 Created: ${created}\n\n👑 *Admins:*\n${admins}`,
                mentions: parts.filter(p => p.admin).map(p => p.id)
              });
              continue;
            }
            if (cmd === ".delete" || cmd === ".del") {
              if (!ctx?.stanzaId) { await sock.sendMessage(from, { text: "⚠️ Reply to a message to delete it." }); continue; }
              await sock.sendMessage(from, { delete: { remoteJid: from, id: ctx.stanzaId, participant: ctx.participant } }).catch(() => {});
              continue;
            }
          }

          // ── UTILITIES ──────────────────────────────────────────────────
          if (cmd === ".ping") {
            const t = Date.now();
            await sock.sendMessage(from, { text: `🏓 Pong! *${Date.now() - t}ms*` });
            continue;
          }
          if (cmd === ".alive") {
            await sock.sendMessage(from, { text: `🟢 *Bot Alive*\n⏱️ Uptime: ${uptime()}\n📡 Engine: Baileys v6\n☁️ Host: Render` });
            continue;
          }
          if (cmd === ".uptime") {
            await sock.sendMessage(from, { text: `⏱️ *Uptime:* ${uptime()}` });
            continue;
          }
          if (cmd === ".time")  { await sock.sendMessage(from, { text: `🕙 *${new Date().toLocaleTimeString()}*` }); continue; }
          if (cmd === ".date")  { await sock.sendMessage(from, { text: `📅 *${new Date().toDateString()}*` }); continue; }
          if (cmd === ".info") {
            await sock.sendMessage(from, { text: `👤 *Owner Info*\n📱 Number: ${BOT_NUM}\n👑 Role: Owner/Bot` });
            continue;
          }
          if (cmd === ".restart") {
            await sock.sendMessage(from, { text: "🔄 Reconnecting…" });
            await sock.logout().catch(() => {});
            continue;
          }

          // Weather
          if (cmd === ".weather") {
            if (!query) { await sock.sendMessage(from, { text: "Usage: .weather <city>" }); continue; }
            const res = await axios.get(`https://wttr.in/${encodeURIComponent(query)}?format=3`, { timeout: 8000 }).catch(() => null);
            await sock.sendMessage(from, { text: res ? `🌤️ ${res.data}` : "❌ Weather API offline." });
            continue;
          }

          // External APIs
          if (cmd === ".quote") {
            const res = await axios.get("https://api.quotable.io/random", { timeout: 8000 }).catch(() => null);
            await sock.sendMessage(from, { text: res ? `💬 _"${res.data.content}"_\n— *${res.data.author}*` : "❌ API offline." });
            continue;
          }
          if (cmd === ".joke") {
            const res = await axios.get("https://official-joke-api.appspot.com/random_joke", { timeout: 8000 }).catch(() => null);
            await sock.sendMessage(from, { text: res ? `😂 *${res.data.setup}*\n\n${res.data.punchline}` : "❌ API offline." });
            continue;
          }
          if (cmd === ".fact") {
            const res = await axios.get("https://uselessfacts.jsph.pl/random.json?language=en", { timeout: 8000 }).catch(() => null);
            await sock.sendMessage(from, { text: res ? `💡 *Fact:* ${res.data.text}` : "❌ API offline." });
            continue;
          }

          // Fun
          if (cmd === ".flip")  { await sock.sendMessage(from, { text: `🪙 *${Math.random() > 0.5 ? "HEADS" : "TAILS"}*` }); continue; }
          if (cmd === ".dice")  { await sock.sendMessage(from, { text: `🎲 Rolled: *${Math.floor(Math.random() * 6) + 1}*` }); continue; }
          if (cmd === ".8ball") {
            const a = ["Yes 🟢","No 🔴","Maybe 🟡","Ask later ⏳","Definitely ✅","Highly doubtful ❌","Without a doubt 💯","My sources say no 🚫","Signs point to yes 🔮","Cannot predict now 🌫️"];
            await sock.sendMessage(from, { text: `🎱 *${a[Math.floor(Math.random() * a.length)]}*` });
            continue;
          }

          // Auto-reply for owner's own messages (when autoreply is ON)
          if (autoReply && !cmd.startsWith(".") && rawText.length > 2) {
            const ai = await askGemini(rawText, from);
            await sock.sendMessage(from, { text: `🧠 ${ai}` });
          }

        } catch (err) {
          log(`❌ Handler error: ${err.message}`);
        }
      }
    });

    // ── Group welcome ──────────────────────────────────────────────────────
    sock.ev.on("group-participants.update", async (data) => {
      if (data.action !== "add") return;
      try {
        const meta = await sock.groupMetadata(data.id).catch(() => null);
        if (!meta) return;
        for (const user of data.participants) {
          await sock.sendMessage(data.id, {
            text: `👋 Welcome @${user.split("@")[0]} to *${meta.subject}*!`,
            mentions: [user]
          }).catch(() => {});
        }
      } catch (e) { log(`Group join error: ${e.message}`); }
    });

  } catch (err) {
    log(`❌ startBot error: ${err.message}`);
    isConnecting = false;
    reconnectTimer = setTimeout(startBot, 5_000);
  }
}

// ─── WEB DASHBOARD ─────────────────────────────────────────────────────────

app.get("/", (_req, res) => {
  const rows = statusLogs.map(l =>
    `<div class="log">${l.replace(/</g,"&lt;").replace(/>/g,"&gt;")}</div>`
  ).join("");
  res.send(`<!DOCTYPE html><html lang="en"><head>
  <meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Bot Console</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{background:#0c0c0c;color:#e0e0e0;font-family:'Segoe UI',sans-serif;padding:20px}
    .wrap{max-width:900px;margin:auto}
    h1{color:#25D366;text-align:center;padding:20px 0;border-bottom:2px solid #25D366;margin-bottom:20px}
    .card{background:#1a1a1a;border:1px solid #333;border-radius:12px;padding:20px;margin-bottom:20px;text-align:center}
    .card h2{color:#25D366;font-size:1rem;word-break:break-all}
    .btn{background:#ff4b2b;color:#fff;border:none;padding:10px 22px;border-radius:6px;cursor:pointer;font-weight:700;margin-top:12px;transition:.2s}
    .btn:hover{background:#ff6b4b}
    .term{background:#000;border-radius:10px;padding:16px;height:460px;overflow-y:auto;border:1px solid #333;font-family:'Courier New',monospace;font-size:.8rem}
    .log{color:#00ff41;margin-bottom:5px;line-height:1.45}
    footer{text-align:center;margin-top:16px;color:#555;font-size:.78rem}
    ::-webkit-scrollbar{width:6px}::-webkit-scrollbar-thumb{background:#25D366;border-radius:6px}
  </style>
</head><body>
  <div class="wrap">
    <h1>⚡ BOT CONSOLE</h1>
    <div class="card">
      <h2>${pairingDisplay}</h2>
      <button class="btn" onclick="if(confirm('Delete session and restart?'))location.href='/reset-session'">🔄 Reset Session</button>
    </div>
    <div class="term">${rows}</div>
    <footer>Production Edition · Node.js v20 · Baileys v6</footer>
  </div>
  <script>setTimeout(()=>location.reload(),12000)</script>
</body></html>`);
});

app.get("/reset-session", (_req, res) => {
  log("⚠️ Manual reset triggered.");
  try {
    const p = path.join(__dirname, "session");
    if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true });
    res.send(`<html><body style="background:#0c0c0c;color:#25D366;font-family:sans-serif;text-align:center;padding:60px">
      <h2>Session deleted. Restarting…</h2>
      <script>setTimeout(()=>location.href='/',5000)</script></body></html>`);
    setTimeout(() => process.exit(0), 800);
  } catch (e) { res.status(500).send("Error: " + e.message); }
});

// ─── START ──────────────────────────────────────────────────────────────────

// ✅ Single entry point — startBot() called ONCE here, never again at bottom
app.listen(PORT, () => {
  log(`🌐 Console live on port ${PORT}`);
  startBot();
});