import { default as makeWASocket, useMultiFileAuthState, fetchLatestBaileysVersion, DisconnectReason, downloadMediaMessage } from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import Pino from 'pino';
import qrcode from 'qrcode-terminal';
import path from 'path';

import db from './db.js';
import { generateAIResponse, resetAIHistory } from './ai.js';
import tgBot, { sendToTelegram } from './telegram.js';

const logger = Pino({ level: 'silent' });
const AUTH_DIR = path.join(process.cwd(), 'data', 'auth_info');

export const toWAJid = (num) => `${num.replace(/\D/g, '')}@s.whatsapp.net`;
export const toNum = (jid) => (jid || '').replace(/@.+$/, '');
export const isGroup = (jid) => (jid || '').includes('@g.us');

const repliedRecently = new Map();

function canAutoReply(jid) {
    const s = db.getSettings();
    if (!s.antiSpam) return true;
    const last = repliedRecently.get(jid) || 0;
    if (Date.now() - last < (s.antiSpamCooldown || 60) * 1000) return false;
    repliedRecently.set(jid, Date.now());
    return true;
}

function getMsgText(msg) {
    const m = msg.message;
    if (!m) return '';
    return m.conversation || m.extendedTextMessage?.text || m.imageMessage?.caption || m.videoMessage?.caption || m.documentMessage?.caption || '';
}

function getMsgMediaType(msg) {
    const m = msg.message;
    if (!m) return null;
    if (m.viewOnceMessage || m.viewOnceMessageV2) return 'viewonce';
    if (m.imageMessage) return 'image';
    if (m.videoMessage) return 'video';
    if (m.audioMessage || m.voiceMessage) return 'audio';
    if (m.stickerMessage) return 'sticker';
    if (m.documentMessage) return 'document';
    return null;
}

export const waQueue = [];
let queueRunning = false;
export let sock = null;

export async function enqueueWA(fn) {
    return new Promise((resolve, reject) => {
        waQueue.push({ fn, resolve, reject });
        if (!queueRunning) processQueue();
    });
}

async function processQueue() {
    if (waQueue.length === 0) { queueRunning = false; return; }
    queueRunning = true;
    const { fn, resolve, reject } = waQueue.shift();
    try { resolve(await fn()); } catch (e) { reject(e); }
    setTimeout(processQueue, 800);
}

export async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    const { version } = await fetchLatestBaileysVersion();

    sock = makeWASocket({
        version,
        auth: state,
        logger,
        browser: ['WA-Bot', 'Chrome', '121.0.0'],
        syncFullHistory: false,
        markOnlineOnConnect: db.getSettings().alwaysOnline,
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            qrcode.generate(qr, { small: true });
            db.log('⏳ QR-код готов. Сканируй в WhatsApp!');
            await sendToTelegram('📱 *WA QR-код обновлён!*\nСканируй в приложении (Settings → Linked Devices).');
        }

        if (connection === 'open') {
            db.log('🚀 WhatsApp подключён!');
            await sendToTelegram('🚀 *WhatsApp подключён!*\nBaileys работает стабильно.');

            if (db.getSettings().alwaysOnline) {
                setInterval(async () => {
                    if (db.getSettings().alwaysOnline) {
                        try { await sock.sendPresenceUpdate('available'); } catch (_) { }
                    }
                }, 45_000);
            }
        }

        if (connection === 'close') {
            const code = new Boom(lastDisconnect?.error)?.output?.statusCode;
            const loggedOut = code === DisconnectReason.loggedOut;
            db.log(`⚠️ WA отключился (код: ${code})`);

            if (loggedOut) {
                await sendToTelegram('🔑 *WA: Требуется повторная авторизация!* Удали папку `data/auth_info` и перезапусти бота.');
            } else {
                await sendToTelegram(`⚠️ *WA отключился!* Переподключение через 5 сек...`);
                setTimeout(connectToWhatsApp, 5_000);
            }
        }
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;
        for (const msg of messages) {
            try { await handleMessage(msg); } 
            catch (err) { db.log(`❌ Ошибка обработки: ${err.message}`); }
        }
    });
}

async function handleMessage(msg) {
    if (!msg.message || msg.key.fromMe) return;

    const jid = msg.key.remoteJid;
    if (!jid || jid === 'status@broadcast' || jid.endsWith('@broadcast')) return;

    const text = getMsgText(msg);
    const textLow = text.toLowerCase();
    const mediaType = getMsgMediaType(msg);
    const settings = db.getSettings();
    const pushName = msg.pushName || toNum(jid);

    db.incStat('messages_received');
    db.log(`📨 ${isGroup(jid) ? '[Группа]' : '[Личка]'} ${pushName}: ${text.slice(0, 50) || `[${mediaType}]`}`);

    const reply = (content) => enqueueWA(() => sock.sendMessage(jid, content, { quoted: msg }));

    if (textLow === '!ping') { return reply({ text: '🤖 *Pong!* Жүйе жұмыс істеп тұр.' }); }
    if (textLow === '!id') { return reply({ text: `🔑 Сіздің WA ID:\n\`${jid}\`` }); }
    if (textLow === '!анализ') { return reply({ text: '🩺 *Еске салу:* Қанды және HbA1c мерзімді тексеруді ұмытпа!' }); }
    if (textLow === '!үй' || textLow === '!дом' || textLow === '!home') { return reply({ text: '🏠 *VECTOR Smart Home*\n✅ Барлық жүйелер қалыпты.' }); }
    if (textLow === '!ауа' || textLow === '!погода') { return reply({ text: '🌤️ Ауа райы әзірге қолжетімді емес.' }); }

    // Калькулятор инсулина
    if (textLow.startsWith('!тамақ') || textLow.startsWith('!еда')) {
        const carbs = parseInt(textLow.replace(/[^\d]/g, ''), 10);
        if (!isNaN(carbs) && carbs > 0) {
            const insulin = (carbs / 10).toFixed(1);
            return reply({ text: `🍽️ *Инсулин калькуляторы:*\nКөмірсулар: *${carbs}г*\n💉 Инсулин: *${insulin} бірлік*\n_Дәрігермен ақылдасыңыз!_` });
        }
        return reply({ text: '⚠️ Формат: `!тамақ 60` (көмірсу граммы)' });
    }

    if (!isGroup(jid)) {
        db.trackContact(jid, pushName, mediaType ? `[${mediaType}]` : text);

        let autoReplied = false;
        if (!canAutoReply(jid)) { } 
        else if (db.getCustomReply(jid)) {
            await reply({ text: db.getCustomReply(jid) });
            autoReplied = true;
            db.incStat('custom_replies');
        } else if (settings.aiEnabled && !mediaType && text) {
            const personalPrompt = db.getCustomPrompt(jid);
            const activePrompt = personalPrompt || settings.globalAIPrompt || null;
            
            if (activePrompt) {
                const aiText = await generateAIResponse(text, pushName, activePrompt);
                if (aiText) {
                    await reply({ text: `🤖 ${aiText}` });
                    autoReplied = true;
                } else if (settings.autoReplyUrgent) {
                    await reply({ text: settings.defaultAutoReply });
                    autoReplied = true;
                    db.incStat('auto_replies');
                }
            } else if (settings.autoReplyUrgent) {
                await reply({ text: settings.defaultAutoReply });
                autoReplied = true;
                db.incStat('auto_replies');
            }
        } else if (settings.autoReplyUrgent) {
            await reply({ text: settings.defaultAutoReply });
            autoReplied = true;
            db.incStat('auto_replies');
        }

        let tgText = `💬 *От:* ${pushName} \`(${jid})\`\n`;
        if (autoReplied) tgText += `🤖 _(Ответ отправлен)_\n`;
        tgText += '\n';

        if (mediaType === 'viewonce') {
            tgText += `🔒 _[Медиа однократного просмотра]_`;
            tgText += `\n\n---\n\`WA_ID: ${jid}\`\n_↩️ Ответь на это сообщение_`;
            await sendToTelegram(tgText);
            return;
        }

        if (mediaType && settings.forwardMedia) {
            try {
                const buffer = await downloadMediaMessage(msg, 'buffer', {}, { logger, reuploadRequest: sock.updateMediaMessage });
                const caption = `${tgText}📎 _[${mediaType}]_\n${text || ''}\n\n\`WA_ID: ${jid}\`\n_↩️ Ответь_`;
                
                const TG_CHAT_ID = process.env.TG_CHAT_ID;
                if (mediaType === 'image') await tgBot.sendPhoto(TG_CHAT_ID, buffer, { caption, parse_mode: 'Markdown' });
                else if (mediaType === 'video') await tgBot.sendVideo(TG_CHAT_ID, buffer, { caption, parse_mode: 'Markdown' });
                else if (mediaType === 'audio') await tgBot.sendVoice(TG_CHAT_ID, buffer, { caption, parse_mode: 'Markdown' });
                else if (mediaType === 'sticker') await tgBot.sendSticker(TG_CHAT_ID, buffer);
                else await tgBot.sendDocument(TG_CHAT_ID, buffer, { caption, parse_mode: 'Markdown' });
                db.incStat('media_forwarded');
                return;
            } catch (e) {
                tgText += `📎 _[${mediaType}: ошибка загрузки]_\n`;
            }
        } else if (mediaType && !settings.forwardMedia) {
            tgText += `📁 _[${mediaType} скрыт]_\n${text}`;
        } else {
            tgText += text;
        }

        tgText += `\n\n---\n\`WA_ID: ${jid}\`\n_↩️ Ответь на это сообщение_`;
        await sendToTelegram(tgText);
    }
}
