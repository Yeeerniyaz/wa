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

// ==========================================
// ИМИТАЦИЯ ЧЕЛОВЕКА (Анти-бан)
// ==========================================
export async function sendTypingAndMessage(jid, content, options = {}) {
    if (!sock) return;
    
    // Если мы отправляем текст (не картинку и не кнопку), симулируем набор текста
    if (content.text) {
        try {
            await sock.sendPresenceUpdate('composing', jid);
            // Скорость "печати" примерно 1 символ = 40мс. Минимум полторы секунды, максимум 8 секунд.
            const typeTimeMs = Math.max(1500, Math.min(8000, content.text.length * 40));
            await new Promise(resolve => setTimeout(resolve, typeTimeMs));
            await sock.sendPresenceUpdate('paused', jid);
        } catch (e) {
            db.log(`⚠️ Ошибка статуса presence: ${e.message}`);
        }
    }
    
    return sock.sendMessage(jid, content, options);
}

// ==========================================
// ВОРКЕР ПЛАНИРОВЩИКА (Скрытый таймер)
// ==========================================
function startSchedulerWorker() {
    setInterval(async () => {
        if (!sock) return;
        const pending = db.getPendingScheduled();
        for (const task of pending) {
            try {
                await enqueueWA(() => sendTypingAndMessage(toWAJid(task.jid), { text: task.text }));
                db.markScheduledSent(task.id);
                db.log(`⏰ [ПЛАНИРОВЩИК] Отправлено сообщение абоненту +${task.jid}`);
            } catch (err) {
                db.log(`❌ [ПЛАНИРОВЩИК] Ошибка отправки: ${err.message}`);
            }
        }
    }, 15000); // Просыпается каждые 15 секунд и проверяет таймеры
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
            await sendToTelegram('🚀 *WhatsApp подключён!*\nЯдро v2.1: Планировщик и Макросы активированы.');

            if (db.getSettings().alwaysOnline) {
                setInterval(async () => {
                    if (db.getSettings().alwaysOnline) {
                        try { await sock.sendPresenceUpdate('available'); } catch (_) { }
                    }
                }, 45_000);
            }

            // Запускаем воркер только после успешного коннекта
            startSchedulerWorker();
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

    sock.ev.on('contacts.upsert', (contacts) => {
        for (const c of contacts) {
            if (c.name || c.verifiedName) {
                db.setRealContact(c.id, c.name || c.verifiedName);
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
    if (!msg.message) return; // Убрали игнор своих сообщений, чтобы перехватывать макросы!

    const jid = msg.key.remoteJid;
    if (!jid || jid === 'status@broadcast' || jid.endsWith('@broadcast')) return;

    const text = getMsgText(msg);
    const textLow = text.toLowerCase().trim();
    const mediaType = getMsgMediaType(msg);
    const settings = db.getSettings();
    const pushName = msg.pushName || toNum(jid);

    // ==========================================
    // 1. МАКРОСЫ (Работают, когда пишешь ТЫ со своего телефона/ПК)
    // ==========================================
    if (msg.key.fromMe) {
        if (textLow && !mediaType) {
            const macroText = db.getMacro(textLow);
            if (macroText) {
                // Пытаемся удалить твой короткий код ("Удалить у всех")
                try { await sock.sendMessage(jid, { delete: msg.key }); } catch (e) {}
                
                // Отправляем развернутый длинный текст (симулируя печать)
                await enqueueWA(() => sendTypingAndMessage(jid, { text: macroText }));
                db.log(`🪄 Сработал макрос: ${textLow} -> ${pushName}`);
            }
        }
        return; // Свои сообщения дальше (для автоответов) не обрабатываем
    }

    db.incStat('messages_received');
    db.log(`📨 ${isGroup(jid) ? '[Группа]' : '[Личка]'} ${pushName}: ${text.slice(0, 50) || `[${mediaType}]`}`);

    const reply = async (content) => enqueueWA(() => {
        try { return sendTypingAndMessage(jid, content, { quoted: msg }); } catch(e){}
    });

    const rawNum = jid.replace(/\D/g, '');

    // ==========================================
    // ПРИВАТНОСТЬ И АУДИТОРИЯ (Черные списки)
    // ==========================================
    if (db.isBlacklist(rawNum)) {
        db.log(`🚫 ${pushName} в Черном списке. Игнорируем.`);
        return; // Полный игнор, даже не пересылаем в ТГ
    }

    // ==========================================
    // 2. БАЗОВЫЕ КОМАНДЫ (Работают и в группах)
    // ==========================================
    if (textLow === '!ping') { return reply({ text: '🤖 *Pong!* Жүйе жұмыс істеп тұр.' }); }
    if (textLow === '!id') { return reply({ text: `🔑 Сіздің WA ID:\n\`${jid}\`` }); }
    if (textLow === '!анализ') { return reply({ text: '🩺 *Еске салу:* Қанды және HbA1c мерзімді тексеруді ұмытпа!' }); }
    if (textLow === '!үй' || textLow === '!дом' || textLow === '!home') { return reply({ text: '🏠 *VECTOR Smart Home*\n✅ Барлық жүйелер қалыпты.' }); }
    if (textLow === '!ауа' || textLow === '!погода') { return reply({ text: '🌤️ Ауа райы әзірге қолжетімді емес.' }); }

    if (textLow.startsWith('!тамақ') || textLow.startsWith('!еда')) {
        const carbs = parseInt(textLow.replace(/[^\d]/g, ''), 10);
        if (!isNaN(carbs) && carbs > 0) {
            const insulin = (carbs / 10).toFixed(1);
            return reply({ text: `🍽️ *Инсулин калькуляторы:*\nКөмірсулар: *${carbs}г*\n💉 Инсулин: *${insulin} бірлік*\n_Дәрігермен ақылдасыңыз!_` });
        }
        return reply({ text: '⚠️ Формат: `!тамақ 60` (көмірсу граммы)' });
    }

    // ==========================================
    // 3. УМНЫЕ АВТООТВЕТЫ (Только личные сообщения)
    // ==========================================
    if (!isGroup(jid)) {
        db.trackContact(jid, pushName, mediaType ? `[${mediaType}]` : text);

        let autoReplied = false;
        
        // Индивидуальные настройки для человека
        const customReply = db.getCustomReply(jid);
        const personalPrompt = db.getCustomPrompt(jid);
        const hasPersonalRule = !!(customReply || personalPrompt);
        
        // Разрешен ли автоответ в принципе по политике аудитории?
        const isWhitelisted = db.isWhitelist(rawNum);
        const audienceMode = db.getAudienceMode(); // 'all', 'contacts_only', 'unknown_only', 'whitelist_only', 'none'
        const isContact = db.isRealContact(rawNum);
        let canTalk = true;
        
        if (hasPersonalRule) {
            canTalk = true; // Личные правила и кастомные автоответы работают всегда (если абонент не в ЧС)
        } else if (audienceMode === 'whitelist_only') {
            canTalk = isWhitelisted;
        } else if (audienceMode === 'contacts_only') {
            canTalk = isContact || isWhitelisted;
        } else if (audienceMode === 'unknown_only') {
            canTalk = !isContact || isWhitelisted;
        } else if (audienceMode === 'none') {
            canTalk = false;
        }

        if (!canTalk) {
            db.log(`🤫 Режим тишины (${audienceMode}): игнорируем +${rawNum}`);
        }

        // --- КАСКАД ПРИОРИТЕТОВ ---
        if (!canTalk || !canAutoReply(jid)) { 
            // 0. Если нельзя говорить по аудитории или кулдауну -> молчим
        } 
        else if (customReply) {
            // ПРИОРИТЕТ 1: Кастомный ответ (жесткий текст или зависящий от времени суток)
            await reply({ text: customReply });
            autoReplied = true;
            db.incStat('custom_replies');
        } 
        else if (settings.aiEnabled && !mediaType && text) {
            // ПРИОРИТЕТ 2: Нейросеть (Сначала личный промпт, если нет - глобальный)
            const activePrompt = personalPrompt || settings.globalAIPrompt || null;
            
            if (activePrompt) {
                const aiText = await generateAIResponse(text, pushName, activePrompt);
                if (aiText) {
                    await reply({ text: `🤖 ${aiText}` });
                    autoReplied = true;
                } else if (settings.autoReplyUrgent) {
                    // ИИ упал (ошибка сети) -> фолбек на обычный автоответ
                    await reply({ text: settings.defaultAutoReply });
                    autoReplied = true;
                    db.incStat('auto_replies');
                }
            } else if (settings.autoReplyUrgent) {
                // ИИ включен, но правила (промпта) нет -> обычный автоответ
                await reply({ text: settings.defaultAutoReply });
                autoReplied = true;
                db.incStat('auto_replies');
            }
        } 
        else if (settings.autoReplyUrgent) {
            // ПРИОРИТЕТ 3: Базовый ответ (если ИИ выключен или прислали фото/голосовое)
            await reply({ text: settings.defaultAutoReply });
            autoReplied = true;
            db.incStat('auto_replies');
        }

        // ==========================================
        // 4. ПЕРЕСЫЛКА В ТЕЛЕГРАМ
        // ==========================================
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