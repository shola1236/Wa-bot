const express = require("express")
const pino = require("pino")
const axios = require("axios")

const {
default: makeWASocket,
useMultiFileAuthState,
DisconnectReason,
fetchLatestBaileysVersion
} = require("@whiskeysockets/baileys")

const app = express()
const PORT = process.env.PORT || 3000

const BOT_NUMBER = process.env.BOT_NUMBER
const GEMINI_KEY = process.env.GEMINI_KEY
const OWNER_NUMBER = process.env.OWNER_NUMBER

// --- LOGGING STORAGE ---
let statusLogs = [];
function addLog(msg) {
    const time = new Date().toLocaleTimeString();
    statusLogs.unshift(`[${time}] ${msg}`); 
    if (statusLogs.length > 20) statusLogs.pop(); 
}

if (!BOT_NUMBER || !OWNER_NUMBER) {
console.log("❌ BOT_NUMBER or OWNER_NUMBER missing")
process.exit(1)
}

const OWNER = OWNER_NUMBER.replace(/[^0-9]/g,"")+"@s.whatsapp.net"

// Variable to store the code so we can show it on the webpage
let webPairingCode = "Waiting for code to generate... Refresh the page in a few seconds.";

async function askGemini(prompt){

try{

const res = await axios.post(
`https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent?key=${GEMINI_KEY}`,
{
contents:[{parts:[{text:prompt}]}]
})

return res.data.candidates[0].content.parts[0].text

}catch{
addLog("⚠️ Gemini AI Error (Check your API Key)");
return "⚠️ AI error"

}

}

async function startBot(){

const {state,saveCreds}=await useMultiFileAuthState("session")
const {version}=await fetchLatestBaileysVersion()

const sock=makeWASocket({
version,
logger:pino({level:"silent"}),
auth:state,
printQRInTerminal:false,
[span_0](start_span)// --- 1. FIX APPLIED: BROWSER CONFIG ---[span_0](end_span)
browser: ["Ubuntu", "Chrome", "20.0.04"]
})

sock.ev.on("creds.update",saveCreds)

sock.ev.on("connection.update",(update)=>{

const {connection,lastDisconnect}=update

if(connection==="close"){
addLog("🔄 Connection closed. Attempting reconnect...");
const shouldReconnect=
lastDisconnect?.error?.output?.statusCode!==DisconnectReason.loggedOut

if(shouldReconnect) startBot()

}

if(connection==="open"){
console.log("✅ WhatsApp connected")
addLog("✅ WhatsApp connected successfully!");
webPairingCode = "✅ Bot is successfully connected to WhatsApp!"
}

})

if(!sock.authState.creds.registered){
    setTimeout(async () => {
        console.log("⚠️ Pairing")
        const cleaned=BOT_NUMBER.replace(/[^0-9]/g,"")
        try {
            const code=await sock.requestPairingCode(cleaned)
            console.log("🔥 PAIR CODE:",code)
            webPairingCode = `🔥 PAIR CODE: ${code}` // Save to show on website
            addLog(`🔑 New Pairing Code: ${code}`);
        } catch (e) {
            console.log("Retry pairing in next restart...")
            webPairingCode = "❌ Error generating code. Check Render logs."
            addLog("❌ Pairing failed. Check if BOT_NUMBER is correct.");
        }
    }, 5000) 
}

sock.ev.on("group-participants.update",async(data)=>{

const metadata=await sock.groupMetadata(data.id)

for(const user of data.participants){

if(data.action==="add"){
addLog(`👤 User joined group: ${user}`);
await sock.sendMessage(data.id,{
text:`👋 Welcome @${user.split("@")[0]} to *${metadata.subject}*`,
mentions:[user]
})

}

if(data.action==="remove"){
addLog(`👤 User left group: ${user}`);
await sock.sendMessage(data.id,{
text:`👋 Goodbye @${user.split("@")[0]}`,
mentions:[user]
})

}

}

})

sock.ev.on("messages.upsert",async({messages})=>{

const msg=messages[0]
if(!msg.message) return

const from=msg.key.remoteJid
const sender=msg.key.participant||from
const isGroup=from.endsWith("@g.us")

const text=
msg.message.conversation||
msg.message.extendedTextMessage?.text||
""

const command=text.split(" ")[0].toLowerCase()

// --- LOG MESSAGE TO WEBSITE ---
if(text) addLog(`📩 Message from ${sender.split('@')[0]}: "${text}"`);

[span_1](start_span)// --- 2. FIX APPLIED: EXACT OWNER MATCH FOR "MESSAGE YOURSELF" ---[span_1](end_span)
// We extract just the numbers from the sender and owner.
// This prevents bugs where WhatsApp adds ":1" or ":2" to your JID when messaging yourself.
const senderClean = sender.split("@")[0].split(":")[0];
const ownerClean = OWNER_NUMBER.replace(/[^0-9]/g,"");

// BLOCK NON OWNER
if(senderClean !== ownerClean && command.startsWith(".")){
addLog(`🚫 Ignored command from non-owner: ${senderClean}`);
return
}

// ANTI LINK

if(isGroup && text.includes("chat.whatsapp.com")){
addLog("🔗 Anti-link triggered");
await sock.sendMessage(from,{
text:"🚫 Links not allowed"
})

}

// MENU

if(command===".menu"){

const menu=`🤖 BOT MENU

.ai question
.ask question
.gpt question

.ping
.alive
.owner

.time
.date
.quote
.joke
.fact

.tagall
.hidetag

.flip
.dice
.8ball
`
addLog("📋 Menu displayed");
return sock.sendMessage(from,{text:menu})

}

// BASIC

if(command===".ping"){
addLog("🏓 Ping response sent");
return sock.sendMessage(from,{text:"🏓 Pong"})
}

if(command===".alive"){
return sock.sendMessage(from,{text:"✅ Bot is running"})
}

if(command===".owner"){
return sock.sendMessage(from,{text:"👑 Owner verified"})
}

// AI

if([".ai",".ask",".gpt"].includes(command)){

const query=text.replace(command,"").trim()

if(!query) return sock.sendMessage(from,{text:"Ask something."})

await sock.sendMessage(from,{text:"🤖 Thinking..."})
addLog(`🤖 Processing AI query: ${query}`);
const ai=await askGemini(query)

return sock.sendMessage(from,{text:ai})

}

// TIME

if(command===".time"){
return sock.sendMessage(from,{text:new Date().toLocaleTimeString()})
}

if(command===".date"){
return sock.sendMessage(from,{text:new Date().toDateString()})
}

// FUN

if(command===".flip"){
const r=Math.random()>0.5?"Heads":"Tails"
return sock.sendMessage(from,{text:r})
}

if(command===".dice"){
const r=Math.floor(Math.random()*6)+1
return sock.sendMessage(from,{text:"🎲 "+r})
}

if(command===".8ball"){

const arr=[
"Yes",
"No",
"Maybe",
"Ask later",
"Definitely",
"Not likely"
]

const r=arr[Math.floor(Math.random()*arr.length)]

return sock.sendMessage(from,{text:r})

}

// QUOTE

if(command===".quote"){

const res=await axios.get("https://api.quotable.io/random")

return sock.sendMessage(from,{
text:`${res.data.content}\n-${res.data.author}`
})

}

// JOKE

if(command===".joke"){

const res=await axios.get("https://official-joke-api.appspot.com/random_joke")

return sock.sendMessage(from,{
text:`${res.data.setup}\n${res.data.punchline}`
})

}

// FACT

if(command===".fact"){

const res=await axios.get("https://uselessfacts.jsph.pl/random.json?language=en")

return sock.sendMessage(from,{text:res.data.text})

}

// GROUP

if(command===".tagall" && isGroup){

const metadata=await sock.groupMetadata(from)

const participants=metadata.participants

let text="📢 Tagging all\n\n"
let mentions=[]

for(let p of participants){

mentions.push(p.id)
text+=`@${p.id.split("@")[0]}\n`

}

return sock.sendMessage(from,{text,mentions})

}

if(command===".hidetag" && isGroup){

const metadata=await sock.groupMetadata(from)

const mentions=metadata.participants.map(p=>p.id)

return sock.sendMessage(from,{
text:"Hidden tag",
mentions
})

}

})

}

// --- UPDATED WEB VIEW ---
app.get("/",(req,res)=>{
res.send(`
    <div style="font-family: Arial, sans-serif; padding: 20px; text-align: center; max-width: 800px; margin: auto;">
        <h1 style="color: #25D366;">WhatsApp Bot Status</h1>
        <div style="background: #e7fce3; border: 1px solid #25D366; padding: 15px; border-radius: 8px; margin-bottom: 20px;">
            <h3>${webPairingCode}</h3>
        </div>
        
        <div style="text-align: left; background: #1a1a1a; color: #00ff00; padding: 20px; border-radius: 8px; font-family: monospace;">
            <h4 style="color: white; margin-top: 0; border-bottom: 1px solid #444;">Live Activity Logs:</h4>
            <div style="height: 300px; overflow-y: auto;">
                ${statusLogs.length > 0 ? statusLogs.map(log => `<div style="margin-bottom: 5px; border-bottom: 1px solid #333;">${log}</div>`).join('') : '<div>Waiting for activity...</div>'}
            </div>
        </div>
        <p style="color: #666; margin-top: 15px;">Refresh page to update logs. Listening on Port: ${PORT}</p>
    </div>
`)
})

app.listen(PORT,()=>{
console.log("Server running")
})

startBot()
