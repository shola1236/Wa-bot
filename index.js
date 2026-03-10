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
const readline = require("readline");
const fs = require("fs");

// --- CONFIG ---
const app = express();
const PORT = process.env.PORT || 3000;
const prefix = "."; 
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const question = (text) => new Promise((resolve) => rl.question(text, resolve));

// --- AI SETUP ---
const genAI = new GoogleGenerativeAI(process.env.GEMINI_KEY || "YOUR_KEY_HERE");
const aiModel = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

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
        const phoneNumber = await question("Enter your WhatsApp number (e.g. 234810xxxx): ");
        const code = await sock.requestPairingCode(phoneNumber.replace(/[^\d]/g, ''));
        console.log(`\n🔥 YOUR PAIRING CODE: ${code}\n`);
    }

    sock.ev.on('creds.update', saveCreds);
    sock.ev.on('connection.update', (up) => { 
        if (up.connection === 'open') console.log("✅ Vantage Master Bot Online!"); 
    });

    sock.ev.on('messages.upsert', async ({ messages }) => {
        const msg = messages[0];
        if (!msg.message || msg.key.fromMe) return;

        const jid = msg.key.remoteJid;
        const isGroup = jid.endsWith('@g.us');
        
        // Extract message type and content accurately
        const type = getContentType(msg.message);
        let body = "";
        if (type === 'conversation') body = msg.message.conversation;
        else if (type === 'extendedTextMessage') body = msg.message.extendedTextMessage.text;
        else if (type === 'imageMessage') body = msg.message.imageMessage.caption || "";
        else if (type === 'videoMessage') body = msg.message.videoMessage.caption || "";

        // 🔓 AUTO VIEW-ONCE BYPASS
        if (type === 'viewOnceMessageV2' || type === 'viewOnceMessage') {
            await sock.sendMessage(sock.user.id, { forward: msg, caption: "🔓 Bypassed View-Once" });
        }

        const isCmd = body.startsWith(prefix);
        if (!isCmd) return;

        const command = body.slice(prefix.length).trim().split(" ")[0].toLowerCase();
        const args = body.trim().split(" ").slice(1);

        // --- COMMAND LOGIC ---
        switch (command) {
            
            // 🤖 1. AI CHAT
            case 'ai':
                if (!args.length) return sock.sendMessage(jid, { text: "❌ What should I ask the AI? Example: .ai write a poem" });
                try {
                    const result = await aiModel.generateContent(args.join(" "));
                    await sock.sendMessage(jid, { text: result.response.text() });
                } catch (e) {
                    await sock.sendMessage(jid, { text: "❌ AI Error: Check your API Key or rate limits." });
                }
                break;

            // 📥 2. YOUTUBE VIDEO DOWNLOADER
            case 'video':
            case 'yt':
                const url = args[0];
                if (!url || !ytdl.validateURL(url)) {
                    return sock.sendMessage(jid, { text: "❌ Send a valid YouTube URL. Example: .video https://youtube.com/..." });
                }
                await sock.sendMessage(jid, { text: "📥 Downloading video... Please wait." });
                try {
                    const stream = ytdl(url, { filter: 'audioandvideo', quality: 'highest' });
                    await sock.sendMessage(jid, { video: { stream: stream }, caption: "🎥 Downloaded via Vantage Bot" });
                } catch (e) {
                    await sock.sendMessage(jid, { text: "❌ Failed to download video. It might be age-restricted or too large." });
                }
                break;

            // 🎨 3. STICKER MAKER
            case 's':
            case 'sticker':
                // Check if user replied to an image OR sent an image with the caption .s
                const isImage = type === 'imageMessage';
                const isQuotedImage = type === 'extendedTextMessage' && msg.message.extendedTextMessage.contextInfo?.quotedMessage?.imageMessage;
                
                if (!isImage && !isQuotedImage) {
                    return sock.sendMessage(jid, { text: "❌ Please send or reply to an image with .s" });
                }

                await sock.sendMessage(jid, { text: "🎨 Making sticker..." });
                
                // Get the image payload
                const imageMessage = isImage ? msg.message.imageMessage : msg.message.extendedTextMessage.contextInfo.quotedMessage.imageMessage;
                
                try {
                    const stream = await downloadContentFromMessage(imageMessage, 'image');
                    let buffer = Buffer.from([]);
                    for await (const chunk of stream) { buffer = Buffer.concat([buffer, chunk]); }
                    
                    fs.writeFileSync('temp.jpg', buffer);
                    
                    // Convert to WebP using FFmpeg
                    ffmpeg('temp.jpg')
                        .outputOptions(["-vcodec", "libwebp", "-vf", "scale='min(320,iw)':min'(320,ih)':force_original_aspect_ratio=decrease,fps=15, pad=320:320:-1:-1:color=white@0.0", "-lossless", "1"])
                        .save('sticker.webp')
                        .on('end', async () => {
                            await sock.sendMessage(jid, { sticker: fs.readFileSync('sticker.webp') });
                            fs.unlinkSync('temp.jpg');
                            fs.unlinkSync('sticker.webp');
                        });
                } catch (e) {
                    await sock.sendMessage(jid, { text: "❌ Failed to create sticker." });
                }
                break;

            // 👥 4. ADMIN & GROUP TOOLS
            case 'promote': // .promote @user
                if (!isGroup) return;
                const promoteUser = msg.message.extendedTextMessage?.contextInfo?.mentionedJid[0] || args[0] + "@s.whatsapp.net";
                await sock.groupParticipantsUpdate(jid, [promoteUser], "promote");
                await sock.sendMessage(jid, { text: "✅ User promoted to Admin." });
                break;

            case 'demote': // .demote @user
                if (!isGroup) return;
                const demoteUser = msg.message.extendedTextMessage?.contextInfo?.mentionedJid[0] || args[0] + "@s.whatsapp.net";
                await sock.groupParticipantsUpdate(jid, [demoteUser], "demote");
                await sock.sendMessage(jid, { text: "❌ User demoted to Member." });
                break;

            case 'lock': // .lock
                if (!isGroup) return;
                await sock.groupSettingUpdate(jid, 'announcement');
                await sock.sendMessage(jid, { text: "🔒 Group Locked: Only Admins can send messages." });
                break;

            case 'unlock': // .unlock
                if (!isGroup) return;
                await sock.groupSettingUpdate(jid, 'not_announcement');
                await sock.sendMessage(jid, { text: "🔓 Group Unlocked: Everyone can send messages." });
                break;

            case 'hidetag': // .hidetag Your Message Here
                if (!isGroup) return;
                const meta = await sock.groupMetadata(jid);
                const users = meta.participants.map(u => u.id);
                await sock.sendMessage(jid, { text: args.join(" ") || "Attention everyone!", mentions: users });
                break;

            case 'ping':
                await sock.sendMessage(jid, { text: "Vantage Master Bot is Active 🟢\nPrefix: `.`" });
                break;
        }
    });
}

// Keep-Alive for Render
app.get("/", (req, res) => res.send("Master Bot Status: Active"));
app.listen(PORT, () => startVantageBot());
