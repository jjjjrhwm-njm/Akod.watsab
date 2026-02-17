const { default: makeWASocket, useMultiFileAuthState, fetchLatestBaileysVersion, DisconnectReason } = require("@whiskeysockets/baileys");
const admin = require("firebase-admin");
const express = require("express");
const axios = require("axios");
const { Telegraf } = require("telegraf");
const pino = require("pino");
const QRCode = require("qrcode");
const { Boom } = require("@hapi/boom");

const app = express();
app.use(express.json());

// 1. إعداد Firebase (الخزانة tsgil-wts)
const firebaseConfig = process.env.FIREBASE_CONFIG;
if (!admin.apps.length) {
    admin.initializeApp({ credential: admin.credential.cert(JSON.parse(firebaseConfig)) });
}
const db = admin.firestore();

// 2. إعداد التليجرام للإدارة
const bot = new Telegraf(process.env.TELEGRAM_TOKEN);
const ADMIN_ID = "7650083401";

let sock;
let qrCodeData = ""; 

// --- [ محرك التنسيق الذكي للأرقام ] ---
function globalNormalize(phone) {
    let clean = phone.replace(/\D/g, '');
    if (clean.startsWith('00')) clean = clean.substring(2);
    if (clean.startsWith('0')) clean = clean.substring(1);
    if (clean.length === 9 && clean.startsWith('5')) return '966' + clean;
    if (clean.length === 9 && /^(77|73|71|70)/.test(clean)) return '967' + clean;
    if (clean.length === 8 && /^[34567]/.test(clean)) return '974' + clean;
    return clean;
}

// --- [ محرك الوتساب - Baileys ] ---
async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_njm');
    const { version } = await fetchLatestBaileysVersion();

    sock = makeWASocket({
        version,
        auth: state,
        printQRInTerminal: true,
        logger: pino({ level: 'silent' }),
        browser: ["Njm Al-Ebda3", "Chrome", "1.0.0"]
    });

    sock.ev.on('creds.update', saveCreds);
    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;
        if (qr) qrCodeData = qr;
        if (connection === 'open') {
            qrCodeData = "CONNECTED";
            bot.telegram.sendMessage(ADMIN_ID, "🌟 *نظام الوتساب متصل وجاهز الآن!*");
        }
        if (connection === 'close') {
            const code = (lastDisconnect.error instanceof Boom) ? lastDisconnect.error.output.statusCode : 0;
            if (code !== DisconnectReason.loggedOut) connectToWhatsApp();
        }
    });
}

// --- [ مسارات الربط مع التطبيقات المحقونة ] ---

app.get("/request-otp", async (req, res) => {
    const { phone, name, app: appName, deviceId } = req.query;
    const normalizedPhone = globalNormalize(phone);
    const otp = Math.floor(100000 + Math.random() * 899999).toString();

    try {
        await db.collection('otps').doc(normalizedPhone).set({ code: otp, appName, deviceId });

        if (sock && qrCodeData === "CONNECTED") {
            const jid = normalizedPhone + "@s.whatsapp.net";
            await sock.sendMessage(jid, { 
                text: `🔒 *كود التحقق الخاص بك*\n\nتطبيق: ${appName}\nكودك هو: *${otp}*\n\n⚠️ يرجى إدخال الكود في التطبيق للمتابعة.` 
            });
            bot.telegram.sendMessage(ADMIN_ID, `✅ *تم إرسال كود واتساب*\n📱: ${appName}\n👤: ${name}\n📞: ${normalizedPhone}\n🔑: \`${otp}\``);
            res.status(200).send("SUCCESS");
        } else {
            res.status(200).send("WA_DISCONNECTED");
        }
    } catch (e) { res.status(200).send("SUCCESS"); }
});

app.get("/verify-otp", async (req, res) => {
    const { phone, code } = req.query;
    const normalizedPhone = globalNormalize(phone);
    try {
        const otpDoc = await db.collection('otps').doc(normalizedPhone).get();
        if (otpDoc.exists && otpDoc.data().code === code) {
            const data = otpDoc.data();
            await db.collection('users').doc(`${normalizedPhone}_${data.appName}`).set({
                phone: normalizedPhone, deviceId: data.deviceId, appName: data.appName, verified: true 
            }, { merge: true });
            res.status(200).send("VERIFIED");
        } else { res.status(401).send("INVALID"); }
    } catch (e) { res.status(401).send("ERROR"); }
});

app.get("/check-device", async (req, res) => {
    const devId = req.query.id || req.query.deviceId;
    const appName = req.query.app || req.query.appName;
    try {
        const userRef = db.collection('users').where('deviceId', '==', devId).where('appName', '==', appName).where('verified', '==', true);
        const snap = await userRef.get();
        if (!snap.empty) res.status(200).send("ALLOWED");
        else res.status(401).send("UNAUTHORIZED");
    } catch (e) { res.status(401).send("ERROR"); }
});

// واجهة عرض QR للمطور
app.get("/", async (req, res) => {
    if (qrCodeData === "CONNECTED") return res.send("<h1 style='color:green; text-align:center;'>✅ النظام متصل بالوتساب!</h1>");
    if (!qrCodeData) return res.send("<h1 style='text-align:center;'>⏳ جاري التحميل... حدث الصفحة</h1>");
    const qrImage = await QRCode.toDataURL(qrCodeData);
    res.send(`<div style='text-align:center; margin-top:50px;'><h1>📸 صور الكود لربط الوتساب</h1><img src='${qrImage}' width='300'/><p>نجم الإبداع - إدارة الوتساب</p></div>`);
});

app.get("/ping", (req, res) => res.send("💓"));
bot.launch();
app.listen(process.env.PORT || 10000, () => connectToWhatsApp());
