import wwebjs from 'whatsapp-web.js';
const { Client, LocalAuth, MessageMedia } = wwebjs;
import qrcode from 'qrcode-terminal';
import fs from 'fs';
import os from 'os';
import path from 'path';
import TelegramBot from 'node-telegram-bot-api';
import { GoogleGenerativeAI } from '@google/generative-ai';

// ============================================================
// 1. КОНФИГУРАЦИЯ
// ============================================================
const TG_TOKEN       = process.env.TG_TOKEN;
const TG_CHAT_ID     = process.env.TG_CHAT_ID;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

if (!TG_TOKEN || !TG_CHAT_ID) {
    console.error('❌ КРИТИЧНО: TG_TOKEN и TG_CHAT_ID обязательны в .env');
    process.exit(1);
}

const tgBot = new TelegramBot(TG_TOKEN, { polling: true });
const genAI = GEMINI_API_KEY ? new GoogleGenerativeAI(GEMINI_API_KEY) : null;

// ============================================================
// 2. БАЗА ДАННЫХ (IN-MEMORY + ПЕРИОДИЧЕСКАЯ ЗАПИСЬ НА ДИСК)
// ============================================================
const DEFAULT_SETTINGS = {
    alwaysOnline:      true,
    autoReplyUrgent:   true,
    forwardMedia:      true,
    aiEnabled:         false,
    defaultAutoReply:  'Ернияз қазір бос емес. Кейінірек жазады.',
    antiSpam:          true,
    antiSpamCooldown:  60,   // секунд между повторными авто-ответами одному пользователю
};

class LocalDB {
    constructor(filePath) {
        this.file = filePath;
        this.data = this._init();
        this._dirty = false;

        // Сохраняем только если данные менялись (избегаем лишних I/O)
        setInterval(() => { if (this._dirty) { this._saveToDisk(); this._dirty = false; } }, 120_000);

        // Принудительное сохранение при выходе
        process.on('SIGINT',  () => { this._saveToDisk(); process.exit(); });
        process.on('SIGTERM', () => { this._saveToDisk(); process.exit(); });
    }

    _init() {
        if (!fs.existsSync(this.file)) {
            const d = { logs: [], messages: [], customReplies: {}, customAIPrompts: {}, stats: {}, settings: DEFAULT_SETTINGS };
            fs.writeFileSync(this.file, JSON.stringify(d, null, 2));
            return d;
        }
        const d = JSON.parse(fs.readFileSync(this.file, 'utf8'));
        // Миграция: добавляем недостающие поля
        d.settings = { ...DEFAULT_SETTINGS, ...d.settings };
        if (!d.customReplies)  d.customReplies  = {};
        if (!d.customAIPrompts) d.customAIPrompts = {};
        if (!d.stats)          d.stats          = {};
        return d;
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
        fs.appendFile('bot.log', line + '\n', () => {});
        this._dirty = true;
    }

    // Настройки
    getSettings()           { return this.data.settings; }
    toggleSetting(k)        { this.data.settings[k] = !this.data.settings[k]; this._dirty = true; return this.data.settings; }
    setSetting(k, v)        { this.data.settings[k] = v; this._dirty = true; }

    // Кастомные ответы
    setCustomReply(n, t)    { this.data.customReplies[n] = t; this._dirty = true; }
    deleteCustomReply(n)    { delete this.data.customReplies[n]; this._dirty = true; }
    getCustomReply(waId)    { return this.data.customReplies[waId.replace('@c.us', '')] || null; }

    // AI-промпты
    setCustomPrompt(n, t)   { this.data.customAIPrompts[n] = t; this._dirty = true; }
    deleteCustomPrompt(n)   { delete this.data.customAIPrompts[n]; this._dirty = true; }
    getCustomPrompt(waId)   { return this.data.customAIPrompts[waId.replace('@c.us', '')] || null; }

    // Статистика
    incStat(key)            { this.data.stats[key] = (this.data.stats[key] || 0) + 1; this._dirty = true; }
    getStats()              { return this.data.stats; }

    // Список всех кастомных ответов
    listCustomReplies()     { return this.data.customReplies; }
    listCustomPrompts()     { return this.data.customAIPrompts; }
}

const db = new LocalDB('./database.json');

// ============================================================
// 3. ANTI-SPAM: не отвечать одному и тому же контакту часто
// ============================================================
const repliedRecently = new Map(); // waId → timestamp

function canAutoReply(waId) {
    const s = db.getSettings();
    if (!s.antiSpam) return true;
    const last = repliedRecently.get(waId) || 0;
    const cooldown = (s.antiSpamCooldown || 60) * 1000;
    if (Date.now() - last < cooldown) return false;
    repliedRecently.set(waId, Date.now());
    return true;
}

// ============================================================
// 4. ОЧЕРЕДЬ ИСХОДЯЩИХ СООБЩЕНИЙ WA (анти-бан + rate limit)
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
    // Задержка 800ms между исходящими — избегаем бана WA
    setTimeout(processQueue, 800);
}

// ============================================================
// 5. WHATSAPP КЛИЕНТ
// ============================================================
const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: {
        executablePath: '/usr/bin/google-chrome-stable',
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu',
            '--no-first-run',
            '--no-zygote',
            '--disable-background-networking',
            '--disable-default-apps',
            '--disable-extensions',
            '--disable-sync',
            '--disable-translate',
            '--hide-scrollbars',
            '--metrics-recording-only',
            '--mute-audio',
            '--safebrowsing-disable-auto-update',
            '--js-flags=--max-old-space-size=512',
        ],
    },
});

// ============================================================
// 6. ГЕНЕРАТОР AI-ОТВЕТОВ (gemini-1.5-flash — быстрее и дешевле)
// ============================================================
const aiConversations = new Map(); // waId → [{role, parts}[]]

async function generateAIResponse(messageText, senderName, waId) {
    if (!genAI) return null;
    try {
        const model = genAI.getGenerativeModel({ model: 'gemini-pro' });

        const customPrompt = db.getCustomPrompt(waId);
        const sysMsg = customPrompt
            ? `Сен Ернияздың виртуалды көмекшісісің. "${senderName}" үшін арнайы ереже бар: "${customPrompt}". Осыған қатаң бағын.`
            : `Сен Ернияздың виртуалды көмекшісісің. Ол қазір бос емес. Жауапты қысқа, мазмұнды, жеңіл әзілмен жаз. Адам қазақша жазса — қазақша жауап бер. Адам орысша жазса — орысша жауап бер. Ағылшынша жазса — ағылшынша.`;

        // Ведём историю диалога (последние 20 реплик)
        if (!aiConversations.has(waId)) {
            // Первое сообщение: инструкция через user/model пинг
            aiConversations.set(waId, [
                { role: 'user',  parts: [{ text: sysMsg }] },
                { role: 'model', parts: [{ text: 'Понял, буду следовать инструкции.' }] },
            ]);
        }
        const history = aiConversations.get(waId);

        const chat = model.startChat({ history });
        const result = await chat.sendMessage(messageText);
        const aiText = result.response.text();

        history.push({ role: 'user',  parts: [{ text: messageText }] });
        history.push({ role: 'model', parts: [{ text: aiText }] });
        if (history.length > 22) history.splice(2, 2); // убираем старые, но сохраняем системный пинг

        db.incStat('ai_replies');
        return aiText;
    } catch (e) {
        db.log(`❌ AI ошибка: ${e.message}`);
        return null;
    }
}

// ============================================================
// 7. TELEGRAM → WHATSAPP МОСТ (полная поддержка медиа)
// ============================================================
const sendToTelegram = async (text, extra = {}) => {
    try {
        await tgBot.sendMessage(TG_CHAT_ID, text, { parse_mode: 'Markdown', ...extra });
    } catch (err) {
        console.error('❌ Ошибка TG send:', err.message);
    }
};

const getSettingsKeyboard = (s) => ({
    reply_markup: {
        inline_keyboard: [
            [
                { text: `${s.alwaysOnline      ? '🟢' : '⚫'} Онлайн`,       callback_data: 'toggle_alwaysOnline' },
                { text: `${s.aiEnabled         ? '🤖' : '⚫'} AI-Ответы`,    callback_data: 'toggle_aiEnabled' },
            ],
            [
                { text: `${s.autoReplyUrgent   ? '🚨' : '⚫'} Автоответ`,     callback_data: 'toggle_autoReplyUrgent' },
                { text: `${s.forwardMedia      ? '🖼️' : '⚫'} Медиа`,         callback_data: 'toggle_forwardMedia' },
            ],
            [
                { text: `${s.antiSpam          ? '🛡️' : '⚫'} Антиспам`,      callback_data: 'toggle_antiSpam' },
                { text: '📊 Статус',                                           callback_data: 'sys_status' },
            ],
            [
                { text: '📋 Кастомные ответы',                                 callback_data: 'list_replies' },
                { text: '🧠 AI-промпты',                                        callback_data: 'list_prompts' },
            ],
            [
                { text: '📈 Статистика',                                        callback_data: 'show_stats' },
                { text: '📜 Логи (30)',                                         callback_data: 'show_logs' },
            ],
        ],
    },
});

// ============================================================
// 8. TELEGRAM КОМАНДЫ
// ============================================================
tgBot.on('message', async (tgMsg) => {
    if (tgMsg.chat.id.toString() !== TG_CHAT_ID) return;
    const text = tgMsg.text || '';
    const settings = db.getSettings();

    // --- /start | /menu ---
    if (text === '/start' || text === '/menu') {
        const helpText =
            `⚙️ *Управление WA-Ботом*\n\n` +
            `*📤 Отправить сообщение:*\n\`/send 77012345678 текст\`\n\n` +
            `*📌 Кастомные ответы:*\n\`/setreply 77012345678 текст\`\n\`/delreply 77012345678\`\n\n` +
            `*🧠 AI-инструкции:*\n\`/setprompt 77012345678 инструкция\`\n\`/delprompt 77012345678\`\n\n` +
            `*💬 Базовый автоответ:*\n\`/setdefault текст\`\n\n` +
            `*⏱️ Антиспам-кулдаун:*\n\`/setcooldown 60\` (в секундах)\n\n` +
            `*🗑️ Сбросить историю AI:*\n\`/resetai 77012345678\``;
        await tgBot.sendMessage(TG_CHAT_ID, helpText, { parse_mode: 'Markdown', ...getSettingsKeyboard(settings) });
        return;
    }

    // --- /setdefault ---
    if (text.startsWith('/setdefault ')) {
        db.setSetting('defaultAutoReply', text.slice('/setdefault '.length));
        db.forceSave();
        await sendToTelegram('✅ Базовый автоответ обновлён.');
        return;
    }

    // --- /setreply ---
    if (text.startsWith('/setreply ')) {
        const m = text.match(/^\/setreply\s+(\d+)\s+(.+)$/s);
        if (m) {
            db.setCustomReply(m[1], m[2]);
            db.forceSave();
            await sendToTelegram(`✅ Фиксированный ответ для *+${m[1]}* установлен:\n_${m[2]}_`);
        } else {
            await sendToTelegram('⚠️ Формат: `/setreply 77012345678 текст`');
        }
        return;
    }

    // --- /delreply ---
    if (text.startsWith('/delreply ')) {
        const num = text.slice('/delreply '.length).trim();
        db.deleteCustomReply(num);
        db.forceSave();
        await sendToTelegram(`🗑 Ответ для *+${num}* удалён.`);
        return;
    }

    // --- /setprompt ---
    if (text.startsWith('/setprompt ')) {
        const m = text.match(/^\/setprompt\s+(\d+)\s+(.+)$/s);
        if (m) {
            db.setCustomPrompt(m[1], m[2]);
            db.forceSave();
            // Сбрасываем историю при новом промпте
            aiConversations.delete(`${m[1]}@c.us`);
            await sendToTelegram(`🧠 AI-инструкция для *+${m[1]}* сохранена:\n_${m[2]}_`);
        } else {
            await sendToTelegram('⚠️ Формат: `/setprompt 77012345678 Отвечай по-казахски`');
        }
        return;
    }

    // --- /delprompt ---
    if (text.startsWith('/delprompt ')) {
        const num = text.slice('/delprompt '.length).trim();
        db.deleteCustomPrompt(num);
        db.forceSave();
        aiConversations.delete(`${num}@c.us`);
        await sendToTelegram(`🗑 AI-инструкция для *+${num}* удалена.`);
        return;
    }

    // --- /setcooldown ---
    if (text.startsWith('/setcooldown ')) {
        const secs = parseInt(text.slice('/setcooldown '.length).trim(), 10);
        if (!isNaN(secs) && secs >= 0) {
            db.setSetting('antiSpamCooldown', secs);
            db.forceSave();
            await sendToTelegram(`✅ Кулдаун антиспама: *${secs} сек*`);
        } else {
            await sendToTelegram('⚠️ Укажи число секунд, например `/setcooldown 120`');
        }
        return;
    }

    // --- /resetai ---
    if (text.startsWith('/resetai ')) {
        const num = text.slice('/resetai '.length).trim();
        aiConversations.delete(`${num}@c.us`);
        await sendToTelegram(`🔄 История AI для *+${num}* сброшена.`);
        return;
    }

    // --- /send ---
    if (text.startsWith('/send ')) {
        const m = text.match(/^\/send\s+(\d+)\s+(.+)$/s);
        if (m) {
            try {
                await enqueueWA(() => client.sendMessage(`${m[1]}@c.us`, m[2]));
                await sendToTelegram(`✅ Отправлено на *+${m[1]}*`);
                db.incStat('manual_sends');
            } catch (e) {
                await sendToTelegram(`❌ Ошибка: ${e.message}`);
            }
        }
        return;
    }

    // --- Ответ на форвардное сообщение (мост TG → WA) ---
    if (tgMsg.reply_to_message) {
        const refText = tgMsg.reply_to_message.text || tgMsg.reply_to_message.caption || '';
        const waMatch = refText.match(/WA_ID:\s*([0-9]+@c\.us)/);
        if (waMatch) {
            const waId = waMatch[1];
            try {
                if (tgMsg.photo) {
                    const fileId   = tgMsg.photo[tgMsg.photo.length - 1].file_id;
                    const fileLink = await tgBot.getFileLink(fileId);
                    const media    = await MessageMedia.fromUrl(fileLink, { unsafeMime: true });
                    await enqueueWA(() => client.sendMessage(waId, media, { caption: tgMsg.caption || '' }));
                } else if (tgMsg.video) {
                    const fileLink = await tgBot.getFileLink(tgMsg.video.file_id);
                    const media    = await MessageMedia.fromUrl(fileLink, { unsafeMime: true });
                    await enqueueWA(() => client.sendMessage(waId, media, { caption: tgMsg.caption || '' }));
                } else if (tgMsg.document) {
                    const fileLink = await tgBot.getFileLink(tgMsg.document.file_id);
                    const media    = await MessageMedia.fromUrl(fileLink, { unsafeMime: true });
                    await enqueueWA(() => client.sendMessage(waId, media));
                } else if (tgMsg.voice || tgMsg.audio) {
                    const fileId   = (tgMsg.voice || tgMsg.audio).file_id;
                    const fileLink = await tgBot.getFileLink(fileId);
                    const media    = await MessageMedia.fromUrl(fileLink, { unsafeMime: true });
                    await enqueueWA(() => client.sendMessage(waId, media));
                } else if (tgMsg.sticker) {
                    const fileLink = await tgBot.getFileLink(tgMsg.sticker.file_id);
                    const media    = await MessageMedia.fromUrl(fileLink, { unsafeMime: true });
                    await enqueueWA(() => client.sendMessage(waId, media));
                } else if (tgMsg.text) {
                    await enqueueWA(() => client.sendMessage(waId, tgMsg.text));
                }
                await tgBot.sendMessage(TG_CHAT_ID, '✅ Доставлено в WA', { reply_to_message_id: tgMsg.message_id });
                db.incStat('bridge_sends');
                db.log(`✅ Мост TG→WA (${waId})`);
            } catch (err) {
                await tgBot.sendMessage(TG_CHAT_ID, `❌ Ошибка моста: ${err.message}`, { reply_to_message_id: tgMsg.message_id });
                db.log(`❌ Мост TG→WA ошибка: ${err.message}`);
            }
        }
    }
});

// ============================================================
// 9. TELEGRAM CALLBACK (кнопки)
// ============================================================
tgBot.on('callback_query', async (query) => {
    if (query.message.chat.id.toString() !== TG_CHAT_ID) return;
    const action = query.data;

    if (action.startsWith('toggle_')) {
        const key = action.replace('toggle_', '');
        if (key === 'aiEnabled' && !GEMINI_API_KEY) {
            await tgBot.answerCallbackQuery(query.id, { text: '❌ Нет GEMINI_API_KEY в .env', show_alert: true });
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
        const freeRAM    = Math.round(os.freemem() / 1024 / 1024);
        const totalRAM   = Math.round(os.totalmem() / 1024 / 1024);
        const scriptRAM  = Math.round(process.memoryUsage().rss / 1024 / 1024);
        const heapUsed   = Math.round(process.memoryUsage().heapUsed / 1024 / 1024);
        const uptime     = process.uptime();
        const uptimeStr  = `${Math.floor(uptime/3600)}ч ${Math.floor((uptime%3600)/60)}м`;
        const cpuLoad    = os.loadavg()[0].toFixed(2);
        const queueLen   = waQueue.length;
        const stats = [
            `💻 *Статус Системы*`,
            `🧠 RAM хоста: ${freeRAM}MB / ${totalRAM}MB`,
            `📦 RAM скрипта: ${scriptRAM}MB (heap: ${heapUsed}MB)`,
            `🔥 CPU Load (1m): ${cpuLoad}`,
            `⏱ Uptime бота: ${uptimeStr}`,
            `📬 Очередь WA: ${queueLen} msg`,
            `🗓 Сервер: ${os.hostname()} / ${os.platform()}`,
        ].join('\n');
        await tgBot.answerCallbackQuery(query.id, { text: stats, show_alert: true });
    }

    else if (action === 'list_replies') {
        const replies = db.listCustomReplies();
        const keys = Object.keys(replies);
        if (keys.length === 0) {
            await tgBot.answerCallbackQuery(query.id, { text: 'Нет кастомных ответов', show_alert: true });
        } else {
            const txt = '📋 *Кастомные ответы:*\n' + keys.map(k => `+${k}: _${replies[k].slice(0,40)}_`).join('\n');
            await sendToTelegram(txt);
            await tgBot.answerCallbackQuery(query.id);
        }
    }

    else if (action === 'list_prompts') {
        const prompts = db.listCustomPrompts();
        const keys = Object.keys(prompts);
        if (keys.length === 0) {
            await tgBot.answerCallbackQuery(query.id, { text: 'Нет AI-инструкций', show_alert: true });
        } else {
            const txt = '🧠 *AI-инструкции:*\n' + keys.map(k => `+${k}: _${prompts[k].slice(0,60)}_`).join('\n');
            await sendToTelegram(txt);
            await tgBot.answerCallbackQuery(query.id);
        }
    }

    else if (action === 'show_stats') {
        const s = db.getStats();
        const txt = '📈 *Статистика:*\n' + (Object.keys(s).length
            ? Object.entries(s).map(([k,v]) => `• ${k}: *${v}*`).join('\n')
            : '_Пока нет данных_');
        await tgBot.answerCallbackQuery(query.id, { text: txt.slice(0, 200), show_alert: true });
    }

    else if (action === 'show_logs') {
        const logs = db.data.logs.slice(-30).join('\n');
        await sendToTelegram(`\`\`\`\n${logs.slice(0, 3900)}\n\`\`\``);
        await tgBot.answerCallbackQuery(query.id);
    }
});

// ============================================================
// 10. WHATSAPP: СОБЫТИЯ
// ============================================================
client.on('qr', (qr) => {
    qrcode.generate(qr, { small: true });
    db.log('⏳ QR-код обновлён. Сканируй!');
    sendToTelegram('📱 *WA QR-код обновлён!* Отсканируй в приложении.');
});

client.on('authenticated', () => db.log('🔐 WA аутентифицирован.'));

client.on('auth_failure', (msg) => {
    db.log(`❌ WA ошибка аутентификации: ${msg}`);
    sendToTelegram(`❌ *WA ошибка аутентификации:* ${msg}`);
});

client.on('ready', () => {
    db.log('🚀 WhatsApp подключён и готов!');
    sendToTelegram('🚀 *WhatsApp подключён!*\nБот активен.');

    // Поддержка онлайн-статуса
    setInterval(async () => {
        if (db.getSettings().alwaysOnline) {
            try { await client.sendPresenceAvailable(); } catch (_) {}
        }
    }, 45_000);
});

client.on('disconnected', (reason) => {
    db.log(`⚠️ WA отключился: ${reason}`);
    sendToTelegram(`⚠️ *WA отключился!*\nПричина: ${reason}\nПерезапуск через 10 сек...`);
    setTimeout(() => client.initialize(), 10_000);
});

// ============================================================
// 11. WHATSAPP: ВХОДЯЩИЕ СООБЩЕНИЯ
// ============================================================
client.on('message', async (msg) => {
    if (msg.isStatus) return;

    const text    = msg.body || '';
    const textLow = text.toLowerCase();
    const isGroup = msg.from.includes('@g.us');
    const settings = db.getSettings();

    db.incStat('messages_received');

    // ---- КОМАНДЫ (доступны всем, кто написал, в т.ч. группы) ----

    if (textLow === '!ping') {
        await msg.reply('🤖 *Pong!* Жүйе жұмыс істеп тұр.');
        return;
    }

    if (textLow === '!help') {
        await msg.reply(
            '🤖 *Бот командалары:*\n' +
            '`!ping` — тексеру\n' +
            '`!ескерт [мин] [мәтін]` — еске салу\n' +
            '`!тамақ [г]` — инсулин есептеу\n' +
            '`!анализ` — қан тапсыру ескертуі\n' +
            '`!үй` — смарт үй күйі\n' +
            '`!ауа` — ауа райы\n' +
            '`!id` — сіздің WA ID'
        );
        return;
    }

    if (textLow === '!id') {
        await msg.reply(`🔑 Сіздің WA ID:\n\`${msg.from}\``);
        return;
    }

    // Еске салу (казахский + русский)
    if (textLow.startsWith('!ескерт ') || textLow.startsWith('!напомни ')) {
        const parts = text.split(' ');
        const minutes = parseInt(parts[1], 10);
        const reminderText = parts.slice(2).join(' ');
        if (!isNaN(minutes) && minutes > 0 && reminderText) {
            await msg.reply(`⏳ *${minutes}* минуттан кейін ескертемін.`);
            setTimeout(async () => {
                try {
                    await enqueueWA(() => msg.reply(`⏰ *ЕСКЕ САЛУ:*\n${reminderText}`));
                } catch (_) {}
            }, minutes * 60_000);
        } else {
            await msg.reply('⚠️ Формат: `!ескерт 15 сүт алу`');
        }
        return;
    }

    // Инсулин калькуляторы
    if (textLow.startsWith('!тамақ') || textLow.startsWith('!еда')) {
        const carbs = parseInt(textLow.replace(/[^\d]/g, ''), 10);
        if (!isNaN(carbs) && carbs > 0) {
            const insulin = (carbs / 10).toFixed(1);
            await msg.reply(
                `🍽️ *Инсулин калькуляторы:*\n` +
                `Көмірсулар: *${carbs}г*\n` +
                `💉 Инсулин: *${insulin} бірлік*\n` +
                `_Дәрігермен ақылдасыңыз!_`
            );
        } else {
            await msg.reply('⚠️ Формат: `!тамақ 60` (көмірсу граммы)');
        }
        return;
    }

    if (textLow === '!анализ') {
        await msg.reply('🩺 *Еске салу:* Қанды және HbA1c мерзімді тексеруді ұмытпа!');
        return;
    }

    if (textLow === '!үй' || textLow === '!дом' || textLow === '!home') {
        await msg.reply('🏠 *VECTOR Smart Home*\n✅ Барлық жүйелер қалыпты.');
        return;
    }

    if (textLow === '!ауа' || textLow === '!погода') {
        await msg.reply('🌤️ Ауа райы әзірге қолжетімді емес. OpenWeather API қос.');
        return;
    }

    // ---- ЛИЧНЫЕ СООБЩЕНИЯ: автоответы ----
    if (!isGroup) {
        const contact    = await msg.getContact();
        const senderName = contact.name || contact.pushname || msg.from.replace('@c.us', '');
        let autoReplied  = false;
        let replyText    = '';

        // Приоритет 1: Фиксированный ответ
        const customReply = db.getCustomReply(msg.from);
        if (customReply && canAutoReply(msg.from)) {
            await enqueueWA(() => msg.reply(customReply));
            replyText = customReply;
            autoReplied = true;
            db.log(`🎯 Кастомный ответ → ${senderName}`);
            db.incStat('custom_replies');
        }
        // Приоритет 2: AI-ответ
        else if (settings.aiEnabled && !msg.hasMedia && canAutoReply(msg.from)) {
            const aiText = await generateAIResponse(text, senderName, msg.from);
            if (aiText) {
                await enqueueWA(() => msg.reply(`🤖 ${aiText}`));
                replyText = aiText;
                autoReplied = true;
                db.log(`🤖 AI ответил → ${senderName}`);
            }
        }
        // Приоритет 3: Базовый автоответ при ключевых словах (казахский + русский)
        else if (
            settings.autoReplyUrgent &&
            (
                textLow.includes('срочно') || textLow.includes('важно') || textLow.includes('помогите') ||
                textLow.includes('шұғыл') || textLow.includes('маңызды') || textLow.includes('көмек')
            ) &&
            canAutoReply(msg.from)
        ) {
            await enqueueWA(() => msg.reply(settings.defaultAutoReply));
            replyText = settings.defaultAutoReply;
            autoReplied = true;
            db.log(`🚨 Автоответ (ключ. слово) → ${senderName}`);
            db.incStat('urgent_replies');
        }

        // ---- Пересылка в Telegram ----
        let tgText = `💬 *От:* ${senderName} \`(${msg.from})\`\n`;
        if (autoReplied) tgText += `🤖 _(Ответ отправлен)_\n`;
        tgText += '\n';

        if (msg.hasMedia) {
            if (settings.forwardMedia) {
                try {
                    const media  = await msg.downloadMedia();
                    const buffer = Buffer.from(media.data, 'base64');
                    const caption = `${tgText}📎 _${media.mimetype}_\n${text || ''}\n\n\`WA_ID: ${msg.from}\`\n_↩️ Ответь на это сообщение_`;

                    if (media.mimetype.includes('image')) {
                        await tgBot.sendPhoto(TG_CHAT_ID, buffer, { caption, parse_mode: 'Markdown' });
                    } else if (media.mimetype.includes('video')) {
                        await tgBot.sendVideo(TG_CHAT_ID, buffer, { caption, parse_mode: 'Markdown' });
                    } else if (media.mimetype.includes('audio') || media.mimetype.includes('ogg')) {
                        await tgBot.sendVoice(TG_CHAT_ID, buffer, { caption, parse_mode: 'Markdown' });
                    } else {
                        await tgBot.sendDocument(TG_CHAT_ID, buffer, {
                            filename: media.filename || 'file',
                            caption, parse_mode: 'Markdown',
                        });
                    }
                    db.incStat('media_forwarded');
                    return;
                } catch (e) {
                    tgText += `📎 _[Медиа: ошибка загрузки]_\n`;
                    db.log(`❌ Ошибка скачивания медиа: ${e.message}`);
                }
            } else {
                tgText += `📁 _[Медиа скрыто]\n${text}_`;
            }
        } else {
            tgText += text;
        }

        tgText += `\n\n---\n\`WA_ID: ${msg.from}\`\n_↩️ Ответь на это сообщение_`;
        await sendToTelegram(tgText);
    }
});

// ============================================================
// 12. ГЛОБАЛЬНАЯ ОБРАБОТКА ОШИБОК
// ============================================================
process.on('unhandledRejection', (reason, promise) => {
    const msg = reason instanceof Error ? reason.message : String(reason);
    db.log(`⚠️ UnhandledRejection: ${msg}`);
});

process.on('uncaughtException', (err) => {
    db.log(`🔥 UncaughtException: ${err.message}`);
    sendToTelegram(`🔥 *Критическая ошибка:*\n\`${err.message}\``);
    // Даём время на отправку в TG перед перезапуском
    setTimeout(() => process.exit(1), 2000);
});

// ============================================================
// 13. СТАРТ
// ============================================================
db.log('🟡 Бот запускается...');
sendToTelegram('🟡 *WA-бот запускается...*');
client.initialize();