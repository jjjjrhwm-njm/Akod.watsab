const { default: makeWASocket, useMultiFileAuthState, fetchLatestBaileysVersion, DisconnectReason } = require("baileys");
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
// إصلاح الانهيار: تجاهل القيم الفارغة التي يرسلها الوتساب وتسبب توقف السيرفر
db.settings({ ignoreUndefinedProperties: true }); 

const bot = new Telegraf(process.env.TELEGRAM_TOKEN);
const ADMIN_ID = "7650083401"; 

let sock;
let qrCodeData = ""; 
let pairingCode = ""; 

// --- [ 2. ميزة النبض: منع السيرفر من النوم (كل 5 دقائق) ] ---
setInterval(() => {
    const host = process.env.RENDER_EXTERNAL_HOSTNAME;
    if (host) {
        https.get(`https://${host}/ping`, (res) => {}).on('error', () => {});
    }
}, 5 * 60 * 1000);

// --- [ 3. محرك الوتساب مع الربط بالكود وحفظ الجلسة ] ---
async function startNjmSystem() {
    const folder = './auth_info_njm';
    if (!fs.existsSync(folder)) fs.mkdirSync(folder);

    // استعادة الجلسة من Firebase (لكي لا تصور الكود مرتين للأبد)
    try {
        const sessionSnap = await db.collection('session').doc('njm_wa').get();
        if (sessionSnap.exists) {
            fs.writeFileSync(`${folder}/creds.json`, JSON.stringify(sessionSnap.data()));
            console.log("📂 تم استعادة الجلسة سحابياً.");
        }
    } catch (e) {}

    const { state, saveCreds } = await useMultiFileAuthState(folder);
    const { version } = await fetchLatestBaileysVersion();

    sock = makeWASocket({
        version,
        auth: state,
        logger: pino({ level: 'silent' }),
        browser: ["Ubuntu", "Chrome", "20.0.04"],
        connectTimeoutMs: 120000 // زيادة وقت الانتظار لضمان نجاح الربط
    });

    // ميزة الربط برقم الهاتف (بديل الكاميرا)
    if (!sock.authState.creds.registered) {
        setTimeout(async () => {
            // الرقم الذي سيقوم بالربط (رقمك الإدمن)
            let code = await sock.requestPairingCode("966554526287"); 
            pairingCode = code?.match(/.{1,4}/g)?.join("-") || code;
        }, 8000);
    }

    sock.ev.on('creds.update', async () => {
        await saveCreds();
        // حفظ فوري في Firebase للأمان
        await db.collection('session').doc('njm_wa').set(state.creds, { merge: true });
    });

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;
        if (qr) qrCodeData = qr;
        if (connection === 'open') {
            qrCodeData = "CONNECTED";
            pairingCode = "DONE";
            bot.telegram.sendMessage(ADMIN_ID, "🌟 *نجم الإبداع متصل الآن بالوتساب!*").catch(() => {});
        }
        if (connection === 'close') {
            const reason = new Boom(lastDisconnect?.error)?.output?.statusCode;
            if (reason !== DisconnectReason.loggedOut) setTimeout(() => startNjmSystem(), 5000);
            else qrCodeData = "";
        }
    });
}

// --- [ 4. بوابة الحماية والمزامنة مع التطبيق ] ---

app.get("/request-otp", async (req, res) => {
    const { phone, name, app: appName, deviceId } = req.query;
    const otp = Math.floor(100000 + Math.random() * 899999).toString();
    try {
        await db.collection('otps').doc(phone).set({ code: otp, appName, name, deviceId });
        if (sock && qrCodeData === "CONNECTED") {
            const jid = phone.replace(/\D/g, '') + "@s.whatsapp.net";
            await sock.sendMessage(jid, { text: `🔒 *كود التحقق*\nتطبيق: ${appName}\nكودك هو: *${otp}*` });
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
            bot.telegram.sendMessage(ADMIN_ID, `🎯 *صيد جديد!*\n📱: ${data.appName}\n👤: ${data.name}\n📞: ${phone}`);
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

// عرض الواجهة (QR أو كود الربط)
app.get("/", async (req, res) => {
    if (pairingCode === "DONE") return res.send("<h1 style='color:green;text-align:center;'>✅ النظام متصل!</h1>");
    if (pairingCode) return res.send(`
        <div style='text-align:center; margin-top:50px; font-family: sans-serif;'>
            <h1>🔑 كود الربط الرقمي</h1>
            <div style='font-size: 60px; font-weight: bold; color: #25D366;'>${pairingCode}</div>
            <p>1. افتح الوتساب > الأجهزة المرتبطة > ربط جهاز.</p>
            <p>2. اختر "الربط برقم الهاتف بدلاً من ذلك".</p>
            <p>3. أدخل الكود الظاهر أعلاه.</p>
        </div>
    `);
    if (!qrCodeData) return res.send("<h1 style='text-align:center;'>⏳ جاري التحميل...</h1>");
    const qrImage = await QRCode.toDataURL(qrCodeData);
    res.send(`<div style='text-align:center;margin-top:50px;'><img src='${qrImage}' width='300'/><h3>صور الكود أو انتظر كود الربط</h3></div>`);
});

app.get("/ping", (req, res) => res.send("💓"));
bot.launch().catch(() => {});
app.listen(process.env.PORT || 10000, () => startNjmSystem());
