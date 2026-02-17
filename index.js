// تم حذف require("dotenv").config() لأن Render يتعرف على المتغيرات تلقائياً
const { 
    default: makeWASocket, 
    useMultiFileAuthState, 
    fetchLatestBaileysVersion, 
    delay 
} = require("@whiskeysockets/baileys");
const admin = require("firebase-admin");
const express = require("express");
const fs = require("fs");
const pino = require("pino");

const app = express();
app.use(express.json());

let sock;
const tempCodes = new Map();

// إعداد Firebase - تأكد أن WEB_CONCURRENCY لا يتدخل
const firebaseConfig = process.env.FIREBASE_CONFIG;
if (!firebaseConfig) {
    console.error("❌ خطأ: لم يتم العثور على FIREBASE_CONFIG في متغيرات البيئة!");
    process.exit(1);
}

const serviceAccount = JSON.parse(firebaseConfig);
if (!admin.apps.length) {
    admin.initializeApp({ 
        credential: admin.credential.cert(serviceAccount),
        databaseURL: `https://${serviceAccount.project_id}.firebaseio.com`
    });
}
const db = admin.firestore();

async function startBot() {
    if (!fs.existsSync('./auth_info')) fs.mkdirSync('./auth_info');
    try {
        const doc = await db.collection('session').doc('session_vip_rashed').get();
        if (doc.exists) {
            fs.writeFileSync('./auth_info/creds.json', JSON.stringify(doc.data()));
            console.log("✅ تم سحب الهوية بنجاح.");
        }
    } catch (e) { 
        console.log("⚠️ فشل سحب الجلسة."); 
    }

    const { state, saveCreds } = await useMultiFileAuthState('auth_info');
    const { version } = await fetchLatestBaileysVersion();

    sock = makeWASocket({
        version,
        auth: state,
        printQRInTerminal: true,
        logger: pino({ level: "silent" }),
        browser: ["Mac OS", "Chrome", "114.0.5735.198"],
        markOnlineOnConnect: true,
        syncFullHistory: false
    });

    sock.ev.on('creds.update', async () => {
        await saveCreds();
        const creds = JSON.parse(fs.readFileSync('./auth_info/creds.json', 'utf8'));
        await db.collection('session').doc('session_vip_rashed').set(creds, { merge: true });
    });

    sock.ev.on('connection.update', (update) => {
        const { connection } = update;
        if (connection === 'open') {
            console.log("🚀 نظام OTP جاهز للعمل.");
        }
    });
}

app.post("/request-otp", async (req, res) => {
    const { phone } = req.body;
    if (!phone) return res.status(400).json({ success: false, error: "الرقم مطلوب" });
    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    tempCodes.set(phone, otp);
    try {
        const jid = phone.replace(/\D/g, '') + "@s.whatsapp.net";
        await sock.sendPresenceUpdate('composing', jid);
        await delay(1500);
        await sock.sendMessage(jid, { text: `*🔐 كود التحقق الخاص بك هو:* \n\n *${otp}*` });
        res.status(200).json({ success: true });
    } catch (e) {
        res.status(500).json({ success: false });
    }
});

app.post("/verify-otp", (req, res) => {
    const { phone, code } = req.body;
    if (tempCodes.has(phone) && tempCodes.get(phone) === code) {
        tempCodes.delete(phone);
        return res.status(200).json({ success: true });
    }
    res.status(401).json({ success: false });
});

app.listen(process.env.PORT || 10000, () => {
    startBot();
});
