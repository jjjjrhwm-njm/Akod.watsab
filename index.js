const { 
    default: makeWASocket, 
    useMultiFileAuthState, 
    fetchLatestBaileysVersion, 
    delay 
} = require("@whiskeysockets/baileys");
const admin = require("firebase-admin");
const express = require("express");
const QRCode = require("qrcode"); // مكتبة تحويل الكود لصورة
const fs = require("fs");
const pino = require("pino");

const app = express();
app.use(express.json());

let sock;
let qrImage = ""; // هنا سنخزن صورة الكود
const tempCodes = new Map();

// إعداد Firebase
const firebaseConfig = process.env.FIREBASE_CONFIG;
const serviceAccount = JSON.parse(firebaseConfig);
if (!admin.apps.length) {
    admin.initializeApp({ 
        credential: admin.credential.cert(serviceAccount),
        databaseURL: `https://${serviceAccount.project_id}.firebaseio.com`
    });
}
const db = admin.firestore();

async function startBot() {
    if (!fs.existsSync('./auth_info_web')) fs.mkdirSync('./auth_info_web');

    const { state, saveCreds } = await useMultiFileAuthState('auth_info_web');
    const { version } = await fetchLatestBaileysVersion();

    sock = makeWASocket({
        version,
        auth: state,
        logger: pino({ level: "silent" }),
        browser: ["Mac OS", "Safari", "17.0"],
        syncFullHistory: false
    });

    sock.ev.on('creds.update', async () => {
        await saveCreds();
        const creds = JSON.parse(fs.readFileSync('./auth_info_web/creds.json', 'utf8'));
        await db.collection('session').doc('session_otp_new').set(creds, { merge: true });
    });

    sock.ev.on('connection.update', async (update) => {
        const { connection, qr } = update;
        
        if (qr) {
            // تحويل الكود إلى رابط صورة لعرضه في المتصفح
            qrImage = await QRCode.toDataURL(qr);
            console.log("🔄 تم تحديث كود QR.. افتح رابط المتصفح الآن.");
        }

        if (connection === 'open') {
            qrImage = "DONE"; // لإخفاء الكود بعد النجاح
            console.log("🚀 تم الاتصال بنجاح!");
        }
    });
}

// --- الصفحة الرئيسية لعرض الكود ---
app.get("/", (req, res) => {
    if (qrImage === "DONE") {
        res.send("<h1 style='text-align:center;color:green;margin-top:50px;'>✅ البوت متصل الآن بنجاح!</h1>");
    } else if (qrImage) {
        res.send(`
            <div style='text-align:center;margin-top:50px;font-family:Arial;'>
                <h1>🔐 امسح الكود لتفعيل البوت</h1>
                <img src="${qrImage}" style="border: 10px solid #f0f0f0; border-radius: 10px; padding: 10px;">
                <p>افتح الواتساب > الأجهزة المرتبطة > ربط جهاز</p>
                <script>setTimeout(() => { location.reload(); }, 20000);</script>
            </div>
        `);
    } else {
        res.send("<h1 style='text-align:center;margin-top:50px;'>🔄 جاري توليد الكود... انتظر ثواني</h1><script>setTimeout(() => { location.reload(); }, 5000);</script>");
    }
});

// مسارات الـ API (طلب الكود والتحقق)
app.post("/request-otp", async (req, res) => {
    const { phone } = req.body;
    if (!phone) return res.status(400).json({ success: false });
    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    tempCodes.set(phone, otp);
    try {
        const jid = phone.replace(/\D/g, '') + "@s.whatsapp.net";
        await sock.sendMessage(jid, { text: `*🔐 كود التحقق:* \n\n *${otp}*` });
        res.status(200).json({ success: true });
    } catch (e) { res.status(500).json({ success: false }); }
});

app.listen(process.env.PORT || 10000, () => {
    startBot();
});
