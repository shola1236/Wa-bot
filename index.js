/**
 * ==============================================================================
 * 🚀 WHATSAPP BOT MASTER CONSOLE - ULTIMATE EDITION (V4.1.0)
 * ==============================================================================
 * Build Version: 4.1.0 (High-Stability for Render.com)
 * Security Architecture: EXCLUSIVE "fromMe" Gatekeeping
 * * FEATURES INCLUDED:
 * 1.  Strict Owner-Only Access (via Bot Account)
 * 2.  Gemini AI Integration (Manual & Auto-Mode)
 * 3.  Smart Context Memory (Remembers previous 5 messages)
 * 4.  Full Group Administration (Promote, Demote, Kick, KickAll)
 * 5.  Mass Communication Tools (TagAll, HideTag)
 * 6.  Automated Anti-Link System
 * 7.  External Utility APIs (Quotes, Jokes, Facts, Time, Date)
 * 8.  Enhanced Web Dashboard with CSS3 & Real-time Logs
 * * ⚠️ RENDER DEPLOYMENT NOTE: 
 * Ensure BOT_NUMBER and GEMINI_KEY are set in Environment Variables.
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
const makeInMemoryStore = require("@whiskeysockets/baileys").makeInMemoryStore || (() => ({ bind: () => {}, readFromFile: () => {}, writeToFile: () => {} }));

// --- SYSTEM INITIALIZATION ---
const app = express();
const PORT = process.env.PORT || 3000;

// Environment Variables Extraction
const BOT_NUMBER = process.env.BOT_NUMBER;
const GEMINI_KEY = process.env.GEMINI_KEY;

// Global State Management
let autoReplyActive = false; 
let antiLinkActive = true;
let chatMemory = {}; 
let statusLogs = [];
let webPairingCode = "System Booting... Waiting for Pairing Engine.";

// Baileys Store to maintain session memory and message tracking
const store = makeInMemoryStore({ 
    logger: pino().child({ level: 'silent', stream: 'store' }) 
});

/**
 * 🧠 UTILITY: DECODE JID
 */
function decodeJid(jid) {
    if (!jid) return jid;
    if (/:\d+@/gi.test(jid)) {
        let decode = jidDecode(jid) || {};
        return decode.user && decode.server && decode.user + '@' + decode.server || jid;
    } else return jid;
}

/**
 * 📝 ADVANCED LOGGING SYSTEM
 */
function addLog(msg) {
    const time = new Date().toLocaleTimeString();
    const formattedLog = `[${time}] ${msg}`;
    console.log(formattedLog); 
    statusLogs.unshift(formattedLog); 
    if (statusLogs.length > 100) statusLogs.pop(); 
}

// Critical Validation before Boot
if (!BOT_NUMBER || !GEMINI_KEY) {
    console.error("❌ CRITICAL FAILURE: Environment variables (BOT_NUMBER/GEMINI_KEY) missing.");
    process.exit(1);
}

/**
 * 🧠 GEMINI AI CORE WITH CONTEXT MEMORY
 */
async function askGemini(prompt, userJid) {
    try {
        if (!chatMemory[userJid]) {
            chatMemory[userJid] = [];
        }

        const context = chatMemory[userJid].join("\n");
        const fullPrompt = context 
            ? `Context of our last few messages:\n${context}\n\nNew User Input: ${prompt}` 
            : `You are a helpful WhatsApp AI assistant. User says: ${prompt}`;

        const response = await axios.post(
            `https://generativelanguage.googleapis.com/v1/models/gemini-pro:generateContent?key=${GEMINI_KEY}`,
            {
                contents: [{
                    parts: [{ text: fullPrompt }]
                }]
            }
        );
        
        if (response.data && response.data.candidates) {
            const aiText = response.data.candidates[0].content.parts[0].text;
            
            // Update Memory (Keep last 5 exchanges)
            chatMemory[userJid].push(`User: ${prompt}`);
            chatMemory[userJid].push(`AI: ${aiText}`);
            if (chatMemory[userJid].length > 10) chatMemory[userJid].splice(0, 2); 
            
            return aiText;
        }
        return "🤖 AI: I am currently processing too much data. Try again shortly.";
    } catch (error) {
        addLog(`⚠️ Gemini API Error: ${error.response?.data?.error?.message || error.message}`);
        return "⚠️ AI engine error. Please check your API quota or connection.";
    }
}

/**
 * 🚀 MAIN BOT EXECUTION ENGINE
 */
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
            if (store) {
                const msg = await store.loadMessage(key.remoteJid, key.id);
                return msg?.message || undefined;
            }
            return { conversation: "Hello, I am the bot" };
        }
    });

    store.bind(sock.ev);
    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", async (update) => {
        const { connection, lastDisconnect } = update;

        if (connection === "close") {
            const reason = lastDisconnect?.error?.output?.statusCode;
            addLog(`🔄 Connection Closed. Reason: ${reason}`);
            const shouldReconnect = reason !== DisconnectReason.loggedOut;
            if (shouldReconnect) {
                addLog("♻️ Attempting automatic reconnection...");
                startBot();
            } else {
                addLog("❌ Logged out. Delete 'session' folder and restart.");
            }
        }

        if (connection === "open") {
            addLog("✅ WHATSAPP CONNECTION ESTABLISHED");
            sock.user.id = decodeJid(sock.user.id);
            webPairingCode = "✅ Bot is Online and Guarding!";
            
            // Send startup notification to self
            await sock.sendMessage(sock.user.id, { 
                text: "🚀 *Bot System Online*\n\nHost: Render Cloud\nTime: " + new Date().toLocaleString() + "\nType *.menu* to begin." 
            });
        }
    });

    // Pairing Code Sequence
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

    /**
     * 📩 MESSAGE UPSERT HANDLER
     */
    sock.ev.on("messages.upsert", async ({ messages, type }) => {
        try {
            const msg = messages[0];
            if (!msg.message || msg.key.remoteJid === 'status@broadcast') return;

            const from = msg.key.remoteJid;
            const isGroup = from.endsWith("@g.us");
            const isFromMe = msg.key.fromMe;
            const sender = isGroup ? msg.key.participant : from;
            const botNumber = decodeJid(sock.user.id);

            // Content Extraction
            const messageType = Object.keys(msg.message)[0];
            const messageText = (messageType === 'conversation') ? msg.message.conversation :
                                (messageType === 'extendedTextMessage') ? msg.message.extendedTextMessage.text :
                                (messageType === 'imageMessage') ? msg.message.imageMessage.caption :
                                (messageType === 'videoMessage') ? msg.message.videoMessage.caption : "";

            const cleanText = messageText.trim();
            const command = cleanText.split(/\s+/)[0].toLowerCase();
            const args = cleanText.split(/\s+/).slice(1);
            const query = args.join(" ");

            if (cleanText) {
                addLog(`📩 [${isFromMe ? 'OWNER' : 'USER'}] ${from.split('@')[0]}: ${cleanText.substring(0, 30)}`);
            }

            // --- GLOBAL SECURITY GATEKEEPER ---
            if (command.startsWith(".") && !isFromMe) {
                addLog(`🚫 Blocked: ${command} from unauthorized sender.`);
                return;
            }

            // --- ANTI-LINK SYSTEM ---
            if (isGroup && antiLinkActive && cleanText.includes("chat.whatsapp.com") && !isFromMe) {
                await sock.sendMessage(from, { delete: msg.key });
                return await sock.sendMessage(from, { text: "🚫 *Link Detected:* External group links are forbidden." });
            }

            // --- COMMAND REGISTRY ---

            // 1. SYSTEM INFO
            if (command === ".menu" || command === ".help") {
                const menu = `👑 *MASTER CONSOLE V4.1* 👑

*--- ⚡ AUTOMATION ---*
.autoreply on | off  - AI Mode
.antilink on | off   - Link Guard
_AutoReply: ${autoReplyActive ? '🟢' : '🔴'}_

*--- 🛡️ ADMIN POWER ---*
.promote    - Grant Admin
.demote     - Remove Admin
.kick       - Remove User
.kickall    - Wipe Group
.tagall     - Mention All
.hidetag    - Ghost Tag

*--- 🧠 AI & ENGINE ---*
.ai <query> - Ask Gemini
.clear      - Reset AI
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
                autoReplyActive = query === "on";
                return await sock.sendMessage(from, { text: `🤖 AI Smart Mode: *${autoReplyActive ? 'ENABLED' : 'DISABLED'}*` });
            }

            if (command === ".antilink") {
                antiLinkActive = query === "on";
                return await sock.sendMessage(from, { text: `🛡️ Link Guard: *${antiLinkActive ? 'ENABLED' : 'DISABLED'}*` });
            }

            // 3. AI EXECUTION
            if (!command.startsWith(".") && autoReplyActive && isFromMe && cleanText.length > 2) {
                const aiRes = await askGemini(cleanText, from);
                return await sock.sendMessage(from, { text: `🧠 *Assistant:* ${aiRes}` });
            }

            if (command === ".ai" || command === ".gpt") {
                if (!query) return await sock.sendMessage(from, { text: "❓ Ask me something." });
                await sock.sendMessage(from, { text: "_Thinking..._" });
                const aiRes = await askGemini(query, from);
                return await sock.sendMessage(from, { text: aiRes });
            }

            if (command === ".clear") {
                chatMemory[from] = [];
                return await sock.sendMessage(from, { text: "🧹 *AI Memory Cleared.*" });
            }

            // 4. ADMIN TOOLS
            if (isGroup) {
                const groupMetadata = await sock.groupMetadata(from);
                const participants = groupMetadata.participants;

                if (command === ".promote") {
                    let user = msg.message.extendedTextMessage?.contextInfo?.mentionedJid?.[0] || msg.message.extendedTextMessage?.contextInfo?.participant;
                    if (!user) return await sock.sendMessage(from, { text: "⚠️ Reply to or tag a user." });
                    await sock.groupParticipantsUpdate(from, [user], "promote");
                    return await sock.sendMessage(from, { text: "✅ Done." });
                }

                if (command === ".demote") {
                    let user = msg.message.extendedTextMessage?.contextInfo?.mentionedJid?.[0] || msg.message.extendedTextMessage?.contextInfo?.participant;
                    if (!user) return await sock.sendMessage(from, { text: "⚠️ Reply to or tag a user." });
                    await sock.groupParticipantsUpdate(from, [user], "demote");
                    return await sock.sendMessage(from, { text: "✅ Done." });
                }

                if (command === ".kick") {
                    let user = msg.message.extendedTextMessage?.contextInfo?.mentionedJid?.[0] || msg.message.extendedTextMessage?.contextInfo?.participant;
                    if (!user) return await sock.sendMessage(from, { text: "⚠️ Tag the user." });
                    await sock.groupParticipantsUpdate(from, [user], "remove");
                    return await sock.sendMessage(from, { text: "👢 Removed." });
                }

                if (command === ".kickall") {
                    await sock.sendMessage(from, { text: "☢️ *PURGE STARTING...*" });
                    for (let p of participants) {
                        if (p.id !== botNumber && !p.admin) {
                            await sock.groupParticipantsUpdate(from, [p.id], "remove");
                            await delay(800);
                        }
                    }
                    return await sock.sendMessage(from, { text: "🧹 Purge complete." });
                }

                if (command === ".tagall") {
                    let txt = `📢 *Attention Participants*\n\n*Msg:* ${query || 'None'}\n\n`;
                    let mentions = [];
                    for (let p of participants) {
                        mentions.push(p.id);
                        txt += `• @${p.id.split("@")[0]}\n`;
                    }
                    return await sock.sendMessage(from, { text: txt, mentions });
                }

                if (command === ".hidetag") {
                    const mentions = participants.map(p => p.id);
                    return await sock.sendMessage(from, { text: query || "Hidden alert!", mentions });
                }
            }

            // 5. UTILITIES
            if (command === ".ping") {
                const start = Date.now();
                await sock.sendMessage(from, { text: "Calculating..." });
                const end = Date.now();
                return await sock.sendMessage(from, { text: `🚀 *Latency:* ${end - start}ms` });
            }

            if (command === ".alive") {
                return await sock.sendMessage(from, { text: "🟢 *Status:* System Operational\n☁️ *Host:* Render Cloud\n⚡ *Engine:* Baileys v5" });
            }

            if (command === ".time") return await sock.sendMessage(from, { text: `🕙 ${new Date().toLocaleTimeString()}` });
            if (command === ".date") return await sock.sendMessage(from, { text: `📅 ${new Date().toDateString()}` });

            // 6. EXTERNAL APIS
            if (command === ".quote") {
                const res = await axios.get("https://api.quotable.io/random").catch(() => null);
                if (!res) return await sock.sendMessage(from, { text: "❌ API Offline." });
                return await sock.sendMessage(from, { text: `“${res.data.content}”\n— *${res.data.author}*` });
            }

            if (command === ".joke") {
                const res = await axios.get("https://official-joke-api.appspot.com/random_joke").catch(() => null);
                if (!res) return await sock.sendMessage(from, { text: "❌ API Offline." });
                return await sock.sendMessage(from, { text: `*${res.data.setup}*\n\n${res.data.punchline}` });
            }

            if (command === ".fact") {
                const res = await axios.get("https://uselessfacts.jsph.pl/random.json?language=en").catch(() => null);
                if (!res) return await sock.sendMessage(from, { text: "❌ API Offline." });
                return await sock.sendMessage(from, { text: `💡 *Fact:* ${res.data.text}` });
            }

            // 7. FUN
            if (command === ".flip") return await sock.sendMessage(from, { text: `🪙 Result: *${Math.random() > 0.5 ? "HEADS" : "TAILS"}*` });
            if (command === ".dice") return await sock.sendMessage(from, { text: `🎲 Roll: *${Math.floor(Math.random() * 6) + 1}*` });
            if (command === ".8ball") {
                const res = ["Yes", "No", "Maybe", "Ask later", "Definitely", "Highly Doubtful"];
                return await sock.sendMessage(from, { text: `🎱 *Oracle:* ${res[Math.floor(Math.random() * res.length)]}` });
            }

        } catch (err) {
            addLog(`❌ Logic Error: ${err.message}`);
        }
    });

    // Auto-Greeting
    sock.ev.on("group-participants.update", async (data) => {
        try {
            const metadata = await sock.groupMetadata(data.id);
            for (const user of data.participants) {
                const userNum = user.split("@")[0];
                if (data.action === "add") {
                    await sock.sendMessage(data.id, { text: `👋 Welcome @${userNum} to ${metadata.subject}!`, mentions: [user] });
                }
            }
        } catch (e) { console.log(e); }
    });
}

    /**
     * 🌐 ENHANCED WEB CONSOLE WITH RESET CONTROL
     */
    app.get("/", (req, res) => {
        res.send(`
        <!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>Bot Pro Console</title>
            <style>
                body { background: #0c0c0c; color: #e0e0e0; font-family: 'Segoe UI', sans-serif; margin: 0; padding: 20px; }
                .container { max-width: 1000px; margin: auto; }
                .header { text-align: center; border-bottom: 2px solid #25D366; padding: 20px; }
                .status-box { background: #1a1a1a; padding: 20px; border-radius: 15px; text-align: center; margin: 20px 0; border: 1px solid #333; }
                .status-box h2 { color: #25D366; margin: 0; }
                .btn-reset { 
                    background: #ff4b2b; color: white; border: none; padding: 10px 20px; 
                    border-radius: 5px; cursor: pointer; font-weight: bold; margin-top: 10px;
                    transition: 0.3s;
                }
                .btn-reset:hover { background: #ff416c; transform: scale(1.05); }
                .terminal { background: #000; border-radius: 10px; padding: 20px; height: 400px; overflow-y: auto; border: 1px solid #444; font-family: monospace; }
                .log { margin-bottom: 10px; border-bottom: 1px solid #111; padding-bottom: 5px; color: #00ff41; }
                .footer { text-align: center; margin-top: 30px; font-size: 0.8em; color: #555; }
                ::-webkit-scrollbar { width: 8px; }
                ::-webkit-scrollbar-thumb { background: #25D366; border-radius: 10px; }
            </style>
        </head>
        <body>
            <div class="container">
                <div class="header"><h1>BOT PRO CONSOLE</h1></div>
                <div class="status-box">
                    <h2>${webPairingCode}</h2>
                    <button class="btn-reset" onclick="confirmReset()">🔄 Request New Pairing Code</button>
                </div>
                <div class="terminal">
                    ${statusLogs.map(l => `<div class="log">${l}</div>`).join('')}
                </div>
                <div class="footer">Built for Stability | Node.js v20.x | Baileys v5</div>
            </div>
            <script>
                function confirmReset() {
                    if(confirm("This will delete your current session and restart the bot. Continue?")) {
                        window.location.href = "/reset-session";
                    }
                }
                setTimeout(() => location.reload(), 15000);
            </script>
        </body>
        </html>
        `);
    });

    /**
     * ⚡ RESET ROUTE: Nukes the session and restarts
     */
    app.get("/reset-session", (req, res) => {
        addLog("⚠️ MANUAL RESET TRIGGERED: Deleting session...");
        try {
            const sessionPath = path.join(__dirname, "session");
            if (fs.existsSync(sessionPath)) {
                fs.rmSync(sessionPath, { recursive: true, force: true });
            }
            res.send("<h1>Session Deleted. Bot is restarting...</h1><script>setTimeout(()=>window.location.href='/', 5000)</script>");
            setTimeout(() => process.exit(0), 1000);
        } catch (err) {
            res.status(500).send("Error resetting session: " + err.message);
        }
    });

    app.listen(PORT, () => {
        addLog(`🌐 Web Server active on Port ${PORT}`);
        startBot().catch(err => addLog(`🚀 Startup Error: ${err.message}`));
    });
}

// Start the whole system
startBot();
