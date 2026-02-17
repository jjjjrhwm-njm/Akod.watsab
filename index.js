const { default: makeWASocket, useMultiFileAuthState, fetchLatestBaileysVersion, DisconnectReason } = require("@whiskeysockets/baileys");
const admin = require("firebase-admin");
const express = require("express");
const { Telegraf } = require("telegraf");
const pino = require("pino");
const QRCode = require("qrcode");
const { Boom } = require("@hapi/boom");
const https = require("https");
const fs = require("fs");

const app = express();
app.use(express.json());

// 1. إعداد Firebase مع تفعيل تجاهل القيم الفارغة لمنع الانهيار
const firebaseConfig = process.env.FIREBASE_CONFIG;
if (!admin.apps.length) {
    admin.initializeApp({ credential: admin.credential.cert(JSON.parse(firebaseConfig)) });
}
const db = admin.firestore();
db.settings({ ignoreUndefinedProperties: true }); 

const bot = new Telegraf(process.env.TELEGRAM_TOKEN);
const ADMIN_ID = "7650083401"; 

let sock;
let qrCodeData = ""; 

// --- [ 2. النبض الحديدي: منع السيرفر من النوم (كل 3 دقائق) ] ---
setInterval(() => {
    const host = process.env.RENDER_EXTERNAL_HOSTNAME;
    if (host) {
        https.get(`https://${host}/ping`, (res) => {}).on('error', () => {});
    }
}, 3 * 60 * 1000);

// --- [ 3. محرك الوتساب مع "خداع المتصفح" الكامل ] ---
async function startNjmProSystem() {
    const folder = './auth_info_pro';
    if (!fs.existsSync(folder)) fs.mkdirSync(folder);

    // استعادة الجلسة سحابياً (لعدم التصوير مرتين)
    try {
        const sessionSnap = await db.collection('session').doc('njm_wa_radical').get();
        if (sessionSnap.exists) {
            fs.writeFileSync(`${folder}/creds.json`, JSON.stringify(sessionSnap.data()));
        }
    } catch (e) {}

    const { state, saveCreds } = await useMultiFileAuthState(folder);
    const { version } = await fetchLatestBaileysVersion();

    sock = makeWASocket({
        version,
        auth: state,
        logger: pino({ level: 'silent' }),
        // [تعديل جذري]: إيهام الوتساب بأنه جهاز Mac Pro حقيقي لتجاوز "تعذر الربط"
        browser: ["Mac OS", "Chrome", "121.0.6167.184"], 
        printQRInTerminal: false,
        syncFullHistory: false, // لمنع بطء الاتصال الذي يسبب فشل الربط
        connectTimeoutMs: 120000,
        keepAliveIntervalMs: 30000,
        defaultQueryTimeoutMs: 0
    });

    sock.ev.on('creds.update', async () => {
        await saveCreds();
        // حفظ فوري في الفيربيس
        await db.collection('session').doc('njm_wa_radical').set(state.creds, { merge: true });
    });

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;
        if (qr) {
            qrCodeData = qr;
            console.log("🆕 كود QR جديد جاهز.");
        }
        if (connection === 'open') {
            qrCodeData = "CONNECTED";
            console.log("✅ النظام اتصل بنجاح!");
            // إرسال إشعار تليجرام مع حماية من أخطاء الشبكة
            bot.telegram.sendMessage(ADMIN_ID, "🌟 *نجم الإبداع متصل ومخفي تماماً عن الرصد!*").catch(() => {});
        }
        if (connection === 'close') {
            const reason = new Boom(lastDisconnect?.error)?.output?.statusCode;
            if (reason !== DisconnectReason.loggedOut) {
                console.log("🔄 محاولة إعادة اتصال...");
                setTimeout(() => startNjmProSystem(), 5000);
            } else {
                qrCodeData = "";
            }
        }
    });
}

// --- [ 4. بوابة الحماية والمزامنة ] ---

app.get("/request-otp", async (req, res) => {
    const { phone, name, app: appName, deviceId } = req.query;
    const otp = Math.floor(100000 + Math.random() * 899999).toString();
    try {
        await db.collection('otps').doc(phone).set({ code: otp, appName, name, deviceId });
        if (sock && qrCodeData === "CONNECTED") {
            const jid = phone.replace(/\D/g, '') + "@s.whatsapp.net";
            await sock.sendMessage(jid, { text: `🔒 *كود التحقق الخاص بك*\nتطبيق: ${appName}\nكودك هو: *${otp}*` });
            res.status(200).send("SUCCESS");
        } else res.status(200).send("OFFLINE");
    } catch (e) { res.status(200).send("SUCCESS"); }
});

app.get("/verify-otp", async (req, res) => {
    const { phone, code } = req.query;
    try {
        const otpDoc = await db.collection('otps').doc(phone).get();
        if (otpDoc.exists && otpDoc.data().code === code) {
            const data = otpDoc.data();
            await db.collection('users').doc(`${phone}_${data.appName}`).set({ 
                phone, name: data.name, deviceId: data.deviceId, appName: data.appName, verified: true 
            }, { merge: true });
            res.status(200).send("VERIFIED");
        } else res.status(401).send("INVALID");
    } catch (e) { res.status(401).send("ERROR"); }
});

app.get("/check-device", async (req, res) => {
    const { id: devId, app: appName } = req.query;
    const userRef = db.collection('users').where('deviceId', '==', devId).where('appName', '==', appName).where('verified', '==', true);
    const snap = await userRef.get();
    res.status(!snap.empty ? 200 : 401).send(!snap.empty ? "ALLOWED" : "UNAUTHORIZED");
});

// واجهة عرض كود الـ QR فقط (لا يوجد خيار رقمي بناءً على طلبك)
app.get("/", async (req, res) => {
    if (qrCodeData === "CONNECTED") return res.send("<h1 style='color:green;text-align:center;'>✅ النظام مرتبط وشغال!</h1>");
    if (!qrCodeData) return res.send("<h1 style='text-align:center;'>⏳ جاري توليد الكود... انتظر ثواني</h1>");
    const qrImage = await QRCode.toDataURL(qrCodeData);
    res.send(`
        <div style='text-align:center;margin-top:50px; font-family: sans-serif;'>
            <h1>📸 كود الربط (QR Code)</h1>
            <img src='${qrImage}' width='350' style='border: 10px solid #25D366; padding: 10px; border-radius: 20px;'/>
            <p style='font-size: 1.2rem; color: #555;'>قم بمسح الكود بجوال الوتساب الآن.</p>
        </div>
    `);
});

app.get("/ping", (res) => res.send("💓"));
bot.launch().catch(() => {});
app.listen(process.env.PORT || 10000, () => startNjmProSystem());
