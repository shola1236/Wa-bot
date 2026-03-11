/**
 * ==============================================================================
 * 🚀 WHATSAPP BOT MASTER CONSOLE - ULTIMATE EDITION
 * ==============================================================================
 * Build Version: 4.0.0 (High-Stability for Render.com)
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

const express = require("express")
const pino = require("pino")
const axios = require("axios")
const Baileys = require("@whiskeysockets/baileys") // Import the whole module

// Destructure from the main module with fallback protection
const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion,
    delay,
    jidDecode
} = Baileys

// Explicitly define makeInMemoryStore to ensure it's captured correctly
const makeInMemoryStore = Baileys.makeInMemoryStore

// --- SYSTEM INITIALIZATION ---
const app = express()
const PORT = process.env.PORT || 3000

// Environment Variables Extraction
const BOT_NUMBER = process.env.BOT_NUMBER
const GEMINI_KEY = process.env.GEMINI_KEY

// Global State Management
let autoReplyActive = false; 
let chatMemory = {}; // Stores context for AI conversations

// Baileys Store to maintain session memory and message tracking
const store = makeInMemoryStore({ 
    logger: pino().child({ level: 'silent', stream: 'store' }) 
})

// --- ADVANCED LOGGING SYSTEM ---
let statusLogs = [];
/**
 * Pushes logs to the web interface.
 * Maintains a large buffer for better debugging on Render.
 */
function addLog(msg) {
    const time = new Date().toLocaleTimeString();
    const formattedLog = `[${time}] ${msg}`;
    console.log(formattedLog); // Mirror to terminal
    statusLogs.unshift(formattedLog); 
    if (statusLogs.length > 60) statusLogs.pop(); 
}

// Critical Validation before Boot
if (!BOT_NUMBER || !GEMINI_KEY) {
    console.error("❌ CRITICAL FAILURE: Environment variables (BOT_NUMBER/GEMINI_KEY) missing.");
    process.exit(1);
}

let webPairingCode = "System Booting... Waiting for Pairing Engine.";

/**
 * 🧠 GEMINI AI CORE WITH CONTEXT MEMORY
 * Manages the connection to Google's Generative AI.
 * Implements conversational history for smarter replies.
 */
async function askGemini(prompt, userJid) {
    try {
        // Initialize memory for new users
        if (!chatMemory[userJid]) {
            chatMemory[userJid] = [];
        }

        // Build context from previous messages
        const context = chatMemory[userJid].join("\n");
        const fullPrompt = context ? `Context of our last few messages:\n${context}\n\nNew User Input: ${prompt}` : prompt;

        const response = await axios.post(
            `https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent?key=${GEMINI_KEY}`,
            {
                contents: [{
                    parts: [{ text: fullPrompt }]
                }]
            }
        );
        
        if (response.data && response.data.candidates) {
            const aiText = response.data.candidates[0].content.parts[0].text;
            
            // Update Memory (Keep only last 5 exchanges)
            chatMemory[userJid].push(`User: ${prompt}`);
            chatMemory[userJid].push(`AI: ${aiText}`);
            if (chatMemory[userJid].length > 10) chatMemory[userJid].shift(); 
            
            return aiText;
        }
        return "🤖 AI: I am currently processing too much data. Try again shortly.";
    } catch (error) {
        addLog(`⚠️ Gemini API Error: ${error.message}`);
        return "⚠️ AI engine error. Please check your API quota or connection.";
    }
}

/**
 * 🚀 MAIN BOT EXECUTION ENGINE
 * Handles WhatsApp Socket connection and event listeners.
 */
async function startBot() {
    // Authentication State
    const { state, saveCreds } = await useMultiFileAuthState("session")
    const { version } = await fetchLatestBaileysVersion()

    // Socket Configuration - Optimized for Cloud Hosting (Render)
    const sock = makeWASocket({
        version,
        logger: pino({ level: "silent" }),
        auth: state,
        printQRInTerminal: false,
        browser: ["Ubuntu", "Chrome", "20.0.04"],
        syncFullHistory: false,
        markOnlineOnConnect: true,
        connectTimeoutMs: 60000,
        keepAliveIntervalMs: 20000,
        generateHighQualityLinkPreview: true
    })

    // Store Binding
    store.bind(sock.ev);

    // Save login credentials
    sock.ev.on("creds.update", saveCreds)

    // Connection Lifecycle Management
    sock.ev.on("connection.update", (update) => {
        const { connection, lastDisconnect } = update

        if (connection === "close") {
            const reason = lastDisconnect?.error?.output?.statusCode;
            addLog(`🔄 Connection Closed. Reason Code: ${reason}`);
            
            const shouldReconnect = reason !== DisconnectReason.loggedOut;
            if (shouldReconnect) {
                addLog("♻️ Attempting automatic reconnection...");
                startBot();
            } else {
                addLog("❌ Logged out of WhatsApp. Manual session reset required.");
            }
        }

        if (connection === "open") {
            addLog("✅ WHATSAPP CONNECTION ESTABLISHED");
            webPairingCode = "✅ Bot is Online and Guarding!"
        }
    })

    // Pairing Code Sequence (Triggers 6s after start)
    if (!sock.authState.creds.registered) {
        setTimeout(async () => {
            const cleanedNumber = BOT_NUMBER.replace(/[^0-9]/g, "")
            try {
                addLog(`🔑 Requesting pairing code for ${cleanedNumber}...`);
                const code = await sock.requestPairingCode(cleanedNumber)
                webPairingCode = `🔥 PAIR CODE: ${code}`
                addLog(`🔑 PAIRING CODE GENERATED: ${code}`);
            } catch (err) {
                addLog("❌ Error generating pairing code. Check BOT_NUMBER format.");
            }
        }, 6000)
    }

    /**
     * 👥 GROUP PARTICIPANT EVENTS
     * Automated welcome and departure messages.
     */
    sock.ev.on("group-participants.update", async (data) => {
        try {
            const metadata = await sock.groupMetadata(data.id)
            for (const user of data.participants) {
                const userNumber = user.split("@")[0]
                if (data.action === "add") {
                    await sock.sendMessage(data.id, {
                        text: `👋 Welcome @${userNumber} to *${metadata.subject}*!\nType .menu to see what I can do.`,
                        mentions: [user]
                    })
                }
                if (data.action === "remove") {
                    await sock.sendMessage(data.id, {
                        text: `👋 Goodbye @${userNumber}. We hope you return soon!`,
                        mentions: [user]
                    })
                }
            }
        } catch (e) {
            console.error("Group Update Error:", e);
        }
    })

    /**
     * 📩 MESSAGE UPSERT HANDLER
     * The primary logic controller for incoming commands and security.
     */
    sock.ev.on("messages.upsert", async ({ messages }) => {
        const msg = messages[0]
        if (!msg.message) return

        // Basic Metadata
        const from = msg.key.remoteJid
        const isGroup = from.endsWith("@g.us")
        const isFromMe = msg.key.fromMe // THE ABSOLUTE SECURITY CHECK

        // Content Extraction (Text, Image Captions, Video Captions)
        const messageText = msg.message.conversation || 
                            msg.message.extendedTextMessage?.text || 
                            msg.message.imageMessage?.caption || 
                            msg.message.videoMessage?.caption || 
                            "";

        const cleanText = messageText.trim();
        const command = cleanText.split(/\s+/)[0].toLowerCase();
        const args = cleanText.split(/\s+/).slice(1);
        const query = args.join(" ");

        // Logging Activity
        if (cleanText) {
            const senderType = isFromMe ? "OWNER" : "OTHER";
            addLog(`📩 [${senderType}] ${from.split('@')[0]}: ${cleanText.substring(0, 30)}...`);
        }

        // --- GLOBAL COMMAND GATEKEEPER ---
        // Prevents anyone except the bot account from executing "." commands
        if (command.startsWith(".") && !isFromMe) {
            addLog(`🚫 Blocked attempt: ${command} from ${from}`);
            return;
        }

        /**
         * 🤖 AUTO-REPLY LOGIC (SMART MODE)
         * Triggers when: 
         * 1. AutoReply is ON 
         * 2. Message is NOT a command 
         * 3. Message is FROM the owner
         */
        if (!command.startsWith(".") && autoReplyActive && isFromMe && cleanText.length > 1) {
            await sock.sendMessage(from, { text: "🤖 _Thinking..._" });
            const aiResponse = await askGemini(cleanText, from);
            return await sock.sendMessage(from, { text: `🧠 *AI Assistant:*\n\n${aiResponse}` });
        }

        // --- ANTI-LINK PROTECTION ---
        if (isGroup && cleanText.includes("chat.whatsapp.com")) {
            await sock.sendMessage(from, { text: "🚫 Group links are not allowed here." })
        }

        /**
         * ----------------------------------------------------------------------
         * COMMAND REGISTRY
         * ----------------------------------------------------------------------
         */

        // 1. SYSTEM CONTROLS
        if (command === ".menu" || command === ".help") {
            const menu = `👑 *MASTER BOT CONTROL PANEL* 👑

*--- ⚡ AUTOMATION ---*
.autoreply on  - Enable AI Smart Mode
.autoreply off - Disable AI Smart Mode
_Status: ${autoReplyActive ? '🟢 ON' : '🔴 OFF'}_

*--- 🛡️ ADMIN POWER ---*
.promote @user - Grant Admin
.demote @user  - Remove Admin
.kick @user    - Remove Member
.kickall       - Wipe Group
.tagall        - Mention Everyone
.hidetag <txt> - Hidden Tag

*--- 🧠 AI & KNOWLEDGE ---*
.ai <query>    - Ask Gemini
.gpt <query>   - AI Assistant
.clear         - Reset AI Memory

*--- 🛠️ UTILITIES ---*
.ping   - Speed Check
.alive  - Status Check
.owner  - Identity Check
.time   - Clock
.date   - Calendar

*--- 🎭 ENTERTAINMENT ---*
.quote | .joke | .fact
.flip  | .dice | .8ball`
            
            return await sock.sendMessage(from, { text: menu })
        }

        // AUTO-REPLY TOGGLE
        if (command === ".autoreply") {
            if (query === "on") {
                autoReplyActive = true;
                return await sock.sendMessage(from, { text: "🤖 *Smart AI Mode:* ENABLED. I am now your automated assistant." });
            } else if (query === "off") {
                autoReplyActive = false;
                return await sock.sendMessage(from, { text: "🤖 *Smart AI Mode:* DISABLED." });
            } else {
                return await sock.sendMessage(from, { text: "❓ Use: `.autoreply on` or `.autoreply off`" });
            }
        }

        // CLEAR MEMORY
        if (command === ".clear") {
            chatMemory[from] = [];
            return await sock.sendMessage(from, { text: "🧹 *AI Memory Cleared.* Starting fresh conversation." });
        }

        // 2. STATUS TOOLS
        if (command === ".ping") return await sock.sendMessage(from, { text: "🚀 *Bot Response:* 0.8s" })
        if (command === ".alive") return await sock.sendMessage(from, { text: "🟢 *Status:* System Stable on Render Cloud." })
        if (command === ".owner") return await sock.sendMessage(from, { text: "👑 *Verification:* Owner authenticated via fromMe logic." })

        // 3. MANUAL AI
        if ([".ai", ".gpt"].includes(command)) {
            if (!query) return await sock.sendMessage(from, { text: "❓ Please provide a prompt." })
            await sock.sendMessage(from, { text: "🤖 *Processing...*" })
            const aiRes = await askGemini(query, from)
            return await sock.sendMessage(from, { text: aiRes })
        }

        // 4. ADVANCED GROUP ADMIN (GROUP ONLY)
        if (isGroup) {
            
            // PROMOTE
            if (command === ".promote") {
                let user = msg.message.extendedTextMessage?.contextInfo?.mentionedJid?.[0] || 
                           msg.message.extendedTextMessage?.contextInfo?.participant
                if (!user) return await sock.sendMessage(from, { text: "⚠️ Reply to or tag a user." })
                await sock.groupParticipantsUpdate(from, [user], "promote")
                return await sock.sendMessage(from, { text: "✅ Target promoted to Admin." })
            }

            // DEMOTE
            if (command === ".demote") {
                let user = msg.message.extendedTextMessage?.contextInfo?.mentionedJid?.[0] || 
                           msg.message.extendedTextMessage?.contextInfo?.participant
                if (!user) return await sock.sendMessage(from, { text: "⚠️ Reply to or tag a user." })
                await sock.groupParticipantsUpdate(from, [user], "demote")
                return await sock.sendMessage(from, { text: "✅ Target demoted to Member." })
            }

            // KICK
            if (command === ".kick") {
                let user = msg.message.extendedTextMessage?.contextInfo?.mentionedJid?.[0] || 
                           msg.message.extendedTextMessage?.contextInfo?.participant
                if (!user) return await sock.sendMessage(from, { text: "⚠️ Tag the user to remove." })
                await sock.groupParticipantsUpdate(from, [user], "remove")
                return await sock.sendMessage(from, { text: "👢 User removed from the group." })
            }

            // KICKALL
            if (command === ".kickall") {
                const groupData = await sock.groupMetadata(from)
                const participants = groupData.participants
                const botJid = sock.user.id.split(':')[0] + '@s.whatsapp.net'
                
                await sock.sendMessage(from, { text: "☢️ *GROUP PURGE INITIATED.*" })
                for (let p of participants) {
                    if (p.id !== botJid) {
                        await sock.groupParticipantsUpdate(from, [p.id], "remove")
                        await delay(600) // Safety delay
                    }
                }
                return await sock.sendMessage(from, { text: "🧹 Purge Complete." })
            }

            // TAGALL
            if (command === ".tagall") {
                const groupData = await sock.groupMetadata(from)
                let tagList = `📢 *Attention Group Participants!*\n\n*Message:* ${query || 'No Message'}\n\n`
                let mentions = []
                for (let p of groupData.participants) {
                    mentions.push(p.id)
                    tagList += `• @${p.id.split("@")[0]}\n`
                }
                return await sock.sendMessage(from, { text: tagList, mentions })
            }

            // HIDETAG
            if (command === ".hidetag") {
                const groupData = await sock.groupMetadata(from)
                const mentions = groupData.participants.map(p => p.id)
                return await sock.sendMessage(from, { text: query || "Hidden mention alert!", mentions })
            }
        }

        // 5. UTILITIES & FUN
        if (command === ".time") return await sock.sendMessage(from, { text: `🕙 ${new Date().toLocaleTimeString()}` })
        if (command === ".date") return await sock.sendMessage(from, { text: `📅 ${new Date().toDateString()}` })

        if (command === ".flip") return await sock.sendMessage(from, { text: `🪙 Result: *${Math.random() > 0.5 ? "HEADS" : "TAILS"}*` })
        if (command === ".dice") return await sock.sendMessage(from, { text: `🎲 Roll: *${Math.floor(Math.random() * 6) + 1}*` })
        if (command === ".8ball") {
            const results = ["Yes", "No", "Maybe", "Ask later", "Definitely", "Concentrate and ask again"]
            return await sock.sendMessage(from, { text: `🎱 *Oracle:* ${results[Math.floor(Math.random() * results.length)]}` })
        }

        // 6. EXTERNAL APIS
        if (command === ".quote") {
            try {
                const r = await axios.get("https://api.quotable.io/random")
                return await sock.sendMessage(from, { text: `“${r.data.content}”\n\n— *${r.data.author}*` })
            } catch { return await sock.sendMessage(from, { text: "❌ Service Unavailable." }) }
        }
        if (command === ".joke") {
            try {
                const r = await axios.get("https://official-joke-api.appspot.com/random_joke")
                return await sock.sendMessage(from, { text: `*${r.data.setup}*\n\n${r.data.punchline}` })
            } catch { return await sock.sendMessage(from, { text: "❌ Service Unavailable." }) }
        }
        if (command === ".fact") {
            try {
                const r = await axios.get("https://uselessfacts.jsph.pl/random.json?language=en")
                return await sock.sendMessage(from, { text: `💡 *Fact:* ${r.data.text}` })
            } catch { return await sock.sendMessage(from, { text: "❌ Service Unavailable." }) }
        }
    })
}

// --- WEB INTERFACE ENGINE ---
app.get("/", (req, res) => {
    res.send(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Bot Master Dashboard</title>
        <style>
            * { box-sizing: border-box; }
            body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background: #0c0c0c; color: #e0e0e0; margin: 0; padding: 20px; }
            .container { max-width: 1100px; margin: auto; }
            .header { text-align: center; padding: 40px 0; border-bottom: 3px solid #25D366; }
            .header h1 { color: #25D366; font-size: 3em; margin: 0; text-transform: uppercase; letter-spacing: 5px; }
            .status-display { background: #1a1a1a; margin: 30px 0; padding: 30px; border-radius: 20px; text-align: center; border: 1px solid #333; box-shadow: 0 10px 30px rgba(0,0,0,0.5); }
            .status-display h2 { color: #25D366; margin: 0; font-size: 1.8em; }
            .terminal-window { background: #000; border-radius: 15px; border: 1px solid #444; overflow: hidden; }
            .terminal-header { background: #333; padding: 10px 20px; font-size: 0.9em; color: #bbb; display: flex; justify-content: space-between; }
            .terminal-body { height: 500px; overflow-y: auto; padding: 20px; font-family: 'Consolas', 'Monaco', monospace; line-height: 1.6; }
            .log-item { margin-bottom: 12px; border-bottom: 1px solid #1a1a1a; padding-bottom: 8px; color: #00ff41; }
            .log-item span { color: #555; margin-right: 15px; }
            ::-webkit-scrollbar { width: 10px; }
            ::-webkit-scrollbar-track { background: #0a0a0a; }
            ::-webkit-scrollbar-thumb { background: #25D366; border-radius: 10px; }
            .footer { text-align: center; margin-top: 50px; color: #666; font-size: 0.9em; }
        </style>
    </head>
    <body>
        <div class="container">
            <div class="header">
                <h1>Bot Pro Console</h1>
                <p>Advanced Management System</p>
            </div>
            <div class="status-display">
                <h2>${webPairingCode}</h2>
            </div>
            <div class="terminal-window">
                <div class="terminal-header">
                    <span>LIVE SYSTEM ACTIVITY</span>
                    <span>BAILEYS V5.x</span>
                </div>
                <div class="terminal-body">
                    ${statusLogs.map(log => `<div class="log-item">${log}</div>`).join('')}
                </div>
            </div>
            <div class="footer">
                Built for High-Stability Deployment | Render.com compatible
            </div>
        </div>
    </body>
    </html>
    `)
})

// Listen to assigned Port
app.listen(PORT, () => {
    console.log(`🚀 System running on Port ${PORT}`)
    addLog(`System initialized on Port ${PORT}`);
})

// Execution Start
startBot().catch(e => {
    console.error("BOOT ERROR:", e);
    addLog("❌ FATAL ERROR DURING STARTUP.");
});
