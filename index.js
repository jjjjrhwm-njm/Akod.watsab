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

const bot = new Telegraf(process.env.TELEGRAM_TOKEN);
const ADMIN_ID = "7650083401"; 

let sock;
let qrCodeData = ""; 
const userState = new Map();

// --- [ 2. ميزة النبض: منع السيرفر من النوم ] ---
setInterval(() => {
    const host = process.env.RENDER_EXTERNAL_HOSTNAME;
    if (host) {
        https.get(`https://${host}/ping`, (res) => {
            console.log(`💓 نبض النظام: مستقر ${res.statusCode}`);
        }).on('error', () => {});
    }
}, 10 * 60 * 1000); // كل 10 دقائق

// --- [ 3. محرك الوتساب مع حفظ الجلسة ] ---
async function startNjmSystem() {
    const folder = './auth_info_njm';
    if (!fs.existsSync(folder)) fs.mkdirSync(folder);

    // سحب الجلسة من Firebase إذا كانت موجودة (لكي لا تصور الكود مرتين)
    try {
        const sessionSnap = await db.collection('session').doc('njm_wa').get();
        if (sessionSnap.exists) fs.writeFileSync(`${folder}/creds.json`, JSON.stringify(sessionSnap.data()));
    } catch (e) {}

    const { state, saveCreds } = await useMultiFileAuthState(folder);
    const { version } = await fetchLatestBaileysVersion();

    sock = makeWASocket({
        version,
        auth: state,
        logger: pino({ level: 'silent' }),
        // إيهام الوتساب بأنه متصفح حقيقي (MacBook Chrome)
        browser: ["Mac OS", "Chrome", "121.0.6167.85"]
    });

    sock.ev.on('creds.update', async () => {
        await saveCreds();
        // حفظ الجلسة فوراً في Firebase للأمان
        await db.collection('session').doc('njm_wa').set(state.creds, { merge: true });
    });

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;
        if (qr) qrCodeData = qr;
        if (connection === 'open') {
            qrCodeData = "CONNECTED";
            bot.telegram.sendMessage(ADMIN_ID, "🌟 *نجم الإبداع متصل الآن بالوتساب!*");
        }
        if (connection === 'close') {
            const code = (lastDisconnect.error instanceof Boom) ? lastDisconnect.error.output.statusCode : 0;
            if (code !== DisconnectReason.loggedOut) startNjmSystem();
        }
    });
}

// --- [ 4. بوابة الحماية والمزامنة ] ---

app.get("/request-otp", async (req, res) => {
    const { phone, name, app: appName, deviceId } = req.query;
    const otp = Math.floor(100000 + Math.random() * 899999).toString();

    try {
        // لا نحفظ المستخدم في users الآن، بل في قائمة مؤقتة للتحقق فقط
        await db.collection('otps').doc(phone).set({ 
            code: otp, appName, name, deviceId, createdAt: new Date() 
        });

        if (sock && qrCodeData === "CONNECTED") {
            const jid = phone.replace(/\D/g, '') + "@s.whatsapp.net";
            await sock.sendMessage(jid, { text: `🔒 *كود التحقق*\nتطبيق: ${appName}\nكودك: *${otp}*` });
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
            // الآن فقط، بعد التحقق، نحفظه كمستخدم موثق
            await db.collection('users').doc(`${phone}_${data.appName}`).set({
                phone, name: data.name, deviceId: data.deviceId, appName: data.appName, verified: true 
            }, { merge: true });
            bot.telegram.sendMessage(ADMIN_ID, `🎯 *صيد جديد موثق!*\n📱: ${data.appName}\n👤: ${data.name}\n📞: ${phone}`);
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

// واجهة عرض الكود QR (مباشرة في المتصفح)
app.get("/", async (req, res) => {
    if (qrCodeData === "CONNECTED") return res.send("<h1>✅ النظام مرتبط وشغال!</h1>");
    if (!qrCodeData) return res.send("<h1>⏳ جاري التحميل...</h1>");
    const qrImage = await QRCode.toDataURL(qrCodeData);
    res.send(`<div style='text-align:center;'><img src='${qrImage}' width='300'/><h3>صور الكود بجوالك</h3></div>`);
});

app.get("/ping", (req, res) => res.send("💓"));

// --- [ 5. أوامر الإدارة (نجم) ] ---
bot.on('text', async (ctx) => {
    if (ctx.chat.id.toString() !== ADMIN_ID) return;
    const text = ctx.message.text;
    if (text === "نجم احصا") {
        const snap = await db.collection('users').get();
        ctx.reply(`📊 إجمالي المستخدمين الموثقين: ${snap.size}`);
    }
    if (text === "نجم بنج") ctx.reply("🚀 السيرفر في قمة نشاطه!");
});

bot.launch();
app.listen(process.env.PORT || 10000, () => startNjmSystem());
