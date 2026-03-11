/**
==============================================================================
🚀 WHATSAPP BOT MASTER CONSOLE - ULTIMATE EDITION (V4.2.0)
==============================================================================
Author: Coding Partner AI
License: MIT
Build: High-Stability for Cloud Environments (Render/Heroku)
==============================================================================
*/

// --- DEPENDENCIES ---
const express = require("express");
const pino = require("pino");
const axios = require("axios");
const path = require("path");
const fs = require("fs");
const os = require("os");

// --- FIXED IMPORT LOGIC ---
const Baileys = require("@whiskeysockets/baileys");
const makeWASocket = Baileys.default || Baileys;
const {
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion,
    delay,
    jidDecode,
    getContentType,
    downloadContentFromMessage
} = Baileys;

// Explicitly grabbing makeInMemoryStore to fix the TypeError
const makeInMemoryStore = Baileys.makeInMemoryStore || Baileys.default?.makeInMemoryStore;

// --- SYSTEM INITIALIZATION ---
const app = express();
const PORT = process.env.PORT || 3000;

// Environment Variables Extraction
// On Render, ensure these are added in the "Environment" tab
const BOT_NUMBER = process.env.BOT_NUMBER; // Format: 2348000000000
const GEMINI_KEY = process.env.GEMINI_KEY;
const OWNER_NAME = process.env.OWNER_NAME || "System Admin";

// Global State Management
let autoReplyActive = false;
let antiLinkActive = true;
let chatMemory = {};
let statusLogs = [];
let startTime = Date.now();
let webPairingCode = "System Booting... Initializing Pairing Engine.";

// Memory Store for Baileys
const store = makeInMemoryStore({
    logger: pino().child({ level: 'silent', stream: 'store' })
});

// --- UTILITY FUNCTIONS ---

/**
 * Normalizes WhatsApp IDs
 */
function decodeJid(jid) {
    if (!jid) return jid;
    if (/:\d+@/gi.test(jid)) {
        let decode = jidDecode(jid) || {};
        return decode.user && decode.server && decode.user + '@' + decode.server || jid;
    } else return jid;
}

/**
 * Advanced Log System for the Web Dashboard
 */
function addLog(msg) {
    const time = new Date().toLocaleTimeString();
    const formattedLog = `[${time}] ${msg}`;
    console.log(formattedLog);
    statusLogs.unshift(formattedLog);
    if (statusLogs.length > 100) statusLogs.pop();
}

/**
 * Formats seconds into human-readable uptime
 */
function getUptime() {
    const duration = Date.now() - startTime;
    let seconds = Math.floor((duration / 1000) % 60);
    let minutes = Math.floor((duration / (1000 * 60)) % 60);
    let hours = Math.floor((duration / (1000 * 60 * 60)) % 24);
    return `${hours}h ${minutes}m ${seconds}s`;
}

// --- CORE VALIDATION ---
if (!BOT_NUMBER || !GEMINI_KEY) {
    console.error("❌ ERROR: Environment variables BOT_NUMBER or GEMINI_KEY missing.");
    addLog("❌ CRITICAL: Missing Env Vars. The bot will not function.");
}

/**
 * 🧠 GEMINI AI CORE WITH CONTEXT MEMORY
 */
async function askGemini(prompt, userJid) {
    try {
        if (!chatMemory[userJid]) {
            chatMemory[userJid] = [];
        }

        // Build context from the last 5 exchanges
        const context = chatMemory[userJid].join("\n");  
        const fullPrompt = context   
            ? `Previous context:\n${context}\n\nUser's new message: ${prompt}`   
            : `You are a helpful, professional WhatsApp AI assistant. Answer this: ${prompt}`;  

        const response = await axios.post(  
            `https://generativelanguage.googleapis.com/v1/models/gemini-pro:generateContent?key=${GEMINI_KEY}`,  
            { contents: [{ parts: [{ text: fullPrompt }] }] }  
        );  

        if (response.data && response.data.candidates) {  
            const aiText = response.data.candidates[0].content.parts[0].text;  

            // Update Memory (Keep last 5 exchanges = 10 messages)  
            chatMemory[userJid].push(`User: ${prompt}`);  
            chatMemory[userJid].push(`AI: ${aiText}`);  
            if (chatMemory[userJid].length > 10) chatMemory[userJid].splice(0, 2);   

            return aiText;  
        }  
        return "🤖 AI: I'm having trouble processing that right now.";
    } catch (error) {
        addLog(`⚠️ Gemini API Error: ${error.message}`);
        return "⚠️ AI engine error. Please check your API quota.";
    }
}

/**
 * 🚀 MAIN BOT EXECUTION ENGINE
 */
async function startBot() {
    addLog("📦 Loading Authentication State...");
    
    // Ensure 'session' directory exists for Docker environments
    const sessionDir = path.join(__dirname, 'session');
    if (!fs.existsSync(sessionDir)) {
        fs.mkdirSync(sessionDir);
    }

    const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
        version,
        logger: pino({ level: "silent" }),
        auth: state,
        printQRInTerminal: false,
        browser: ["Chrome (Ubuntu)", "Render", "1.0.0"],
        syncFullHistory: false,
        markOnlineOnConnect: true,
        connectTimeoutMs: 60000,
        getMessage: async (key) => {
            if (store) {
                const msg = await store.loadMessage(key.remoteJid, key.id);
                return msg?.message || undefined;
            }
            return { conversation: "System Message Placeholder" };
        }
    });

    store.bind(sock.ev);
    sock.ev.on("creds.update", saveCreds);

    // Connection Handler
    sock.ev.on("connection.update", async (update) => {
        const { connection, lastDisconnect, pairingCode } = update;

        if (connection === "close") {  
            const reason = lastDisconnect?.error?.output?.statusCode;  
            addLog(`🔄 Connection Closed. Reason Code: ${reason}`);  
            
            if (reason !== DisconnectReason.loggedOut) {  
                addLog("♻️ Attempting Reconnection...");  
                startBot();  
            } else {  
                addLog("❌ Logged out. Manual intervention required (Delete session folder).");  
            }  
        }  

        if (connection === "open") {  
            addLog("✅ WHATSAPP AUTHENTICATION SUCCESSFUL");  
            const botId = decodeJid(sock.user.id);  
            webPairingCode = "✅ Bot Online & Connected";  

            // Startup Broadcast
            await sock.sendMessage(botId, {   
                text: `🚀 *Bot System v4.2 Online*\n\n*Host:* Render\n*Uptime:* ${getUptime()}\n*Owner:* ${OWNER_NAME}\n\nType *.menu* to begin.`   
            });  
        }
    });

    // Pairing Code logic for Headless Servers
    if (!sock.authState.creds.registered && BOT_NUMBER) {
        setTimeout(async () => {
            try {
                const cleanedNumber = BOT_NUMBER.replace(/[^0-9]/g, "");
                addLog(`🔑 Requesting Pair Code for: ${cleanedNumber}`);
                const code = await sock.requestPairingCode(cleanedNumber);
                webPairingCode = `🔥 YOUR PAIR CODE: ${code}`;
                addLog(`🔥 PAIRING CODE GENERATED: ${code}`);
            } catch (err) {
                addLog(`❌ Pairing Error: ${err.message}`);
            }
        }, 10000); // 10s delay to ensure socket is ready
    }

    /**
     * 📩 MESSAGE UPSERT HANDLER (The "Brain")
     */
    sock.ev.on("messages.upsert", async ({ messages }) => {
        try {
            const m = messages[0];
            if (!m.message || m.key.remoteJid === 'status@broadcast') return;

            const from = m.key.remoteJid;  
            const isGroup = from.endsWith("@g.us");  
            const isFromMe = m.key.fromMe;  
            const sender = isGroup ? m.key.participant : from;  
            const botNumber = decodeJid(sock.user.id);  

            // Content Extraction  
            const type = getContentType(m.message);
            const body = (type === 'conversation') ? m.message.conversation :  
                         (type === 'extendedTextMessage') ? m.message.extendedTextMessage.text :  
                         (type === 'imageMessage') ? m.message.imageMessage.caption :  
                         (type === 'videoMessage') ? m.message.videoMessage.caption : "";  

            const text = body.trim();  
            const isCmd = text.startsWith(".");
            const command = isCmd ? text.slice(1).trim().split(/ +/).shift().toLowerCase() : null;
            const args = text.trim().split(/ +/).slice(1);
            const query = args.join(" ");

            if (text) {  
                addLog(`📩 [${isFromMe ? 'OWNER' : 'USER'}] ${from.split('@')[0]}: ${text.substring(0, 40)}`);  
            }  

            // --- SECURITY: OWNER-ONLY BLOCK ---
            // If it's a command but not from you, block it unless it's a public command
            if (isCmd && !isFromMe) {
                // List of commands anyone can use
                const publicCmds = ['ai', 'ping', 'alive', 'joke', 'fact'];
                if (!publicCmds.includes(command)) {
                    return; // Silent block for security
                }
            }

            // --- ANTI-LINK (Group Guard) ---  
            if (isGroup && antiLinkActive && text.includes("chat.whatsapp.com") && !isFromMe) {  
                await sock.sendMessage(from, { delete: m.key });  
                return await sock.sendMessage(from, { text: "🚫 *Link Detected:* External links are not allowed here." });  
            }  

            // --- COMMAND LOGIC ---
            switch (command) {
                case 'menu':
                case 'help':
                    const menu = `
👑 *MASTER CONSOLE V4.2* 👑
_Powered by Gemini AI_

*⚡ AUTOMATION*
.autoreply [on/off]
.antilink [on/off]
Current: ${autoReplyActive ? '🟢' : '🔴'} | Guard: ${antiLinkActive ? '🛡️' : '⚪'}

*🛡️ GROUP ADMIN*
.promote - Grant Admin
.demote - Remove Admin
.kick - Remove User
.tagall - Mention Everyone
.hidetag - Ghost Mention

*🧠 AI ENGINE*
.ai <query> - Ask Gemini
.clear - Reset Chat History

*🛠️ UTILITIES*
.ping - Test Latency
.status - System Stats
.runtime - Up-time
.owner - Contact Details

*🎭 FUN & INFO*
.quote | .joke | .fact
.weather <city>
.news | .translate <txt>`;
                    await sock.sendMessage(from, { text: menu });
                    break;

                case 'ping':
                    const start = Date.now();
                    const pingMsg = await sock.sendMessage(from, { text: "Testing Latency..." });
                    const end = Date.now();
                    await sock.sendMessage(from, { 
                        text: `🚀 *Response:* ${end - start}ms`, 
                        edit: pingMsg.key 
                    });
                    break;

                case 'status':
                    const usedMem = process.memoryUsage().heapUsed / 1024 / 1024;
                    const totalMem = os.totalmem() / 1024 / 1024 / 1024;
                    const statusText = `
📊 *SYSTEM DIAGNOSTICS*
---
*CPU:* ${os.cpus()[0].model}
*Memory:* ${usedMem.toFixed(2)} MB / ${totalMem.toFixed(2)} GB
*Platform:* ${os.platform()}
*Uptime:* ${getUptime()}
*Node:* ${process.version}`;
                    await sock.sendMessage(from, { text: statusText });
                    break;

                case 'ai':
                    if (!query) return await sock.sendMessage(from, { text: "❓ Please provide a question for Gemini." });
                    await sock.sendMessage(from, { text: "_Processing request..._" });
                    const aiResult = await askGemini(query, from);
                    await sock.sendMessage(from, { text: aiResult });
                    break;

                case 'autoreply':
                    if (!query) return await sock.sendMessage(from, { text: "Usage: .autoreply on/off" });
                    autoReplyActive = query === "on";
                    await sock.sendMessage(from, { text: `🤖 AI Smart Reply: *${autoReplyActive ? 'ENABLED' : 'DISABLED'}*` });
                    break;

                case 'antilink':
                    antiLinkActive = query === "on";
                    await sock.sendMessage(from, { text: `🛡️ Link Guard: *${antiLinkActive ? 'ENABLED' : 'DISABLED'}*` });
                    break;

                case 'tagall':
                    if (!isGroup) return;
                    const groupMeta = await sock.groupMetadata(from);
                    let tagText = `📢 *Attention Participants*\n\n${query || 'No Message'}\n\n`;
                    let participants = groupMeta.participants.map(p => p.id);
                    for (let p of participants) {
                        tagText += `• @${p.split("@")[0]}\n`;
                    }
                    await sock.sendMessage(from, { text: tagText, mentions: participants });
                    break;

                case 'kick':
                    if (!isGroup) return;
                    let target = m.message.extendedTextMessage?.contextInfo?.mentionedJid?.[0] || m.message.extendedTextMessage?.contextInfo?.participant;
                    if (!target) return await sock.sendMessage(from, { text: "⚠️ Reply to or tag a user to kick." });
                    await sock.groupParticipantsUpdate(from, [target], "remove");
                    await sock.sendMessage(from, { text: "👢 Target has been removed." });
                    break;

                case 'joke':
                    const jokeRes = await axios.get("https://official-joke-api.appspot.com/random_joke").catch(() => null);
                    if (jokeRes) await sock.sendMessage(from, { text: `*${jokeRes.data.setup}*\n\n${jokeRes.data.punchline}` });
                    break;

                case 'fact':
                    const factRes = await axios.get("https://uselessfacts.jsph.pl/random.json?language=en").catch(() => null);
                    if (factRes) await sock.sendMessage(from, { text: `💡 *Did you know?*\n${factRes.data.text}` });
                    break;

                case 'weather':
                    if (!query) return await sock.sendMessage(from, { text: "Please provide a city name." });
                    // Simple placeholder for weather logic
                    await sock.sendMessage(from, { text: `🌤️ Weather feature for *${query}* is currently under maintenance.` });
                    break;

                default:
                    // Auto-Reply Logic for DMs
                    if (autoReplyActive && !isGroup && !isFromMe && text.length > 3) {
                        const autoAi = await askGemini(text, from);
                        await sock.sendMessage(from, { text: `🧠 *Assistant:* ${autoAi}` });
                    }
                    break;
            }

        } catch (err) {  
            addLog(`❌ Command Error: ${err.message}`); 
        }  
    });  

    // Handle Join Events
    sock.ev.on("group-participants.update", async (update) => {  
        try {  
            const { id, participants, action } = update;
            const metadata = await sock.groupMetadata(id);  
            if (action === "add") {  
                for (const user of participants) {  
                    await sock.sendMessage(id, { 
                        text: `👋 Welcome @${user.split("@")[0]} to *${metadata.subject}*!`, 
                        mentions: [user] 
                    });  
                }  
            }  
        } catch (e) { console.error(e); }  
    });
}

/**
 * 🌐 ENHANCED WEB CONSOLE (CSS3 + Real-time display)
 */
app.get("/", (req, res) => {
    const htmlContent = `
    <!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Bot Pro Console V4.2</title>
        <style>
            :root { --main-bg: #0a0b10; --card-bg: #161b22; --accent: #25D366; --text: #e6edf3; }
            body { background: var(--main-bg); color: var(--text); font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; margin: 0; padding: 20px; }
            .container { max-width: 900px; margin: auto; }
            .card { background: var(--card-bg); border-radius: 12px; padding: 25px; margin-bottom: 20px; border: 1px solid #30363d; box-shadow: 0 4px 12px rgba(0,0,0,0.5); }
            .header { text-align: center; border-bottom: 2px solid var(--accent); padding-bottom: 15px; }
            .status-badge { display: inline-block; padding: 8px 15px; border-radius: 20px; background: rgba(37, 211, 102, 0.1); color: var(--accent); font-weight: bold; border: 1px solid var(--accent); }
            .terminal { background: #000; border-radius: 8px; padding: 15px; height: 350px; overflow-y: auto; font-family: 'Courier New', Courier, monospace; font-size: 14px; border: 1px solid #444; }
            .log-line { border-bottom: 1px solid #1a1a1a; padding: 5px 0; color: #a5d6ff; }
            .log-line:last-child { border: none; }
            .stats-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 15px; margin-top: 15px; }
            .stat-item { background: #0d1117; padding: 15px; border-radius: 8px; text-align: center; border: 1px solid #30363d; }
            .stat-val { font-size: 1.2em; font-weight: bold; color: var(--accent); }
            .stat-label { font-size: 0.8em; color: #8b949e; text-transform: uppercase; }
        </style>
    </head>
    <body>
        <div class="container">
            <div class="card header">
                <h1>WHATSAPP BOT CONSOLE</h1>
                <div class="status-badge">${webPairingCode}</div>
            </div>
            
            <div class="stats-grid">
                <div class="stat-item"><div class="stat-val">${os.platform()}</div><div class="stat-label">Platform</div></div>
                <div class="stat-item"><div class="stat-val">${getUptime()}</div><div class="stat-label">Uptime</div></div>
                <div class="stat-item"><div class="stat-val">${(process.memoryUsage().heapUsed / 1024 / 1024).toFixed(1)} MB</div><div class="stat-label">Memory</div></div>
            </div>

            <div class="card">
                <h3>Live System Logs</h3>
                <div class="terminal">
                    ${statusLogs.map(l => `<div class="log-line">${l}</div>`).join('')}
                </div>
            </div>
            <div style="text-align:center; color:#555; font-size:12px;">Refreshes every 10 seconds</div>
        </div>
        <script>setTimeout(() => location.reload(), 10000);</script>
    </body>
    </html>`;
    res.send(htmlContent);
});

// Start the Express Server and the Bot
app.listen(PORT, '0.0.0.0', () => {
    addLog(`🚀 WEB CONSOLE: http://localhost:${PORT}`);
    startBot().catch(err => addLog(`❌ BOOT ERROR: ${err.message}`));
});
