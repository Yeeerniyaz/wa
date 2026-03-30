import { default as makeWASocket, useMultiFileAuthState, fetchLatestBaileysVersion, DisconnectReason, downloadMediaMessage } from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import Pino from 'pino';
import qrcode from 'qrcode-terminal';
import fs from 'fs';
import os from 'os';
import TelegramBot from 'node-telegram-bot-api';

// ============================================================
// 1. КОНФИГУРАЦИЯ
// ============================================================
const TG_TOKEN = process.env.TG_TOKEN;
const TG_CHAT_ID = process.env.TG_CHAT_ID;
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;

if (!TG_TOKEN || !TG_CHAT_ID) {
    console.error('❌ КРИТИЧНО: TG_TOKEN и TG_CHAT_ID обязательны в .env');
    process.exit(1);
}

const tgBot = new TelegramBot(TG_TOKEN, { polling: true });

// Тихий логгер — Baileys очень многословен без этого
const logger = Pino({ level: 'silent' });

// ============================================================
// 2. БАЗА ДАННЫХ (IN-MEMORY + ПЕРИОДИЧЕСКАЯ ЗАПИСЬ НА ДИСК)
// ============================================================
const DEFAULT_SETTINGS = {
    alwaysOnline: true,
    autoReplyUrgent: true,
    forwardMedia: true,
    aiEnabled: false,
    defaultAutoReply: 'Ернияз қазір бос емес. Кейінірек жазады.',
    antiSpam: true,
    antiSpamCooldown: 60,
};

class LocalDB {
    constructor(filePath) {
        this.file = filePath;
        this.data = this._init();
        this._dirty = false;

        setInterval(() => { if (this._dirty) { this._saveToDisk(); this._dirty = false; } }, 120_000);
        process.on('SIGINT', () => { this._saveToDisk(); process.exit(); });
        process.on('SIGTERM', () => { this._saveToDisk(); process.exit(); });
    }

    _init() {
        const defaultData = () => ({
            logs: [], customReplies: {}, customAIPrompts: {},
            stats: {}, contacts: {}, settings: { ...DEFAULT_SETTINGS }
        });

        if (!fs.existsSync(this.file)) {
            const d = defaultData();
            fs.writeFileSync(this.file, JSON.stringify(d, null, 2));
            console.log('📁 database.json создан с нуля.');
            return d;
        }

        try {
            const raw = fs.readFileSync(this.file, 'utf8').trim();
            if (!raw) throw new Error('Пустой файл');
            const d = JSON.parse(raw);
            // Миграция: дополняем недостающие поля
            d.settings = { ...DEFAULT_SETTINGS, ...d.settings };
            d.customReplies = d.customReplies || {};
            d.customAIPrompts = d.customAIPrompts || {};
            d.stats = d.stats || {};
            d.contacts = d.contacts || {};
            return d;
        } catch (err) {
            console.error(`⚠️ database.json повреждён (${err.message}). Пересоздаём...`);
            // Резервная копия битого файла
            const backup = this.file + '.bak.' + Date.now();
            try { fs.renameSync(this.file, backup); } catch (_) { }
            const d = defaultData();
            fs.writeFileSync(this.file, JSON.stringify(d, null, 2));
            return d;
        }
    }

    _saveToDisk() {
        fs.writeFile(this.file, JSON.stringify(this.data, null, 2), err => {
            if (err) console.error('❌ Ошибка записи БД:', err.message);
        });
    }

    forceSave() { this._dirty = true; this._saveToDisk(); this._dirty = false; }

    log(msg) {
        const time = new Date().toLocaleString('ru-RU', { timeZone: 'Asia/Almaty' });
        const line = `[${time}] ${msg}`;
        console.log(line);
        this.data.logs.push(line);
        if (this.data.logs.length > 1000) this.data.logs.splice(0, this.data.logs.length - 1000);
        fs.appendFile('bot.log', line + '\n', () => { });
        this._dirty = true;
    }

    getSettings() { return this.data.settings; }
    toggleSetting(k) { this.data.settings[k] = !this.data.settings[k]; this._dirty = true; return this.data.settings; }
    setSetting(k, v) { this.data.settings[k] = v; this._dirty = true; }

    setCustomReply(n, t) { this.data.customReplies[n] = t; this._dirty = true; }
    deleteCustomReply(n) { delete this.data.customReplies[n]; this._dirty = true; }
    getCustomReply(jid) { return this.data.customReplies[toNum(jid)] || null; }

    setCustomPrompt(n, t) { this.data.customAIPrompts[n] = t; this._dirty = true; }
    deleteCustomPrompt(n) { delete this.data.customAIPrompts[n]; this._dirty = true; }
    getCustomPrompt(jid) { return this.data.customAIPrompts[toNum(jid)] || null; }

    incStat(key) { this.data.stats[key] = (this.data.stats[key] || 0) + 1; this._dirty = true; }
    getStats() { return this.data.stats; }

    trackContact(jid, name, lastMsg) {
        const num = toNum(jid);
        const now = new Date().toLocaleString('ru-RU', { timeZone: 'Asia/Almaty' });
        if (!this.data.contacts[num]) {
            this.data.contacts[num] = { name, count: 0, firstSeen: now, lastSeen: now, lastMsg: '' };
        }
        const c = this.data.contacts[num];
        c.count++;
        c.lastSeen = now;
        c.lastMsg = lastMsg ? lastMsg.slice(0, 100) : '';
        if (name && name !== num) c.name = name;
        this._dirty = true;
    }
    getContact(num) { return this.data.contacts[num.replace(/\D/g, '')] || null; }
    getAllContacts() { return this.data.contacts; }

    listCustomReplies() { return this.data.customReplies; }
    listCustomPrompts() { return this.data.customAIPrompts; }
}

const db = new LocalDB('./database.json');

// ============================================================
// 3. ХЕЛПЕРЫ JID
// ============================================================
// Baileys использует @s.whatsapp.net (личные) и @g.us (группы)
const toWAJid = (num) => `${num.replace(/\D/g, '')}@s.whatsapp.net`;
const toNum = (jid) => (jid || '').replace(/@.+$/, '');
const isGroup = (jid) => (jid || '').includes('@g.us');

// Извлечение текста из Baileys-сообщения
function getMsgText(msg) {
    const m = msg.message;
    if (!m) return '';
    return (
        m.conversation ||
        m.extendedTextMessage?.text ||
        m.imageMessage?.caption ||
        m.videoMessage?.caption ||
        m.documentMessage?.caption ||
        m.buttonsResponseMessage?.selectedDisplayText ||
        m.listResponseMessage?.title ||
        ''
    );
}

// Тип медиа (включая однократный просмотр)
function getMsgMediaType(msg) {
    const m = msg.message;
    if (!m) return null;

    // Однократный просмотр — особый случай, не скачиваем
    if (m.viewOnceMessage || m.viewOnceMessageV2) return 'viewonce';

    if (m.imageMessage) return 'image';
    if (m.videoMessage) return 'video';
    if (m.audioMessage || m.voiceMessage) return 'audio';
    if (m.stickerMessage) return 'sticker';
    if (m.documentMessage) return 'document';
    return null;
}

// ============================================================
// 4. ANTI-SPAM
// ============================================================
const repliedRecently = new Map();

function canAutoReply(jid) {
    const s = db.getSettings();
    if (!s.antiSpam) return true;
    const last = repliedRecently.get(jid) || 0;
    if (Date.now() - last < (s.antiSpamCooldown || 60) * 1000) return false;
    repliedRecently.set(jid, Date.now());
    return true;
}

// ============================================================
// 5. ОЧЕРЕДЬ ИСХОДЯЩИХ WA (анти-бан rate limit)
// ============================================================
const waQueue = [];
let queueRunning = false;

async function enqueueWA(fn) {
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

// ============================================================
// 6. WA-СОКЕТ (Baileys) — создаётся при каждом подключении
// ============================================================
let sock = null;

async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState('./auth_info');
    const { version } = await fetchLatestBaileysVersion();

    sock = makeWASocket({
        version,
        auth: state,
        logger,
        browser: ['WA-Bot', 'Chrome', '121.0.0'],
        syncFullHistory: false,
        markOnlineOnConnect: db.getSettings().alwaysOnline,
    });

    // Сохраняем учётные данные при каждом обновлении
    sock.ev.on('creds.update', saveCreds);

    // Состояние подключения
    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            qrcode.generate(qr, { small: true }); // показываем в терминале
            db.log('⏳ QR-код готов. Сканируй в WhatsApp!');
            await sendToTelegram('📱 *WA QR-код обновлён!* Сканируй в приложении (Settings → Linked Devices).');
        }

        if (connection === 'open') {
            db.log('🚀 WhatsApp подключён (Baileys)!');
            await sendToTelegram('🚀 *WhatsApp подключён!*\nBaileys • без браузера • RAM: ~50MB');

            // Поддержка онлайн-статуса
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
                await sendToTelegram('🔑 *WA: Требуется повторная авторизация!* Удали папку `auth_info` и перезапусти бота.');
                db.log('❌ Выход из аккаунта. Перезапуск невозможен без нового QR.');
            } else {
                await sendToTelegram(`⚠️ *WA отключился!* Переподключение через 5 сек...`);
                setTimeout(connectToWhatsApp, 5_000);
            }
        }
    });

    // ============================================================
    // 7. ВХОДЯЩИЕ СООБЩЕНИЯ
    // ============================================================
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;

        for (const msg of messages) {
            try {
                await handleMessage(msg);
            } catch (err) {
                db.log(`❌ Ошибка обработки сообщения: ${err.message}`);
            }
        }
    });
}

// ============================================================
// 8. ОБРАБОТЧИК ВХОДЯЩИХ WA-СООБЩЕНИЙ
// ============================================================
async function handleMessage(msg) {
    if (!msg.message) return;
    if (msg.key.fromMe) return;

    const jid = msg.key.remoteJid;

    // Фильтруем broadcast и статусы
    if (!jid) return;
    if (jid === 'status@broadcast') return;
    if (jid.endsWith('@broadcast')) return;

    const text = getMsgText(msg);
    const textLow = text.toLowerCase();
    const mediaType = getMsgMediaType(msg);
    const settings = db.getSettings();
    const pushName = msg.pushName || toNum(jid);

    db.incStat('messages_received');
    db.log(`📨 ${isGroup(jid) ? '[Группа]' : '[Личка]'} ${pushName}: ${text.slice(0, 50) || `[${mediaType}]`}`);

    // Хелпер для ответа в WA
    const reply = (content) => enqueueWA(() => sock.sendMessage(jid, content, { quoted: msg }));

    // ---- КОМАНДЫ (работают и в личке, и в группах) ----

    if (textLow === '!ping') {
        await reply({ text: '🤖 *Pong!* Жүйе жұмыс істеп тұр.' });
        return;
    }

    if (textLow === '!help') {
        await reply({
            text:
                '🤖 *Бот командалары:*\n' +
                '`!ping` — тексеру\n' +
                '`!ескерт [мин] [мәтін]` — еске салу\n' +
                '`!тамақ [г]` — инсулин есептеу\n' +
                '`!анализ` — қан тапсыру ескертуі\n' +
                '`!үй` — смарт үй күйі\n' +
                '`!ауа` — ауа райы\n' +
                '`!id` — сіздің WA ID'
        });
        return;
    }

    if (textLow === '!id') {
        await reply({ text: `🔑 Сіздің WA ID:\n\`${jid}\`` });
        return;
    }

    // Еске салу
    if (textLow.startsWith('!ескерт ') || textLow.startsWith('!напомни ')) {
        const parts = text.split(' ');
        const minutes = parseInt(parts[1], 10);
        const remind = parts.slice(2).join(' ');
        if (!isNaN(minutes) && minutes > 0 && remind) {
            await reply({ text: `⏳ *${minutes}* минуттан кейін ескертемін.` });
            setTimeout(async () => {
                try { await enqueueWA(() => sock.sendMessage(jid, { text: `⏰ *ЕСКЕ САЛУ:*\n${remind}` }, { quoted: msg })); } catch (_) { }
            }, minutes * 60_000);
        } else {
            await reply({ text: '⚠️ Формат: `!ескерт 15 сүт алу`' });
        }
        return;
    }

    // Инсулин калькуляторы
    if (textLow.startsWith('!тамақ') || textLow.startsWith('!еда')) {
        const carbs = parseInt(textLow.replace(/[^\d]/g, ''), 10);
        if (!isNaN(carbs) && carbs > 0) {
            const insulin = (carbs / 10).toFixed(1);
            await reply({
                text:
                    `🍽️ *Инсулин калькуляторы:*\n` +
                    `Көмірсулар: *${carbs}г*\n` +
                    `💉 Инсулин: *${insulin} бірлік*\n` +
                    `_Дәрігермен ақылдасыңыз!_`
            });
        } else {
            await reply({ text: '⚠️ Формат: `!тамақ 60` (көмірсу граммы)' });
        }
        return;
    }

    if (textLow === '!анализ') {
        await reply({ text: '🩺 *Еске салу:* Қанды және HbA1c мерзімді тексеруді ұмытпа!' });
        return;
    }

    if (textLow === '!үй' || textLow === '!дом' || textLow === '!home') {
        await reply({ text: '🏠 *VECTOR Smart Home*\n✅ Барлық жүйелер қалыпты.' });
        return;
    }

    if (textLow === '!ауа' || textLow === '!погода') {
        await reply({ text: '🌤️ Ауа райы әзірге қолжетімді емес. OpenWeather API қос.' });
        return;
    }

    // ---- ЛИЧНЫЕ СООБЩЕНИЯ: автоответы + форвард в TG ----
    if (!isGroup(jid)) {
        // Трекинг
        db.trackContact(jid, pushName, mediaType ? `[${mediaType}]` : text);

        let autoReplied = false;

        if (!canAutoReply(jid)) {
            // Кулдаун не вышел — не отвечаем
        }
        // Приоритет 1: Фиксированный кастомный ответ
        else if (db.getCustomReply(jid)) {
            await enqueueWA(() => sock.sendMessage(jid, { text: db.getCustomReply(jid) }, { quoted: msg }));
            autoReplied = true;
            db.log(`🎯 Кастомный ответ → ${pushName}`);
            db.incStat('custom_replies');
        }
        // Приоритет 2: AI-ответ (если включён)
        else if (settings.aiEnabled && !mediaType && text) {
            const aiText = await generateAIResponse(text, pushName, jid);
            if (aiText) {
                await enqueueWA(() => sock.sendMessage(jid, { text: `🤖 ${aiText}` }, { quoted: msg }));
                autoReplied = true;
                db.log(`🤖 AI ответил → ${pushName}`);
            } else if (settings.autoReplyUrgent) {
                // AI вернул null — фолбэк на базовый ответ
                await enqueueWA(() => sock.sendMessage(jid, { text: settings.defaultAutoReply }, { quoted: msg }));
                autoReplied = true;
                db.log(`💬 AI сбой → базовый ответ → ${pushName}`);
                db.incStat('auto_replies');
            }
        }
        // Приоритет 3: Базовый авто-ответ на ЛЮБОЕ сообщение
        else if (settings.autoReplyUrgent) {
            await enqueueWA(() => sock.sendMessage(jid, { text: settings.defaultAutoReply }, { quoted: msg }));
            autoReplied = true;
            db.log(`💬 Базовый авто-ответ → ${pushName}`);
            db.incStat('auto_replies');
        }

        // ---- Пересылка в Telegram ----
        let tgText = `💬 *От:* ${pushName} \`(${jid})\`\n`;
        if (autoReplied) tgText += `🤖 _(Ответ отправлен)_\n`;
        tgText += '\n';

        // 🔒 Однократный просмотр — скачать невозможно, только уведомляем
        if (mediaType === 'viewonce') {
            tgText += `🔒 _[Медиа однократного просмотра — скачать нельзя]_`;
            tgText += `\n\n---\n\`WA_ID: ${jid}\`\n_↩️ Ответь на это сообщение_`;
            await sendToTelegram(tgText);
            return;
        }

        if (mediaType && settings.forwardMedia) {
            try {
                const buffer = await downloadMediaMessage(msg, 'buffer', {}, { logger, reuploadRequest: sock.updateMediaMessage });
                const caption = `${tgText}📎 _[${mediaType}]_\n${text || ''}\n\n\`WA_ID: ${jid}\`\n_↩️ Ответь на это сообщение_`;

                if (mediaType === 'image') await tgBot.sendPhoto(TG_CHAT_ID, buffer, { caption, parse_mode: 'Markdown' });
                else if (mediaType === 'video') await tgBot.sendVideo(TG_CHAT_ID, buffer, { caption, parse_mode: 'Markdown' });
                else if (mediaType === 'audio') await tgBot.sendVoice(TG_CHAT_ID, buffer, { caption, parse_mode: 'Markdown' });
                else if (mediaType === 'sticker') await tgBot.sendSticker(TG_CHAT_ID, buffer);
                else await tgBot.sendDocument(TG_CHAT_ID, buffer, { caption, parse_mode: 'Markdown' });

                db.incStat('media_forwarded');
                return;
            } catch (e) {
                tgText += `📎 _[${mediaType}: ошибка загрузки — ${e.message.slice(0, 60)}]_\n`;
                db.log(`❌ Ошибка скачивания медиа: ${e.message}`);
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

// ============================================================
// 9. AI-ГЕНЕРАТОР ОТВЕТОВ (OpenRouter: Llama 3 / Gemini)
// ============================================================
const aiConversations = new Map(); // jid → [{role, content}[]]

async function generateAIResponse(messageText, senderName, jid) {
    if (!OPENROUTER_API_KEY) return null;
    try {
        const customPrompt = db.getCustomPrompt(jid);
        const sysInstruction = customPrompt
            ? `Сен Ернияздың виртуалды көмекшісісің. "${senderName}" үшін арнайы ереже: "${customPrompt}". Осыған қатаң бағын.`
            : `Сен Ернияздың виртуалды көмекшісісің. Ол қазір бос емес. Жауапты қысқа, мазмұнды, жеңіл әзілмен жаз. Адам қазақша жазса — қазақша, орысша — орысша, ағылшынша — ағылшынша.`;

        if (!aiConversations.has(jid)) {
            aiConversations.set(jid, [{ role: 'system', content: sysInstruction }]);
        }

        const history = aiConversations.get(jid);
        // Обновляем системный промпт (он всегда первый)
        history[0].content = sysInstruction;

        history.push({ role: 'user', content: messageText });

        const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
                'Content-Type': 'application/json',
                'HTTP-Referer': 'https://github.com/Yeeerniyaz/wa',
                'X-Title': 'WhatsApp Bot'
            },
            body: JSON.stringify({
                model: 'meta-llama/llama-3.3-70b-instruct:free', // Самая мощная открытая модель (бесплатная)
                messages: history,
                temperature: 0.7,
                max_tokens: 1024,
            })
        });

        if (!response.ok) {
            const errData = await response.text();
            throw new Error(`OpenRouter API error: ${response.status} - ${errData}`);
        }

        const data = await response.json();
        const aiText = data.choices[0]?.message?.content || 'Кешіріңіз, түсінбедім.';

        history.push({ role: 'assistant', content: aiText });

        // Ограничиваем историю (оставляем system + последние 14 сообщений = 7 обменов)
        if (history.length > 15) {
            history.splice(1, history.length - 15);
        }

        db.incStat('ai_replies');
        return aiText;
    } catch (e) {
        db.log(`❌ AI ошибка (OpenRouter): ${e.message}`);
        return null;
    }
}

// ============================================================
// 10. TELEGRAM → WHATSAPP МОСТ
// ============================================================
const sendToTelegram = async (text, extra = {}) => {
    try {
        await tgBot.sendMessage(TG_CHAT_ID, text, { parse_mode: 'Markdown', ...extra });
    } catch (err) {
        console.error('❌ TG ошибка:', err.message);
    }
};

const getSettingsKeyboard = (s) => ({
    reply_markup: {
        inline_keyboard: [
            [
                { text: `${s.alwaysOnline ? '🟢' : '⚫'} Онлайн`, callback_data: 'toggle_alwaysOnline' },
                { text: `${s.aiEnabled ? '🤖' : '⚫'} AI-Ответы`, callback_data: 'toggle_aiEnabled' },
            ],
            [
                { text: `${s.autoReplyUrgent ? '🚨' : '⚫'} Автоответ`, callback_data: 'toggle_autoReplyUrgent' },
                { text: `${s.forwardMedia ? '🖼️' : '⚫'} Медиа`, callback_data: 'toggle_forwardMedia' },
            ],
            [
                { text: `${s.antiSpam ? '🛡️' : '⚫'} Антиспам`, callback_data: 'toggle_antiSpam' },
                { text: '📊 Статус', callback_data: 'sys_status' },
            ],
            [
                { text: '📋 Кастомные ответы', callback_data: 'list_replies' },
                { text: '🧠 AI-промпты', callback_data: 'list_prompts' },
            ],
            [
                { text: '📈 Статистика', callback_data: 'show_stats' },
                { text: '📜 Логи (30)', callback_data: 'show_logs' },
            ],
        ],
    },
});

// ============================================================
// 11. TELEGRAM КОМАНДЫ
// ============================================================
tgBot.on('message', async (tgMsg) => {
    if (tgMsg.chat.id.toString() !== TG_CHAT_ID) return;
    const text = tgMsg.text || '';
    const settings = db.getSettings();

    if (text === '/start' || text === '/menu') {
        const helpText =
            `⚙️ *Управление WA-Ботом*\n\n` +
            `*📤 Отправить:*\n\`/send 77012345678 текст\`\n\n` +
            `*📌 Кастомные ответы:*\n\`/setreply 77012345678 текст\`\n\`/delreply 77012345678\`\n\n` +
            `*🧠 AI-инструкции:*\n\`/setprompt 77012345678 инструкция\`\n\`/delprompt 77012345678\`\n\n` +
            `*💬 Базовый автоответ:*\n\`/setdefault текст\`\n\n` +
            `*⏱️ Антиспам:*\n\`/setcooldown 60\`\n\n` +
            `*🗑️ Сбросить AI:*\n\`/resetai 77012345678\`\n\n` +
            `*👤 Статистика:*\n\`/stat 77012345678\`\n\`/top\` — топ-10`;
        await tgBot.sendMessage(TG_CHAT_ID, helpText, { parse_mode: 'Markdown', ...getSettingsKeyboard(settings) });
        return;
    }

    if (text.startsWith('/setdefault ')) {
        db.setSetting('defaultAutoReply', text.slice('/setdefault '.length));
        db.forceSave();
        await sendToTelegram('✅ Базовый автоответ обновлён.');
        return;
    }

    if (text.startsWith('/setreply ')) {
        const m = text.match(/^\/setreply\s+(\d+)\s+(.+)$/s);
        if (m) { db.setCustomReply(m[1], m[2]); db.forceSave(); await sendToTelegram(`✅ Ответ для *+${m[1]}* установлен.`); }
        else { await sendToTelegram('⚠️ Формат: `/setreply 77012345678 текст`'); }
        return;
    }

    if (text.startsWith('/delreply ')) {
        db.deleteCustomReply(text.slice('/delreply '.length).trim());
        db.forceSave();
        await sendToTelegram('🗑 Ответ удалён.');
        return;
    }

    if (text.startsWith('/setprompt ')) {
        const m = text.match(/^\/setprompt\s+(\d+)\s+(.+)$/s);
        if (m) {
            db.setCustomPrompt(m[1], m[2]);
            db.forceSave();
            aiConversations.delete(toWAJid(m[1]));
            await sendToTelegram(`🧠 AI-инструкция для *+${m[1]}* сохранена:\n_${m[2]}_`);
        } else {
            await sendToTelegram('⚠️ Формат: `/setprompt 77012345678 Отвечай по-казахски`');
        }
        return;
    }

    if (text.startsWith('/delprompt ')) {
        const num = text.slice('/delprompt '.length).trim();
        db.deleteCustomPrompt(num);
        db.forceSave();
        aiConversations.delete(toWAJid(num));
        await sendToTelegram(`🗑 AI-инструкция для *+${num}* удалена.`);
        return;
    }

    if (text.startsWith('/setcooldown ')) {
        const secs = parseInt(text.slice('/setcooldown '.length).trim(), 10);
        if (!isNaN(secs) && secs >= 0) {
            db.setSetting('antiSpamCooldown', secs);
            db.forceSave();
            await sendToTelegram(`✅ Кулдаун антиспама: *${secs} сек*`);
        }
        return;
    }

    if (text.startsWith('/resetai ')) {
        const num = text.slice('/resetai '.length).trim();
        aiConversations.delete(toWAJid(num));
        await sendToTelegram(`🔄 История AI для *+${num}* сброшена.`);
        return;
    }

    if (text.startsWith('/stat ')) {
        const num = text.slice('/stat '.length).trim().replace(/\D/g, '');
        const c = db.getContact(num);
        if (!c) {
            await sendToTelegram(`❓ Контакт *+${num}* не найден.`);
        } else {
            const hasReply = db.getCustomReply(toWAJid(num)) ? '✅ есть' : '❌ нет';
            const hasPrompt = db.getCustomPrompt(toWAJid(num)) ? '✅ есть' : '❌ нет';
            await sendToTelegram(
                `👤 *Статистика +${num}*\n` +
                `📛 Имя: ${c.name || '—'}\n` +
                `📨 Сообщений: *${c.count}*\n` +
                `🕐 Первый раз: ${c.firstSeen}\n` +
                `🕑 Последний раз: ${c.lastSeen}\n` +
                `💬 Последнее:\n_${c.lastMsg || '—'}_\n\n` +
                `📌 Кастомный ответ: ${hasReply}\n` +
                `🧠 AI-инструкция: ${hasPrompt}`
            );
        }
        return;
    }

    if (text === '/top') {
        const contacts = db.getAllContacts();
        const sorted = Object.entries(contacts).sort(([, a], [, b]) => b.count - a.count).slice(0, 10);
        if (sorted.length === 0) {
            await sendToTelegram('📭 Пока нет данных.');
        } else {
            const lines = sorted.map(([num, c], i) =>
                `${i + 1}. *${c.name || '+' + num}* — ${c.count} сообщ.\n   _${c.lastSeen}_`
            );
            await sendToTelegram(`📊 *Топ-${sorted.length} контактов:*\n\n` + lines.join('\n\n'));
        }
        return;
    }

    if (text.startsWith('/send ')) {
        const m = text.match(/^\/send\s+(\d+)\s+(.+)$/s);
        if (m) {
            try {
                await enqueueWA(() => sock.sendMessage(toWAJid(m[1]), { text: m[2] }));
                await sendToTelegram(`✅ Отправлено на *+${m[1]}*`);
                db.incStat('manual_sends');
            } catch (e) {
                await sendToTelegram(`❌ Ошибка: ${e.message}`);
            }
        }
        return;
    }

    // ---- Мост TG → WA (ответ на форвардное сообщение) ----
    if (tgMsg.reply_to_message) {
        const refText = tgMsg.reply_to_message.text || tgMsg.reply_to_message.caption || '';
        const waMatch = refText.match(/WA_ID:\s*([0-9]+@s\.whatsapp\.net)/);
        if (waMatch) {
            const waJid = waMatch[1];
            try {
                if (tgMsg.photo) {
                    const fileId = tgMsg.photo[tgMsg.photo.length - 1].file_id;
                    const fileLink = await tgBot.getFileLink(fileId);
                    const res = await fetch(fileLink);
                    const buffer = Buffer.from(await res.arrayBuffer());
                    await enqueueWA(() => sock.sendMessage(waJid, { image: buffer, caption: tgMsg.caption || '' }));
                } else if (tgMsg.video) {
                    const fileLink = await tgBot.getFileLink(tgMsg.video.file_id);
                    const res = await fetch(fileLink);
                    const buffer = Buffer.from(await res.arrayBuffer());
                    await enqueueWA(() => sock.sendMessage(waJid, { video: buffer, caption: tgMsg.caption || '' }));
                } else if (tgMsg.document) {
                    const fileLink = await tgBot.getFileLink(tgMsg.document.file_id);
                    const res = await fetch(fileLink);
                    const buffer = Buffer.from(await res.arrayBuffer());
                    await enqueueWA(() => sock.sendMessage(waJid, { document: buffer, mimetype: tgMsg.document.mime_type, fileName: tgMsg.document.file_name || 'file' }));
                } else if (tgMsg.voice || tgMsg.audio) {
                    const fileId = (tgMsg.voice || tgMsg.audio).file_id;
                    const fileLink = await tgBot.getFileLink(fileId);
                    const res = await fetch(fileLink);
                    const buffer = Buffer.from(await res.arrayBuffer());
                    await enqueueWA(() => sock.sendMessage(waJid, { audio: buffer, mimetype: 'audio/ogg; codecs=opus', ptt: true }));
                } else if (tgMsg.text) {
                    await enqueueWA(() => sock.sendMessage(waJid, { text: tgMsg.text }));
                }
                await tgBot.sendMessage(TG_CHAT_ID, '✅ Доставлено в WA', { reply_to_message_id: tgMsg.message_id });
                db.incStat('bridge_sends');
            } catch (err) {
                await tgBot.sendMessage(TG_CHAT_ID, `❌ Ошибка моста: ${err.message}`, { reply_to_message_id: tgMsg.message_id });
            }
        }
    }
});

// ============================================================
// 12. TELEGRAM CALLBACK (кнопки)
// ============================================================
tgBot.on('callback_query', async (query) => {
    if (query.message.chat.id.toString() !== TG_CHAT_ID) return;
    const action = query.data;

    if (action.startsWith('toggle_')) {
        const key = action.replace('toggle_', '');
        if (key === 'aiEnabled' && !OPENROUTER_API_KEY) {
            await tgBot.answerCallbackQuery(query.id, { text: '❌ Нет OPENROUTER_API_KEY в .env', show_alert: true });
            return;
        }
        const s = db.toggleSetting(key);
        db.forceSave();
        await tgBot.editMessageReplyMarkup(getSettingsKeyboard(s).reply_markup, {
            chat_id: query.message.chat.id, message_id: query.message.message_id,
        });
        await tgBot.answerCallbackQuery(query.id, { text: '✅ Обновлено' });
    }

    else if (action === 'sys_status') {
        const freeRAM = Math.round(os.freemem() / 1024 / 1024);
        const totalRAM = Math.round(os.totalmem() / 1024 / 1024);
        const scriptRAM = Math.round(process.memoryUsage().rss / 1024 / 1024);
        const heapUsed = Math.round(process.memoryUsage().heapUsed / 1024 / 1024);
        const uptime = process.uptime();
        const uptimeStr = `${Math.floor(uptime / 3600)}ч ${Math.floor((uptime % 3600) / 60)}м`;
        const stats = [
            `💻 *Статус (Baileys)*`,
            `🧠 RAM хоста: ${freeRAM}MB / ${totalRAM}MB`,
            `📦 RAM скрипта: ${scriptRAM}MB (heap: ${heapUsed}MB)`,
            `🔥 CPU: ${os.loadavg()[0].toFixed(2)}`,
            `⏱ Uptime: ${uptimeStr}`,
            `📬 Очередь: ${waQueue.length} msg`,
        ].join('\n');
        await tgBot.answerCallbackQuery(query.id, { text: stats, show_alert: true });
    }

    else if (action === 'list_replies') {
        const r = db.listCustomReplies();
        const keys = Object.keys(r);
        if (!keys.length) { await tgBot.answerCallbackQuery(query.id, { text: 'Нет кастомных ответов', show_alert: true }); }
        else { await sendToTelegram('📋 *Кастомные ответы:*\n' + keys.map(k => `+${k}: _${r[k].slice(0, 40)}_`).join('\n')); await tgBot.answerCallbackQuery(query.id); }
    }

    else if (action === 'list_prompts') {
        const p = db.listCustomPrompts();
        const keys = Object.keys(p);
        if (!keys.length) { await tgBot.answerCallbackQuery(query.id, { text: 'Нет AI-инструкций', show_alert: true }); }
        else { await sendToTelegram('🧠 *AI-инструкции:*\n' + keys.map(k => `+${k}: _${p[k].slice(0, 60)}_`).join('\n')); await tgBot.answerCallbackQuery(query.id); }
    }

    else if (action === 'show_stats') {
        const s = db.getStats();
        const txt = '📈 *Статистика:*\n' + (Object.keys(s).length
            ? Object.entries(s).map(([k, v]) => `• ${k}: *${v}*`).join('\n')
            : '_Нет данных_');
        await tgBot.answerCallbackQuery(query.id, { text: txt.slice(0, 200), show_alert: true });
    }

    else if (action === 'show_logs') {
        const logs = db.data.logs.slice(-30).join('\n');
        await sendToTelegram(`\`\`\`\n${logs.slice(0, 3900)}\n\`\`\``);
        await tgBot.answerCallbackQuery(query.id);
    }
});

// ============================================================
// 13. ГЛОБАЛЬНАЯ ОБРАБОТКА ОШИБОК
// ============================================================
process.on('unhandledRejection', (reason) => {
    const msg = reason instanceof Error ? reason.message : String(reason);
    db.log(`⚠️ UnhandledRejection: ${msg}`);
});

process.on('uncaughtException', (err) => {
    db.log(`🔥 UncaughtException: ${err.message}`);
    sendToTelegram(`🔥 *Критическая ошибка:*\n\`${err.message}\``);
    setTimeout(() => process.exit(1), 2000);
});

// ============================================================
// 14. СТАРТ
// ============================================================
db.log('🟡 Бот запускается (Baileys)...');
connectToWhatsApp();