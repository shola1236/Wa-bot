const { 
    default: makeWASocket, 
    useMultiFileAuthState, 
    DisconnectReason, 
    Browsers, 
    delay, 
    getContentType 
} = require("@whiskeysockets/baileys");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const pino = require("pino");
const express = require("express");
const readline = require("readline");

// --- CONFIGURATION ---
const app = express();
const PORT = process.env.PORT || 3000;
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const question = (text) => new Promise((resolve) => rl.question(text, resolve));

// --- GEMINI SETUP ---
const genAI = new GoogleGenerativeAI(process.env.GEMINI_KEY || "YOUR_KEY_HERE");
const aiModel = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

async function startVantageBot() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info');
    
    const sock = makeWASocket({
        auth: state,
        printQRInTerminal: false, // Using Pairing Code instead
        logger: pino({ level: 'silent' }),
        browser: Browsers.macOS("Chrome") // Required for pairing codes
    });

    // 🔑 PAIRING CODE LOGIC
    if (!sock.authState.creds.registered) {
        console.log("⚠️ Not registered. Starting Pairing Process...");
        const phoneNumber = await question("Enter your WhatsApp number (e.g. 2349028694300): ");
        const code = await sock.requestPairingCode(phoneNumber.replace(/[^\d]/g, ''));
        console.log(`\n🔥 YOUR PAIRING CODE: ${code}\n`);
    }

    // --- EVENTS ---
    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect } = update;
        if (connection === 'open') {
            console.log("✅ VANTAGE BOT CONNECTED!");
        } else if (connection === 'close') {
            const shouldReconnect = lastDisconnect.error?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log("❌ Connection closed. Reconnecting:", shouldReconnect);
            if (shouldReconnect) startVantageBot();
        }
    });

    sock.ev.on('messages.upsert', async ({ messages }) => {
        const msg = messages[0];
        if (!msg.message || msg.key.fromMe) return;

        const jid = msg.key.remoteJid;
        const type = getContentType(msg.message);
        const body = msg.message.conversation || msg.message.extendedTextMessage?.text || "";

        // 🔓 FEATURE 1: AUTO VIEW-ONCE BYPASS
        if (type === 'viewOnceMessageV2' || type === 'viewOnceMessage') {
            console.log("🔓 View-Once Detected. Forwarding...");
            await sock.sendMessage(sock.user.id, { forward: msg, caption: "🔓 Bypassed View-Once" });
        }

        // 🤖 FEATURE 2: GEMINI AI
        if (body.startsWith("!ai ")) {
            const prompt = body.slice(4);
            try {
                const result = await aiModel.generateContent(prompt);
                await sock.sendMessage(jid, { text: result.response.text() });
            } catch (err) {
                await sock.sendMessage(jid, { text: "❌ AI Error: Check your API Key." });
            }
        }

        // 🎨 FEATURE 3: STICKER (Template)
        if (body === "!s" || body === "!sticker") {
            await sock.sendMessage(jid, { text: "Send an image with the caption !s to make a sticker!" });
        }
    });
}

// Keep-Alive for Render
app.get("/", (req, res) => res.send("Vantage Bot is Online! 🤖"));
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    startVantageBot();
});
