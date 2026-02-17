const { 
    default: makeWASocket, 
    useMultiFileAuthState, 
    fetchLatestBaileysVersion, 
    DisconnectReason,
    delay 
} = require("@whiskeysockets/baileys");
const admin = require("firebase-admin");
const express = require("express");
const QRCode = require("qrcode");
const fs = require("fs");
const pino = require("pino");

const app = express();
app.use(express.json());

let sock;
let qrImage = ""; 
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
    // استخدام مجلد نظيف للهوية المستقرة
    if (!fs.existsSync('./auth_info_stable')) fs.mkdirSync('./auth_info_stable');

    const { state, saveCreds } = await useMultiFileAuthState('auth_info_stable');
    const { version } = await fetchLatestBaileysVersion();

    sock = makeWASocket({
        version,
        auth: state,
        logger: pino({ level: "silent" }),
        // 🛡️ خداع المتصفح: بصمة Chrome مستقرة جداً لتمثيل واتساب ويب
        browser: ["Ubuntu", "Chrome", "121.0.6167.160"], 
        printQRInTerminal: false,
        syncFullHistory: false,
        // تحسين إعدادات الانتظار لمنع التغير المفاجئ لكود QR
        connectTimeoutMs: 90000, 
        defaultQueryTimeoutMs: 0,
        keepAliveIntervalMs: 30000, // زيادة وقت نبضات القلب لضمان استقرار الجلسة
        generateHighQualityQR: true
    });

    sock.ev.on('creds.update', async () => {
        await saveCreds();
        const creds = JSON.parse(fs.readFileSync('./auth_info_stable/creds.json', 'utf8'));
        await db.collection('session').doc('session_otp_stable').set(creds, { merge: true });
    });

    sock.ev.on('connection.update', async (update) => {
        const { connection, qr, lastDisconnect } = update;
        
        if (qr) {
            qrImage = await QRCode.toDataURL(qr);
            console.log("🆕 كود QR جديد جاهز.. تم تحسين الثبات.");
        }

        if (connection === 'open') {
            qrImage = "DONE";
            console.log("🚀 تم الربط بنجاح! المتصفح الآن مخادع والجلسة مستقرة.");
        }

        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect.error)?.output?.statusCode !== DisconnectReason.loggedOut;
            if (shouldReconnect) {
                console.log("🔄 إعادة محاولة الاتصال لاستعادة الثبات...");
                startBot();
            }
        }
    });
}

// واجهة عرض الكود المحدثة (تحديث كل دقيقة لضمان سهولة المسح)
app.get("/", (req, res) => {
    if (qrImage === "DONE") {
        res.send("<body style='background:#f0f2f5;text-align:center;font-family:Arial;'><h1 style='color:#25d366;margin-top:100px;'>✅ متصل بنمط المتصفح المستقر</h1></body>");
    } else if (qrImage) {
        res.send(`
            <body style="background:#f0f2f5;text-align:center;font-family:Arial;">
                <div style="background:white;display:inline-block;padding:30px;border-radius:20px;margin-top:50px;box-shadow:0 4px 15px rgba(0,0,0,0.1);">
                    <h2 style="color:#075e54;">نظام تحقق نجم الإبداع (V4 المستقر)</h2>
                    <img src="${qrImage}" style="width:300px;height:300px;">
                    <p style="color:#666;">افتح واتساب > الأجهزة المرتبطة > ربط جهاز</p>
                    <p style="font-size:12px;color:blue;">تم ضبط التحديث التلقائي كل دقيقة لضمان راحتك في المسح</p>
                </div>
                <script>setTimeout(() => { location.reload(); }, 60000);</script> 
            </body>
        `);
    } else {
        res.send("<body style='text-align:center;margin-top:100px;'><h2>🔄 جاري تهيئة بصمة المتصفح...</h2><script>setTimeout(()=>location.reload(),5000)</script></body>");
    }
});

// مسارات OTP
app.post("/request-otp", async (req, res) => {
    const { phone, appName } = req.body;
    if (!phone || !appName) return res.status(400).json({ success: false });
    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    const key = `${phone}:${appName}`;
    tempCodes.set(key, otp);
    try {
        const jid = phone.replace(/\D/g, '') + "@s.whatsapp.net";
        await sock.sendMessage(jid, { text: `*🔐 كود التحقق لـ (${appName}):*\n\nكودك هو: *${otp}*` });
        res.status(200).json({ success: true });
    } catch (e) { res.status(500).json({ success: false }); }
});

app.post("/verify-otp", (req, res) => {
    const { phone, appName, code } = req.body;
    const key = `${phone}:${appName}`;
    if (tempCodes.get(key) === code) {
        tempCodes.delete(key);
        res.status(200).json({ success: true });
    } else { res.status(401).json({ success: false }); }
});

app.listen(process.env.PORT || 10000, () => startBot());
