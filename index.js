/**
 * ==============================================================================
 * 🚀 WHATSAPP BOT MASTER CONSOLE - ULTIMATE EDITION (V4.2.0)
 * ==============================================================================
 * Fixes:
 * - Double-response bug FIXED (type === "notify" filter)
 * - Gemini updated to gemini-1.5-flash on v1beta endpoint (fixes quota error)
 * - .vv RESTORED — downloads view-once image/video, forwards to your saved DM
 * - .aiauto on/off — typed IN a DM, sets THAT person as partner for AI replies
 *   AI replies as you (naturally) whenever partner messages while it's active
 * ==============================================================================
 */

const express = require("express");
const pino = require("pino");
const axios = require("axios");
const path = require("path");
const fs = require("fs");
const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion,
    delay,
    jidDecode,
    generateForwardMessageContent,
    prepareWAMessageMedia,
    generateWAMessageFromContent,
    generateMessageID,
    downloadContentFromMessage,
    jidNormalizedUser,
    proto
} = require("@whiskeysockets/baileys");


// ── App Setup ─────────────────────────────────────────────────────────────────
const app = express();
const PORT = process.env.PORT || 3000;

const BOT_NUMBER = process.env.BOT_NUMBER;
const GEMINI_KEY = process.env.GEMINI_KEY;

if (!BOT_NUMBER || !GEMINI_KEY) {
    console.error("❌ CRITICAL: BOT_NUMBER and GEMINI_KEY env vars are required.");
    process.exit(1);
}

// ── Global State ──────────────────────────────────────────────────────────────
let autoReplyActive = false;  // general AI mode (you talking to yourself)
let antiLinkActive  = true;
let chatMemory      = {};
let statusLogs      = [];
let webPairingCode  = "System Booting... Waiting for Pairing Engine.";

// Partner AI auto-reply state
// Key = JID of partner, Value = true/false
// Only one partner active at a time — toggled by typing .aiauto on/off IN their DM
let partnerAiJid    = null;   // which DM has auto-reply active
let partnerAiActive = false;
let globalSock      = null;   // reference to active socket for dashboard actions
let currentQR       = null;   // latest QR string for web dashboard

// makeInMemoryStore removed in Baileys 6.x — using lightweight message cache instead
const msgCache = new Map();

// ── Utilities ─────────────────────────────────────────────────────────────────
function decodeJid(jid) {
    if (!jid) return jid;
    if (/:\d+@/gi.test(jid)) {
        const decode = jidDecode(jid) || {};
        return (decode.user && decode.server) ? `${decode.user}@${decode.server}` : jid;
    }
    return jid;
}

function addLog(msg) {
    const time = new Date().toLocaleTimeString();
    const line = `[${time}] ${msg}`;
    console.log(line);
    statusLogs.unshift(line);
    if (statusLogs.length > 100) statusLogs.pop();
}

// ── Gemini AI ─────────────────────────────────────────────────────────────────
// systemPrompt: optional — used for partner auto-reply to set persona
async function askGemini(prompt, userJid, systemPrompt = null) {
    try {
        if (!chatMemory[userJid]) chatMemory[userJid] = [];

        const context = chatMemory[userJid].join("\n");

        let fullPrompt;
        if (systemPrompt) {
            // Partner mode: AI replies AS the owner
            fullPrompt = `${systemPrompt}\n\n${context ? `Recent conversation:\n${context}\n\n` : ''}They just said: "${prompt}"\n\nReply naturally as the owner would. Keep it short and casual.`;
        } else {
            fullPrompt = context
                ? `Context of our last few messages:\n${context}\n\nNew message: ${prompt}`
                : `You are a helpful WhatsApp AI assistant. User says: ${prompt}`;
        }

        // ✅ FIXED: was gemini-pro on /v1/ — now gemini-1.5-flash on /v1beta/
        const response = await axios.post(
            `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.0-flash:generateContent?key=${GEMINI_KEY}`,
            { contents: [{ parts: [{ text: fullPrompt }] }] }
        );

        const aiText = response.data?.candidates?.[0]?.content?.parts?.[0]?.text;
        if (!aiText) return "I'm a bit busy right now, try again in a sec 😅";

        chatMemory[userJid].push(`User: ${prompt}`);
        chatMemory[userJid].push(`AI: ${aiText}`);
        if (chatMemory[userJid].length > 10) chatMemory[userJid].splice(0, 2);

        return aiText;
    } catch (error) {
        const errMsg = error.response?.data?.error?.message || error.message;
        addLog(`⚠️ Gemini Error: ${errMsg}`);
        return "⚠️ AI hiccup. Please try again.";
    }
}

// ── Bot Core ──────────────────────────────────────────────────────────────────
async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState("session");
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
        version,
        logger: pino({ level: "silent" }),
        auth: state,
        printQRInTerminal: false,
        browser: ["Ubuntu", "Chrome", "20.0.04"],
        syncFullHistory: false,
        markOnlineOnConnect: true,
        connectTimeoutMs: 60000,
        keepAliveIntervalMs: 30000,
        generateHighQualityLinkPreview: true,
        getMessage: async (key) => {
            const cached = msgCache.get(key.id);
            return cached?.message || { conversation: "placeholder" };
        }
    });

    sock.ev.on("creds.update", saveCreds);

    // ── Connection Handler ────────────────────────────────────────────────────
    sock.ev.on("connection.update", async (update) => {
        const { connection, lastDisconnect, qr } = update;
        if (qr) {
            currentQR = qr;
            addLog("📷 QR Code ready — scan from dashboard or WhatsApp");
        }

        if (connection === "close") {
            const reason = lastDisconnect?.error?.output?.statusCode;
            addLog(`🔄 Connection Closed. Reason: ${reason}`);
            if (reason !== DisconnectReason.loggedOut) {
                addLog("♻️ Reconnecting...");
                startBot();
            } else {
                addLog("❌ Logged out. Delete 'session' folder and restart.");
            }
        }

        if (connection === "open") {
            addLog("✅ WHATSAPP CONNECTION ESTABLISHED");
            sock.user.id = decodeJid(sock.user.id);
            webPairingCode = "✅ Bot is Online and Guarding!";
            await sock.sendMessage(sock.user.id, {
                text: `🚀 *Bot System Online*\n\nHost: Render Cloud\nTime: ${new Date().toLocaleString()}\nType *.menu* to begin.`
            });
        }
    });

    // Pairing Code
    if (!sock.authState.creds.registered) {
        setTimeout(async () => {
            const cleanedNumber = BOT_NUMBER.replace(/[^0-9]/g, "");
            try {
                addLog(`🔑 Requesting pairing code for ${cleanedNumber}...`);
                const code = await sock.requestPairingCode(cleanedNumber);
                webPairingCode = `🔥 PAIR CODE: ${code}`;
                addLog(`🔑 PAIRING CODE: ${code}`);
            } catch (err) {
                addLog("❌ Pairing Engine Error. Check BOT_NUMBER.");
            }
        }, 8000);
    }

    // ── Message Handler ───────────────────────────────────────────────────────
    sock.ev.on("messages.upsert", async ({ messages, type }) => {
        // Only process "notify" — prevents Baileys firing handler twice per message
        if (type !== "notify") return;

        // Populate message cache for getMessage lookups
        for (const m of messages) {
            if (m.key?.id) msgCache.set(m.key.id, m);
        }
        if (msgCache.size > 500) {
            const firstKey = msgCache.keys().next().value;
            msgCache.delete(firstKey);
        }

        try {
            const msg = messages[0];
            if (!msg?.message) return;
            if (msg.key.remoteJid === 'status@broadcast') return;
            // Suppress Baileys echo: bot's own sent messages come back as notify+fromMe
            // Only allow fromMe through if it's a real dot command (owner controlling bot)
            // This stops autoReply from triggering on the bot's own outgoing messages
            if (msg.key.fromMe && !Object.keys(msg.message)[0]?.includes('protocol')) {
                const rawText = msg.message?.conversation || msg.message?.extendedTextMessage?.text || '';
                if (!rawText.trim().startsWith('.')) return;
            }

            const from     = msg.key.remoteJid;
            const isGroup  = from.endsWith("@g.us");
            const isFromMe = msg.key.fromMe;
            const botNumber = decodeJid(sock.user.id);

            // Extract message text
            const msgType   = Object.keys(msg.message)[0];
            const msgText   =
                msgType === 'conversation'        ? msg.message.conversation :
                msgType === 'extendedTextMessage' ? msg.message.extendedTextMessage.text :
                msgType === 'imageMessage'        ? (msg.message.imageMessage?.caption || '') :
                msgType === 'videoMessage'        ? (msg.message.videoMessage?.caption || '') : '';

            const cleanText = msgText.trim();
            const command   = cleanText.split(/\s+/)[0].toLowerCase();
            const args      = cleanText.split(/\s+/).slice(1);
            const query     = args.join(" ");

            if (cleanText) {
                addLog(`📩 [${isFromMe ? 'ME' : 'USER'}] ${from.split('@')[0]}: ${cleanText.substring(0, 40)}`);
            }

            // ── Security: only owner runs dot commands ────────────────────────
            if (command.startsWith(".") && !isFromMe) return;

            // ── Anti-link ─────────────────────────────────────────────────────
            if (isGroup && antiLinkActive && !isFromMe && cleanText.includes("chat.whatsapp.com")) {
                await sock.sendMessage(from, { delete: msg.key });
                return await sock.sendMessage(from, { text: "🚫 *Link Detected & Removed.*" });
            }

            // ── Partner AI Auto-Reply ─────────────────────────────────────────
            // Fires when: partner AI is on, message is from partner (not me), not a group, not a command
            if (
                partnerAiActive &&
                partnerAiJid &&
                !isFromMe &&
                !isGroup &&
                from === partnerAiJid &&
                cleanText.length > 0 &&
                !command.startsWith(".")
            ) {
                const systemPrompt = `You are acting as the owner of this WhatsApp account, replying to their partner/close person. 
Be warm, natural and casual — reply exactly how a person would reply to someone they care about. 
Do NOT reveal you are an AI. Do NOT be overly formal. Keep replies short and human.`;
                const aiReply = await askGemini(cleanText, from, systemPrompt);
                return await sock.sendMessage(from, { text: aiReply });
            }

            // ── General autoReply (owner talking to self) ─────────────────────
            if (!command.startsWith(".") && autoReplyActive && isFromMe && cleanText.length > 2) {
                const aiRes = await askGemini(cleanText, from);
                return await sock.sendMessage(from, { text: `🧠 *Assistant:* ${aiRes}` });
            }

            // ── COMMANDS ──────────────────────────────────────────────────────

            // 1. MENU
            if (command === ".menu" || command === ".help") {
                const partnerStatus = partnerAiActive && partnerAiJid
                    ? `🟢 Active (${partnerAiJid.split('@')[0]})`
                    : '🔴 Off';
                const menu = `👑 *MASTER CONSOLE V4.2* 👑

*--- ⚡ AUTOMATION ---*
.autoreply on | off  - Personal AI Mode
.antilink on | off   - Link Guard
.aiauto on | off     - Partner AI Reply (type in their DM)
_AutoReply: ${autoReplyActive ? '🟢' : '🔴'}_
_Partner AI: ${partnerStatus}_

*--- 👁️ VIEW ONCE ---*
.vv  - Reveal & save view-once media to your DM

*--- 🛡️ ADMIN POWER ---*
.promote  - Grant Admin
.demote   - Remove Admin
.kick     - Remove User
.kickall  - Wipe Group
.tagall   - Mention All
.hidetag  - Ghost Tag

*--- 🧠 AI & ENGINE ---*
.ai <query> - Ask Gemini
.clear      - Reset AI Memory
.ping       - Latency
.alive      - System Info

*--- 🛠️ UTILITIES ---*
.time | .date | .owner
.quote | .joke | .fact

*--- 🎭 FUN ---*
.flip | .dice | .8ball`;
                return await sock.sendMessage(from, { text: menu });
            }

            // 2. AUTOMATION CONTROLS
            if (command === ".autoreply") {
                if (!query) return await sock.sendMessage(from, { text: "Usage: .autoreply on/off" });
                autoReplyActive = query.toLowerCase() === "on";
                return await sock.sendMessage(from, { text: `🤖 Personal AI Mode: *${autoReplyActive ? 'ENABLED' : 'DISABLED'}*` });
            }

            if (command === ".antilink") {
                antiLinkActive = query.toLowerCase() === "on";
                return await sock.sendMessage(from, { text: `🛡️ Link Guard: *${antiLinkActive ? 'ENABLED' : 'DISABLED'}*` });
            }

            // .aiauto — typed IN a DM sets that person as the AI partner
            if (command === ".aiauto") {
                if (isGroup) return await sock.sendMessage(from, { text: "⚠️ .aiauto only works in a personal DM, not groups." });
                const toggle = query.toLowerCase();
                if (!toggle) return await sock.sendMessage(from, { text: "Usage: .aiauto on/off\n(Type this inside the DM of the person you want AI to reply for)" });

                if (toggle === "on") {
                    partnerAiActive = true;
                    partnerAiJid    = from; // the DM this command was typed in
                    return await sock.sendMessage(from, { text: `💬 *Partner AI Active*\n\nI'll reply as you in this chat when they message.\nType *.aiauto off* here to stop.` });
                } else {
                    partnerAiActive = false;
                    partnerAiJid    = null;
                    return await sock.sendMessage(from, { text: `🔕 *Partner AI Disabled.*` });
                }
            }

            // 3. VIEW ONCE (.vv) ───────────────────────────────────────────────
            // Reply to a view-once message with .vv to save it to your DM
            if (command === ".vv") {
                const quoted = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;
                if (!quoted) {
                    return await sock.sendMessage(from, { text: "⚠️ Reply to a view-once image or video with *.vv*" });
                }

                // Detect media type inside the quoted message
                const voImage = quoted.imageMessage  || quoted.viewOnceMessage?.message?.imageMessage  || quoted.viewOnceMessageV2?.message?.imageMessage;
                const voVideo = quoted.videoMessage  || quoted.viewOnceMessage?.message?.videoMessage  || quoted.viewOnceMessageV2?.message?.videoMessage;
                const voAudio = quoted.audioMessage  || quoted.viewOnceMessage?.message?.audioMessage;

                const mediaMsg = voVideo || voImage || voAudio;

                if (!mediaMsg) {
                    return await sock.sendMessage(from, { text: "⚠️ No viewable media found. Make sure you're replying to a view-once photo or video." });
                }

                try {
                    const mediaType = voVideo ? "videoMessage" : voAudio ? "audioMessage" : "imageMessage";
                    const stream    = await downloadContentFromMessage(mediaMsg, mediaType.replace("Message", ""));

                    let buffer = Buffer.alloc(0);
                    for await (const chunk of stream) {
                        buffer = Buffer.concat([buffer, chunk]);
                    }

                    const botJid = decodeJid(sock.user.id);

                    if (voVideo) {
                        await sock.sendMessage(botJid, {
                            video: buffer,
                            caption: "👁️ *View Once Video — Saved*",
                            mimetype: mediaMsg.mimetype || "video/mp4"
                        });
                    } else if (voAudio) {
                        await sock.sendMessage(botJid, {
                            audio: buffer,
                            mimetype: mediaMsg.mimetype || "audio/ogg; codecs=opus",
                            ptt: true
                        });
                    } else {
                        await sock.sendMessage(botJid, {
                            image: buffer,
                            caption: "👁️ *View Once Image — Saved*"
                        });
                    }

                    return await sock.sendMessage(from, { text: "✅ *Saved to your DM.*" });
                } catch (e) {
                    addLog(`❌ .vv Error: ${e.message}`);
                    return await sock.sendMessage(from, { text: "❌ Failed to download. The media may have already expired." });
                }
            }

            // 4. AI COMMANDS
            if (command === ".ai" || command === ".gpt") {
                if (!query) return await sock.sendMessage(from, { text: "❓ Ask me something. Usage: .ai <question>" });
                await sock.sendMessage(from, { text: "_Thinking..._" });
                const aiRes = await askGemini(query, from);
                return await sock.sendMessage(from, { text: aiRes });
            }

            if (command === ".clear") {
                chatMemory[from] = [];
                return await sock.sendMessage(from, { text: "🧹 *AI Memory Cleared.*" });
            }

            // 5. ADMIN TOOLS (group only)
            if (isGroup) {
                const groupMetadata = await sock.groupMetadata(from);
                const participants  = groupMetadata.participants;
                const contextInfo   = msg.message?.extendedTextMessage?.contextInfo;

                if (command === ".promote") {
                    const user = contextInfo?.mentionedJid?.[0] || contextInfo?.participant;
                    if (!user) return await sock.sendMessage(from, { text: "⚠️ Reply to or tag a user." });
                    await sock.groupParticipantsUpdate(from, [user], "promote");
                    return await sock.sendMessage(from, { text: "✅ Promoted." });
                }

                if (command === ".demote") {
                    const user = contextInfo?.mentionedJid?.[0] || contextInfo?.participant;
                    if (!user) return await sock.sendMessage(from, { text: "⚠️ Reply to or tag a user." });
                    await sock.groupParticipantsUpdate(from, [user], "demote");
                    return await sock.sendMessage(from, { text: "✅ Demoted." });
                }

                if (command === ".kick") {
                    const user = contextInfo?.mentionedJid?.[0] || contextInfo?.participant;
                    if (!user) return await sock.sendMessage(from, { text: "⚠️ Tag the user." });
                    await sock.groupParticipantsUpdate(from, [user], "remove");
                    return await sock.sendMessage(from, { text: "👢 Removed." });
                }

                if (command === ".kickall") {
                    await sock.sendMessage(from, { text: "☢️ *PURGE STARTING...*" });
                    for (const p of participants) {
                        if (p.id !== botNumber && !p.admin) {
                            await sock.groupParticipantsUpdate(from, [p.id], "remove");
                            await delay(800);
                        }
                    }
                    return await sock.sendMessage(from, { text: "🧹 Purge complete." });
                }

                if (command === ".tagall") {
                    let txt = `📢 *Attention Everyone*\n\n${query ? `*Message:* ${query}\n\n` : ''}`;
                    const mentions = participants.map(p => p.id);
                    for (const p of participants) txt += `• @${p.id.split("@")[0]}\n`;
                    return await sock.sendMessage(from, { text: txt, mentions });
                }

                if (command === ".hidetag") {
                    const mentions = participants.map(p => p.id);
                    return await sock.sendMessage(from, { text: query || "👀", mentions });
                }
            }

            // 6. UTILITIES
            if (command === ".ping") {
                const start = Date.now();
                await sock.sendMessage(from, { text: "Pinging..." });
                return await sock.sendMessage(from, { text: `🚀 *Latency:* ${Date.now() - start}ms` });
            }

            if (command === ".alive") {
                return await sock.sendMessage(from, { text: `🟢 *Status:* Operational\n☁️ *Host:* Render\n⚡ *Engine:* Baileys\n🤖 *Partner AI:* ${partnerAiActive ? `Active (${partnerAiJid?.split('@')[0]})` : 'Off'}` });
            }

            if (command === ".time")  return await sock.sendMessage(from, { text: `🕙 ${new Date().toLocaleTimeString()}` });
            if (command === ".date")  return await sock.sendMessage(from, { text: `📅 ${new Date().toDateString()}` });
            if (command === ".owner") return await sock.sendMessage(from, { text: `👑 *Owner:* ${BOT_NUMBER}` });

            // 7. EXTERNAL APIS
            if (command === ".quote") {
                const res = await axios.get("https://api.quotable.io/random").catch(() => null);
                if (!res) return await sock.sendMessage(from, { text: "❌ Quote API Offline." });
                return await sock.sendMessage(from, { text: `"${res.data.content}"\n— *${res.data.author}*` });
            }

            if (command === ".joke") {
                const res = await axios.get("https://official-joke-api.appspot.com/random_joke").catch(() => null);
                if (!res) return await sock.sendMessage(from, { text: "❌ Joke API Offline." });
                return await sock.sendMessage(from, { text: `*${res.data.setup}*\n\n${res.data.punchline} 😄` });
            }

            if (command === ".fact") {
                const res = await axios.get("https://uselessfacts.jsph.pl/random.json?language=en").catch(() => null);
                if (!res) return await sock.sendMessage(from, { text: "❌ Facts API Offline." });
                return await sock.sendMessage(from, { text: `💡 *Fact:* ${res.data.text}` });
            }

            // 8. FUN
            if (command === ".flip") return await sock.sendMessage(from, { text: `🪙 *${Math.random() > 0.5 ? "HEADS" : "TAILS"}*` });
            if (command === ".dice") return await sock.sendMessage(from, { text: `🎲 You rolled: *${Math.floor(Math.random() * 6) + 1}*` });
            if (command === ".8ball") {
                const answers = ["Yes 🟢", "No 🔴", "Maybe 🤔", "Ask later ⏳", "Definitely ✅", "Highly Doubtful ❌"];
                return await sock.sendMessage(from, { text: `🎱 *Oracle says:* ${answers[Math.floor(Math.random() * answers.length)]}` });
            }

        } catch (err) {
            addLog(`❌ Handler Error: ${err.message}`);
        }
    });

    // ── Welcome new group members ─────────────────────────────────────────────
    sock.ev.on("group-participants.update", async (data) => {
        try {
            const metadata = await sock.groupMetadata(data.id);
            for (const user of data.participants) {
                if (data.action === "add") {
                    await sock.sendMessage(data.id, {
                        text: `👋 Welcome @${user.split("@")[0]} to *${metadata.subject}*! 🎉`,
                        mentions: [user]
                    });
                }
            }
        } catch (e) { addLog(`Group update error: ${e.message}`); }
    });
}

// ── Web Console ───────────────────────────────────────────────────────────────

// Endpoint: request a fresh pairing code via the dashboard button
app.get("/request-code", async (req, res) => {
    try {
        const cleanedNumber = BOT_NUMBER.replace(/[^0-9]/g, "");
        addLog(`🔑 Dashboard: Requesting new pairing code for ${cleanedNumber}...`);
        // sock is in outer scope via closure — reuse current socket
        const code = await globalSock.requestPairingCode(cleanedNumber);
        webPairingCode = `🔥 PAIR CODE: ${code}`;
        addLog(`🔑 New Pairing Code: ${code}`);
        res.json({ success: true, code });
    } catch (e) {
        addLog(`❌ Code request failed: ${e.message}`);
        res.json({ success: false, error: e.message });
    }
});

// Endpoint: get current logs as JSON (for live polling)
app.get("/logs", (req, res) => {
    res.json({ logs: statusLogs, status: webPairingCode, qr: currentQR });
});

app.get("/", (req, res) => {
    const isPairingMode = !webPairingCode.includes("Online");
    res.send(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Bot Pro Console</title>
        <style>
            * { box-sizing: border-box; }
            body { background: #0a0a0a; color: #e0e0e0; font-family: 'Segoe UI', sans-serif; margin: 0; padding: 16px; }
            .container { max-width: 900px; margin: auto; }
            .header { text-align: center; border-bottom: 2px solid #25D366; padding: 16px; margin-bottom: 16px; }
            .header h1 { color: #25D366; margin: 0; font-size: 1.4em; letter-spacing: 2px; }
            .header p  { color: #555; margin: 4px 0 0; font-size: 0.75em; }
            .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-bottom: 16px; }
            @media(max-width:600px){ .grid { grid-template-columns: 1fr; } }
            .card { background: #141414; border: 1px solid #222; border-radius: 12px; padding: 16px; }
            .card h3 { margin: 0 0 12px; color: #25D366; font-size: 0.85em; text-transform: uppercase; letter-spacing: 1px; }
            .status-text { font-size: 1em; font-weight: bold; color: #fff; word-break: break-all; line-height: 1.5; }
            .status-text.online { color: #25D366; }
            .status-text.code   { color: #FFD700; font-size: 1.6em; letter-spacing: 4px; }
            .btn { display: inline-block; margin-top: 12px; padding: 8px 18px; background: #25D366; color: #000;
                   border: none; border-radius: 8px; font-weight: bold; cursor: pointer; font-size: 0.85em; }
            .btn:hover { background: #1da851; }
            .btn.secondary { background: #1a1a1a; color: #25D366; border: 1px solid #25D366; margin-left: 8px; }
            #qr-box { text-align: center; }
            #qr-box img { width: 180px; height: 180px; border-radius: 8px; border: 2px solid #25D366; background: white; padding: 6px; }
            #qr-box p { color: #555; font-size: 0.75em; margin: 6px 0 0; }
            .terminal { background: #000; border-radius: 10px; padding: 16px; height: 360px; overflow-y: auto;
                        border: 1px solid #1a1a1a; font-family: 'Courier New', monospace; font-size: 0.78em; }
            .log { padding: 3px 0; border-bottom: 1px solid #0f0f0f; color: #00ff41; line-height: 1.4; }
            .log.err { color: #ff4444; }
            .log.warn { color: #FFD700; }
            .footer { text-align: center; margin-top: 20px; font-size: 0.72em; color: #333; }
            ::-webkit-scrollbar { width: 6px; }
            ::-webkit-scrollbar-thumb { background: #25D366; border-radius: 10px; }
            .dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 6px; background: #25D366; animation: pulse 1.5s infinite; }
            @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.3} }
            #toast { position: fixed; bottom: 20px; right: 20px; background: #25D366; color: #000;
                     padding: 10px 18px; border-radius: 8px; font-weight: bold; display: none; z-index: 999; }
        </style>
    </head>
    <body>
        <div id="toast"></div>
        <div class="container">
            <div class="header">
                <h1>⚡ BOT PRO CONSOLE</h1>
                <p>V4.2 · Baileys · Gemini 3.0 Flash · Node 20</p>
            </div>

            <div class="grid">
                <!-- Status / Pairing Card -->
                <div class="card">
                    <h3>🔌 Connection Status</h3>
                    <div id="status-text" class="status-text">${webPairingCode}</div>
                    ${isPairingMode ? `
                    <br>
                    <button class="btn" onclick="requestCode()">🔑 Generate New Code</button>
                    ` : `
                    <br>
                    <span><span class="dot"></span><span style="color:#25D366;font-size:0.85em">Live & Connected</span></span>
                    `}
                </div>

                <!-- QR Code Card -->
                <div class="card" id="qr-box">
                    <h3>📷 QR Code</h3>
                    <div id="qr-img-wrap">
                        <p style="color:#555;font-size:0.85em">QR code appears here when bot is in pairing mode.<br>Scan with WhatsApp → Linked Devices.</p>
                    </div>
                </div>
            </div>

            <!-- Live Terminal Logs -->
            <div class="card" style="margin-bottom:16px">
                <h3>📋 Live Logs <span style="float:right;font-size:0.8em;color:#555" id="log-time"></span></h3>
                <div class="terminal" id="terminal">
                    ${statusLogs.map(l => {
                        const cls = l.includes('❌') ? 'err' : l.includes('⚠️') ? 'warn' : '';
                        return `<div class="log ${cls}">${l}</div>`;
                    }).join('')}
                </div>
            </div>

            <div class="footer">Built for Stability · Render.com · Auto-refreshes every 5s</div>
        </div>

        <script>
            function showToast(msg, err) {
                const t = document.getElementById('toast');
                t.textContent = msg;
                t.style.background = err ? '#ff4444' : '#25D366';
                t.style.display = 'block';
                setTimeout(() => t.style.display = 'none', 3000);
            }

            async function requestCode() {
                showToast('Requesting new pairing code...');
                try {
                    const r = await fetch('/request-code');
                    const d = await r.json();
                    if (d.success) {
                        document.getElementById('status-text').textContent = '🔥 CODE: ' + d.code;
                        document.getElementById('status-text').className = 'status-text code';
                        showToast('✅ Code: ' + d.code);
                    } else {
                        showToast('❌ ' + d.error, true);
                    }
                } catch(e) {
                    showToast('❌ Request failed', true);
                }
            }

            // Live poll every 5 seconds
            async function pollLogs() {
                try {
                    const r = await fetch('/logs');
                    const d = await r.json();

                    // Update status
                    const st = document.getElementById('status-text');
                    if (st) st.textContent = d.status;

                    // Update terminal
                    const term = document.getElementById('terminal');
                    if (term && d.logs) {
                        term.innerHTML = d.logs.map(l => {
                            const cls = l.includes('❌') ? 'err' : l.includes('⚠️') ? 'warn' : '';
                            return '<div class="log ' + cls + '">' + l + '</div>';
                        }).join('');
                        term.scrollTop = 0;
                    }

                    // Update QR if available
                    const qrWrap = document.getElementById('qr-img-wrap');
                    if (d.qr && qrWrap) {
                        qrWrap.innerHTML = '<img src="https://api.qrserver.com/v1/create-qr-code/?size=180x180&data=' + encodeURIComponent(d.qr) + '" alt="QR Code" /><p>Scan in WhatsApp → Linked Devices</p>';
                    }

                    // Update log time
                    document.getElementById('log-time').textContent = new Date().toLocaleTimeString();
                } catch(e) {}
            }

            setInterval(pollLogs, 5000);
            pollLogs();
        </script>
    </body>
    </html>
    `);
});

// ── Boot ──────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
    addLog(`🌐 Web console on port ${PORT}`);
    startBot().catch(e => addLog(`BOOT ERROR: ${e.message}`));
});
