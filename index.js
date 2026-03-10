const express = require("express")
const pino = require("pino")
const axios = require("axios")
const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion,
    jidDecode
} = require("@whiskeysockets/baileys")

const app = express()
const PORT = process.env.PORT || 10000

const BOT_NUMBER = process.env.BOT_NUMBER
const GEMINI_KEY = process.env.GEMINI_KEY
const OWNER_NUMBER = process.env.OWNER_NUMBER

if (!BOT_NUMBER || !OWNER_NUMBER) {
    console.log("❌ BOT_NUMBER or OWNER_NUMBER missing")
    process.exit(1)
}

const OWNER = OWNER_NUMBER.replace(/[^0-9]/g, "") + "@s.whatsapp.net"

// --- HELPERS ---
const decodeJid = (jid) => {
    if (!jid) return jid
    if (/:\d+@/gi.test(jid)) {
        const decode = jidDecode(jid) || {}
        return decode.user && decode.server && `${decode.user}@${decode.server}` || jid
    }
    return jid
}

async function askGemini(prompt) {
    try {
        const res = await axios.post(
            `https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent?key=${GEMINI_KEY}`,
            { contents: [{ parts: [{ text: prompt }] }] }
        )
        return res.data.candidates[0].content.parts[0].text
    } catch {
        return "⚠️ AI error"
    }
}

// --- MAIN BOT ---
async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState("session")
    const { version } = await fetchLatestBaileysVersion()

    const sock = makeWASocket({
        version,
        logger: pino({ level: "silent" }),
        auth: state,
        printQRInTerminal: false,
        browser: ["Ubuntu", "Chrome", "20.0.04"]
    })

    sock.ev.on("creds.update", saveCreds)

    sock.ev.on("connection.update", (update) => {
        const { connection, lastDisconnect } = update
        if (connection === "close") {
            const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut
            if (shouldReconnect) startBot()
        }
        if (connection === "open") console.log("✅ WhatsApp connected")
    })

    // --- PAIRING (The Fix for Render) ---
    if (!sock.authState.creds.registered) {
        console.log("⚠️ Pairing Request...")
        const cleaned = BOT_NUMBER.replace(/[^0-9]/g, "")
        setTimeout(async () => {
            try {
                const code = await sock.requestPairingCode(cleaned)
                console.log("\n----------------------------")
                console.log("🔥 PAIR CODE:", code)
                console.log("----------------------------\n")
            } catch (err) { console.log("Pairing Error:", err.message) }
        }, 10000)
    }

    // --- GROUP EVENTS ---
    sock.ev.on("group-participants.update", async (data) => {
        const metadata = await sock.groupMetadata(data.id)
        for (const user of data.participants) {
            if (data.action === "add") {
                await sock.sendMessage(data.id, {
                    text: `👋 Welcome @${user.split("@")[0]} to *${metadata.subject}*`,
                    mentions: [user]
                })
            }
            if (data.action === "remove") {
                await sock.sendMessage(data.id, {
                    text: `👋 Goodbye @${user.split("@")[0]}`,
                    mentions: [user]
                })
            }
        }
    })

    // --- MESSAGES ---
    sock.ev.on("messages.upsert", async ({ messages }) => {
        const msg = messages[0]
        if (!msg.message || msg.key.fromMe) return

        const from = msg.key.remoteJid
        const sender = msg.key.participant || from
        const isGroup = from.endsWith("@g.us")
        const text = msg.message.conversation || msg.message.extendedTextMessage?.text || ""
        const command = text.split(" ")[0].toLowerCase()
        const query = text.replace(command, "").trim()

        // OWNER CHECK
        if (sender !== OWNER && command.startsWith(".")) return

        // ANTI-LINK
        if (isGroup && text.includes("chat.whatsapp.com")) {
            return await sock.sendMessage(from, { text: "🚫 Links not allowed" })
        }

        // --- ALL COMMANDS RESTORED ---
        switch (command) {
            case ".menu":
                const menu = `🤖 *BOT MENU*\n\n.ai question\n.ask question\n.gpt question\n\n.ping\n.alive\n.owner\n\n.time\n.date\n.quote\n.joke\n.fact\n\n.tagall\n.hidetag\n\n.flip\n.dice\n.8ball`
                await sock.sendMessage(from, { text: menu })
                break

            case ".ping": await sock.sendMessage(from, { text: "🏓 Pong" }); break
            case ".alive": await sock.sendMessage(from, { text: "✅ Bot is running" }); break
            case ".owner": await sock.sendMessage(from, { text: "👑 Owner verified" }); break
            
            case ".ai": case ".ask": case ".gpt":
                if (!query) return sock.sendMessage(from, { text: "Ask something." })
                await sock.sendMessage(from, { text: "🤖 Thinking..." })
                const aiResponse = await askGemini(query)
                await sock.sendMessage(from, { text: aiResponse })
                break

            case ".time": await sock.sendMessage(from, { text: new Date().toLocaleTimeString() }); break
            case ".date": await sock.sendMessage(from, { text: new Date().toDateString() }); break
            
            case ".quote":
                const q = await axios.get("https://api.quotable.io/random")
                await sock.sendMessage(from, { text: `"${q.data.content}"\n-${q.data.author}` })
                break

            case ".joke":
                const j = await axios.get("https://official-joke-api.appspot.com/random_joke")
                await sock.sendMessage(from, { text: `${j.data.setup}\n${j.data.punchline}` })
                break

            case ".fact":
                const f = await axios.get("https://uselessfacts.jsph.pl/random.json?language=en")
                await sock.sendMessage(from, { text: f.data.text })
                break

            case ".flip": await sock.sendMessage(from, { text: Math.random() > 0.5 ? "Heads" : "Tails" }); break
            case ".dice": await sock.sendMessage(from, { text: "🎲 " + (Math.floor(Math.random() * 6) + 1) }); break
            case ".8ball":
                const ball = ["Yes", "No", "Maybe", "Ask later", "Definitely", "Not likely"]
                await sock.sendMessage(from, { text: ball[Math.floor(Math.random() * ball.length)] })
                break

            case ".tagall":
                if (!isGroup) break
                const metadata = await sock.groupMetadata(from)
                let tagT = "📢 *Tagging all*\n\n"
                let tagM = []
                for (let p of metadata.participants) {
                    tagM.push(p.id)
                    tagT += `@${p.id.split("@")[0]}\n`
                }
                await sock.sendMessage(from, { text: tagT, mentions: tagM })
                break

            case ".hidetag":
                if (!isGroup) break
                const hMeta = await sock.groupMetadata(from)
                const hMentions = hMeta.participants.map(p => p.id)
                await sock.sendMessage(from, { text: query || "Attention!", mentions: hMentions })
                break
        }
    })
}

app.get("/", (req, res) => res.send("Bot running"))
app.listen(PORT, () => console.log("Server running on port " + PORT))

startBot()
