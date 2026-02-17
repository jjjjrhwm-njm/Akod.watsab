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

// 1. إعداد Firebase (الخزانة tsgil-wts)
const firebaseConfig = process.env.FIREBASE_CONFIG;
if (!admin.apps.length) {
    admin.initializeApp({ credential: admin.credential.cert(JSON.parse(firebaseConfig)) });
}
const db = admin.firestore();

// 2. إعداد التليجرام مع حماية من الانهيار
const bot = new Telegraf(process.env.TELEGRAM_TOKEN);
const ADMIN_ID = "7650083401"; 

let sock;
let qrCodeData = ""; 

// --- [ 3. ميزة النبض الفائق: منع السيرفر من النوم نهائياً ] ---
setInterval(() => {
    const host = process.env.RENDER_EXTERNAL_HOSTNAME;
    if (host) {
        https.get(`https://${host}/ping`, (res) => {
            console.log(`💓 نبض النظام مستقر: ${res.statusCode}`);
        }).on('error', () => console.log("⚠️ نبض مؤقت"));
    }
}, 3 * 60 * 1000); // كل 3 دقائق لضمان النشاط التام

// --- [ 4. محرك الوتساب مع إصلاح "تعذر الربط" ] ---
async function startNjmSystem() {
    const folder = './auth_info_njm';
    if (!fs.existsSync(folder)) fs.mkdirSync(folder);

    // سحب الجلسة المحفوظة من Firebase (الحفظ السحابي)
    try {
        const sessionSnap = await db.collection('session').doc('njm_wa').get();
        if (sessionSnap.exists) {
            fs.writeFileSync(`${folder}/creds.json`, JSON.stringify(sessionSnap.data()));
            console.log("📂 تم استعادة الجلسة من السحاب.");
        }
    } catch (e) { console.log("⚠️ لا توجد جلسة سحابية سابقة."); }

    const { state, saveCreds } = await useMultiFileAuthState(folder);
    const { version } = await fetchLatestBaileysVersion();

    sock = makeWASocket({
        version,
        auth: state,
        logger: pino({ level: 'silent' }),
        // تغيير الهوية لهوية متصفح ثابتة جداً لتقليل "تعذر الربط"
        browser: ["Ubuntu", "Chrome", "110.0.5481.177"],
        connectTimeoutMs: 60000, // زيادة وقت الانتظار للاتصال
        defaultQueryTimeoutMs: 0,
        keepAliveIntervalMs: 10000
    });

    sock.ev.on('creds.update', async () => {
        await saveCreds();
        // حفظ فوري في Firebase لضمان عدم ضياع الربط حتى لو انطفا السيرفر
        await db.collection('session').doc('njm_wa').set(state.creds, { merge: true });
    });

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;
        if (qr) {
            qrCodeData = qr;
            console.log("💡 كود QR جديد جاهز للمسح.");
        }
        if (connection === 'open') {
            qrCodeData = "CONNECTED";
            console.log("✅ الوتساب متصل!");
            bot.telegram.sendMessage(ADMIN_ID, "🌟 *نظام الوتساب متصل وجاهز للعمل!*").catch(() => {});
        }
        if (connection === 'close') {
            const reason = new Boom(lastDisconnect?.error)?.output?.statusCode;
            if (reason !== DisconnectReason.loggedOut) {
                console.log("🔄 إعادة الاتصال تلقائياً...");
                setTimeout(() => startNjmSystem(), 5000);
            } else {
                qrCodeData = ""; // تصفير الكود في حال سجلت الخروج
            }
        }
    });
}

// --- [ 5. مسارات الربط مع التطبيقات ] ---

app.get("/request-otp", async (req, res) => {
    const { phone, name, app: appName, deviceId } = req.query;
    const otp = Math.floor(100000 + Math.random() * 899999).toString();

    try {
        await db.collection('otps').doc(phone).set({ 
            code: otp, appName, name, deviceId, createdAt: admin.firestore.FieldValue.serverTimestamp() 
        });

        if (sock && qrCodeData === "CONNECTED") {
            const jid = phone.replace(/\D/g, '') + "@s.whatsapp.net";
            await sock.sendMessage(jid, { text: `🔒 *كود التحقق*\nتطبيق: ${appName}\nكودك: *${otp}*` });
            res.status(200).send("SUCCESS");
        } else {
            res.status(200).send("OFFLINE");
        }
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
            
            bot.telegram.sendMessage(ADMIN_ID, `🎯 *صيد جديد موثق!*\n📱: ${data.appName}\n👤: ${data.name}\n📞: ${phone}`).catch(() => {});
            res.status(200).send("VERIFIED");
        } else {
            res.status(401).send("INVALID");
        }
    } catch (e) { res.status(401).send("ERROR"); }
});

app.get("/check-device", async (req, res) => {
    const { id: devId, app: appName } = req.query;
    try {
        const userRef = db.collection('users').where('deviceId', '==', devId).where('appName', '==', appName).where('verified', '==', true);
        const snap = await userRef.get();
        res.status(!snap.empty ? 200 : 401).send(!snap.empty ? "ALLOWED" : "UNAUTHORIZED");
    } catch (e) { res.status(401).send("ERROR"); }
});

// عرض الكود QR في المتصفح بشكل مباشر
app.get("/", async (req, res) => {
    if (qrCodeData === "CONNECTED") return res.send("<h1 style='color:green;text-align:center;'>✅ النظام متصل وشغال!</h1>");
    if (!qrCodeData) return res.send("<h1 style='text-align:center;'>⏳ جاري توليد الكود... حدث الصفحة</h1>");
    const qrImage = await QRCode.toDataURL(qrCodeData);
    res.send(`<div style='text-align:center;margin-top:50px;'><img src='${qrImage}' width='300'/><h3>صور الكود بجوالك الآن</h3><p>نجم الإبداع - نسخة الوتساب</p></div>`);
});

app.get("/ping", (req, res) => res.send("💓"));

bot.launch().catch(() => console.log("⚠️ تليجرام معلق مؤقتاً"));

app.listen(process.env.PORT || 10000, () => startNjmSystem());
