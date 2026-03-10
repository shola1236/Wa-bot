require('dotenv').config();
const { 
    default: makeWASocket, 
    useMultiFileAuthState, 
    DisconnectReason, 
    Browsers, 
    getContentType,
    downloadContentFromMessage
} = require("@whiskeysockets/baileys");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const ytdl = require("ytdl-core");
const ffmpeg = require("fluent-ffmpeg");
const pino = require("pino");
const express = require("express");
const fs = require("fs");
const axios = require("axios");
const readline = require("readline");

// --- CONFIGURATION ---
const app = express();
const PORT = process.env.PORT || 3000;
const prefix = "."; 
const botNumber = process.env.BOT_NUMBER; 
const renderUrl = process.env.RENDER_URL; // e.g., https://your-app.onrender.com

// --- AI SETUP ---
const apiKey = process.env.GEMINI_KEY;
if (!apiKey) console.warn("⚠️ WARNING: GEMINI_KEY missing. AI features will be disabled.");
const genAI = apiKey ? new GoogleGenerativeAI(apiKey) : null;
const aiModel = genAI ? genAI.getGenerativeModel({ model: "gemini-1.5-flash" }) : null;

// For local testing fallback
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const question = (text) => new Promise((resolve) => rl.question(text, resolve));

async function startVantageBot() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info');
    
    const sock = makeWASocket({
        auth: state,
        printQRInTerminal: false,
        logger: pino({ level: 'silent' }),
        browser: Browsers.macOS("Chrome")
    });

    // 🔑 PAIRING CODE LOGIC
    if (!sock.authState.creds.registered) {
        console.log("⚠️ Not registered. Starting Pairing Process...");
        const phoneNumber = botNumber || await question("Enter your WhatsApp number (e.g. 234810xxxx): ");
        const cleanedNumber = phoneNumber.replace(/[^\d]/g, '');
        
        setTimeout(async () => {
            const code = await sock.requestPairingCode(cleanedNumber);
            console.log(`\n🔥 YOUR PAIRING CODE: ${code}\n`);
        }, 3000);
    }

    sock.ev.on('creds.update', saveCreds);
    sock.ev.on('connection.update', (up) => { 
        const { connection, lastDisconnect } = up;
        if (connection === 'open') console.log("✅ Vantage Bot Online!"); 
        else if (connection === 'close') {
            const shouldReconnect = lastDisconnect.error?.output?.statusCode !== DisconnectReason.loggedOut;
            if (shouldReconnect) startVantageBot();
        }
    });

    sock.ev.on('messages.upsert', async ({ messages }) => {
        const msg = messages[0];
        if (!msg.message || msg.key.fromMe) return;

        const jid = msg.key.remoteJid;
        const isGroup = jid.endsWith('@g.us');
        
        // Extract message type safely
        const type = getContentType(msg.message);
        let body = "";
        if (type === 'conversation') body = msg.message.conversation;
        else if (type === 'extendedTextMessage') body = msg.message.extendedTextMessage.text;
        else if (type === 'imageMessage') body = msg.message.imageMessage.caption || "";
        else if (type === 'videoMessage') body = msg.message.videoMessage.caption || "";

        // 🔓 1. AUTO VIEW-ONCE BYPASS
        if (type === 'viewOnceMessageV2' || type === 'viewOnceMessage') {
            await sock.sendMessage(sock.user.id, { forward: msg, caption: "🔓 Bypassed View-Once" });
        }

        const isCmd = body.startsWith(prefix);
        if (!isCmd) return;

        const command = body.slice(prefix.length).trim().split(" ")[0].toLowerCase();
        const args = body.trim().split(" ").slice(1);

        // --- COMMANDS ---
        switch (command) {
            
            // 🤖 AI CHAT
            case 'ai':
                if (!aiModel) return sock.sendMessage(jid, { text: "❌ AI is disabled (Missing API Key)." });
                if (!args.length) return sock.sendMessage(jid, { text: "❌ Ask something! Example: .ai what is Next.js?" });
                try {
                    const result = await aiModel.generateContent(args.join(" "));
                    await sock.sendMessage(jid, { text: result.response.text() });
                } catch (e) {
                    await sock.sendMessage(jid, { text: "❌ AI Error: Please try again later." });
                }
                break;

            // 📥 YOUTUBE DOWNLOADER
            case 'video':
            case 'yt':
                const url = args[0];
                if (!url || !ytdl.validateURL(url)) return sock.sendMessage(jid, { text: "❌ Send a valid YouTube URL." });
                await sock.sendMessage(jid, { text: "📥 Downloading video... Please wait." });
                try {
                    const stream = ytdl(url, { filter: 'audioandvideo', quality: 'highest' });
                    await sock.sendMessage(jid, { video: { stream: stream }, caption: "🎥 Downloaded via Vantage Bot" });
                } catch (e) {
                    await sock.sendMessage(jid, { text: "❌ Failed to download. Video might be too large." });
                }
                break;

            // 🎨 STICKER MAKER
            case 's':
            case 'sticker':
                const isImage = type === 'imageMessage';
                const isQuotedImage = type === 'extendedTextMessage' && msg.message.extendedTextMessage.contextInfo?.quotedMessage?.imageMessage;
                
                if (!isImage && !isQuotedImage) return sock.sendMessage(jid, { text: "❌ Reply to an image with .s" });

                await sock.sendMessage(jid, { text: "🎨 Processing..." });
                const imageMessage = isImage ? msg.message.imageMessage : msg.message.extendedTextMessage.contextInfo.quotedMessage.imageMessage;
                
                try {
                    const stream = await downloadContentFromMessage(imageMessage, 'image');
                    let buffer = Buffer.from([]);
                    for await (const chunk of stream) { buffer = Buffer.concat([buffer, chunk]); }
                    
                    fs.writeFileSync('temp.jpg', buffer);
                    ffmpeg('temp.jpg')
                        .outputOptions(["-vcodec", "libwebp", "-vf", "scale='min(320,iw)':min'(320,ih)':force_original_aspect_ratio=decrease,fps=15, pad=320:320:-1:-1:color=white@0.0", "-lossless", "1"])
                        .save('sticker.webp')
                        .on('end', async () => {
                            await sock.sendMessage(jid, { sticker: fs.readFileSync('sticker.webp') });
                            if (fs.existsSync('temp.jpg')) fs.unlinkSync('temp.jpg');
                            if (fs.existsSync('sticker.webp')) fs.unlinkSync('sticker.webp');
                        });
                } catch (e) {
                    await sock.sendMessage(jid, { text: "❌ Failed to create sticker." });
                }
                break;

            // 👥 GROUP TOOLS
            case 'promote':
                if (!isGroup) return;
                const promoteUser = msg.message.extendedTextMessage?.contextInfo?.mentionedJid[0] || args[0] + "@s.whatsapp.net";
                await sock.groupParticipantsUpdate(jid, [promoteUser], "promote");
                await sock.sendMessage(jid, { text: "✅ Promoted." });
                break;

            case 'demote':
                if (!isGroup) return;
                const demoteUser = msg.message.extendedTextMessage?.contextInfo?.mentionedJid[0] || args[0] + "@s.whatsapp.net";
                await sock.groupParticipantsUpdate(jid, [demoteUser], "demote");
                await sock.sendMessage(jid, { text: "❌ Demoted." });
                break;

            case 'lock':
                if (!isGroup) return;
                await sock.groupSettingUpdate(jid, 'announcement');
                await sock.sendMessage(jid, { text: "🔒 Locked." });
                break;

            case 'unlock':
                if (!isGroup) return;
                await sock.groupSettingUpdate(jid, 'not_announcement');
                await sock.sendMessage(jid, { text: "🔓 Unlocked." });
                break;

            case 'hidetag':
                if (!isGroup) return;
                const meta = await sock.groupMetadata(jid);
                const users = meta.participants.map(u => u.id);
                await sock.sendMessage(jid, { text: args.join(" ") || "Attention!", mentions: users });
                break;

            case 'ping':
                await sock.sendMessage(jid, { text: "🟢 Vantage Bot is Active (Shola's update)\nPrefix: `.`" });
                break;
        }
    });
}

// --- EXPRESS SERVER & KEEP-ALIVE ---
app.get("/", (req, res) => res.send("Vantage Bot Server Running 🚀"));
app.listen(PORT, () => {
    console.log(`Web server listening on port ${PORT}`);
    startVantageBot();
    
    // Self-ping to keep Render free tier awake
    if (renderUrl) {
        setInterval(() => {
            axios.get(renderUrl)
                .then(() => console.log("⚡ Self-ping successful!"))
                .catch(() => console.error("⚠️ Self-ping failed."));
        }, 14 * 60 * 1000); // 14 minutes
    }
});
