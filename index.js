import wwebjs from 'whatsapp-web.js';
const { Client, LocalAuth, MessageMedia } = wwebjs;
import qrcode from 'qrcode-terminal';
import fs from 'fs';
import os from 'os';
import TelegramBot from 'node-telegram-bot-api';
import { GoogleGenerativeAI } from '@google/generative-ai';

// ==========================================
// 1. КОНФИГУРАЦИЯ И КЛЮЧИ
// ==========================================
const TG_TOKEN = process.env.TG_TOKEN;
const TG_CHAT_ID = process.env.TG_CHAT_ID;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

const tgBot = TG_TOKEN ? new TelegramBot(TG_TOKEN, { polling: true }) : null;
const genAI = GEMINI_API_KEY ? new GoogleGenerativeAI(GEMINI_API_KEY) : null;

// ==========================================
// 2. БАЗА ДАННЫХ (ОПТИМИЗИРОВАННАЯ: IN-MEMORY CACHE)
// ==========================================
const DEFAULT_SETTINGS = {
    alwaysOnline: true,
    autoReplyUrgent: true,
    forwardMedia: true,
    aiEnabled: false,
    defaultAutoReply: "Ернияз сейчас занят и не может ответить. Напишите позже."
};

class LocalDB {
    constructor(filePath) {
        this.file = filePath;
        this.data = this.init();
        
        // ОПТИМИЗАЦИЯ: Асинхронное сохранение на диск раз в 3 минуты. 
        // Больше никакого I/O блокирования при каждом сообщении!
        setInterval(() => this.saveToDisk(), 180000); 
    }
    
    init() {
        if (!fs.existsSync(this.file)) {
            const defaultData = { logs: [], messages: [], customReplies: {}, customAIPrompts: {}, settings: DEFAULT_SETTINGS };
            fs.writeFileSync(this.file, JSON.stringify(defaultData, null, 2));
            return defaultData;
        } else {
            const data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
            if (!data.settings) data.settings = DEFAULT_SETTINGS;
            if (data.settings.aiEnabled === undefined) data.settings.aiEnabled = false;
            if (!data.settings.defaultAutoReply) data.settings.defaultAutoReply = DEFAULT_SETTINGS.defaultAutoReply;
            if (!data.customReplies) data.customReplies = {};
            if (!data.customAIPrompts) data.customAIPrompts = {};
            return data;
        }
    }

    saveToDisk() {
        fs.writeFile(this.file, JSON.stringify(this.data, null, 2), (err) => {
            if (err) console.error('❌ Ошибка фоновой записи БД:', err);
        });
    }

    log(msg) {
        const time = new Date().toLocaleString('ru-RU', { timeZone: 'Asia/Almaty' });
        const logMsg = `[${time}] ${msg}`;
        console.log(logMsg);
        
        this.data.logs.push(logMsg);
        if (this.data.logs.length > 500) this.data.logs.shift(); // Уменьшили массив логов в RAM
        
        // Асинхронная дозапись в лог-файл (не блокирует процесс)
        fs.appendFile('bot.log', logMsg + '\n', () => {}); 
    }

    // Все методы теперь работают только с оперативной памятью (быстро)
    getSettings() { return this.data.settings; }
    toggleSetting(key) { this.data.settings[key] = !this.data.settings[key]; return this.data.settings; }
    
    setDefaultReply(text) { this.data.settings.defaultAutoReply = text; }
    setCustomReply(number, text) { this.data.customReplies[number] = text; }
    deleteCustomReply(number) { delete this.data.customReplies[number]; }
    getCustomReply(waId) { return this.data.customReplies[waId.replace('@c.us', '')] || null; }

    setCustomPrompt(number, text) { this.data.customAIPrompts[number] = text; }
    deleteCustomPrompt(number) { delete this.data.customAIPrompts[number]; }
    getCustomPrompt(waId) { return this.data.customAIPrompts[waId.replace('@c.us', '')] || null; }
}
const db = new LocalDB('./database.json');

// ==========================================
// 3. WHATSAPP КЛИЕНТ (ОПТИМИЗИРОВАННЫЙ CHROMIUM)
// ==========================================
const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: {
        executablePath: '/usr/bin/chromium',
        args: [
            // Хардкорная оптимизация памяти и процессов
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
            '--js-flags=--max-old-space-size=512' // Ограничение памяти самого браузера
        ]
    }
});

// ==========================================
// 4. TELEGRAM-ИНТЕРФЕЙС И МАРШРУТИЗАЦИЯ
// ==========================================
const getSettingsKeyboard = (settings) => {
    return {
        reply_markup: {
            inline_keyboard: [
                [{ text: `🟢 Онлайн: ${settings.alwaysOnline ? 'ВКЛ' : 'ВЫКЛ'}`, callback_data: 'toggle_alwaysOnline' },
                 { text: `🤖 AI-Ответы: ${settings.aiEnabled ? 'ВКЛ' : 'ВЫКЛ'}`, callback_data: 'toggle_aiEnabled' }],
                [{ text: `🚨 Базовый Автоответ: ${settings.autoReplyUrgent ? 'ВКЛ' : 'ВЫКЛ'}`, callback_data: 'toggle_autoReplyUrgent' }],
                [{ text: `🖼️ Медиа: ${settings.forwardMedia ? 'ВКЛ' : 'ВЫКЛ'}`, callback_data: 'toggle_forwardMedia' }],
                [{ text: `📊 Статус системы`, callback_data: 'sys_status' }]
            ]
        }
    };
};

if (tgBot) {
    tgBot.on('message', async (tgMsg) => {
        if (tgMsg.chat.id.toString() !== TG_CHAT_ID) return;
        const text = tgMsg.text || '';

        if (text === '/start' || text === '/menu') {
            await tgBot.sendMessage(TG_CHAT_ID, '⚙️ *Управление WA*\n\n*Статика:*\n`/setdefault [текст]` - база\n`/setreply [номер] [текст]` - фикс. ответ\n`/delreply [номер]`\n\n*Нейросеть (AI):*\n`/setprompt [номер] [инструкция]` - как ИИ общаться с человеком\n`/delprompt [номер]` - удалить инструкцию', {
                parse_mode: 'Markdown',
                ...getSettingsKeyboard(db.getSettings())
            });
            return;
        }

        if (text.startsWith('/setdefault ')) {
            db.setDefaultReply(text.replace('/setdefault ', ''));
            await tgBot.sendMessage(TG_CHAT_ID, `✅ Базовый автоответ обновлен.`);
            return;
        }
        if (text.startsWith('/setreply ')) {
            const match = text.match(/^\/setreply\s+(\d+)\s+(.+)$/s);
            if (match) {
                db.setCustomReply(match[1], match[2]);
                await tgBot.sendMessage(TG_CHAT_ID, `✅ Фиксированный ответ для +${match[1]} установлен.`);
            }
            return;
        }
        if (text.startsWith('/delreply ')) {
            db.deleteCustomReply(text.replace('/delreply ', '').trim());
            await tgBot.sendMessage(TG_CHAT_ID, `🗑 Кастомный ответ удален.`);
            return;
        }

        if (text.startsWith('/setprompt ')) {
            const match = text.match(/^\/setprompt\s+(\d+)\s+(.+)$/s);
            if (match) {
                db.setCustomPrompt(match[1], match[2]);
                await tgBot.sendMessage(TG_CHAT_ID, `🧠 ИИ-инструкция для +${match[1]} сохранена:\n_${match[2]}_`, { parse_mode: 'Markdown' });
            } else {
                await tgBot.sendMessage(TG_CHAT_ID, '⚠️ Формат: `/setprompt 77012345678 Отвечай сарказмом`', { parse_mode: 'Markdown' });
            }
            return;
        }
        if (text.startsWith('/delprompt ')) {
            db.deleteCustomPrompt(text.replace('/delprompt ', '').trim());
            await tgBot.sendMessage(TG_CHAT_ID, `🗑 ИИ-инструкция удалена.`);
            return;
        }

        if (text.startsWith('/send ')) {
            const match = text.match(/^\/send\s+(\d+)\s+(.+)$/s);
            if (match) {
                try {
                    await client.sendMessage(`${match[1]}@c.us`, match[2]);
                    await tgBot.sendMessage(TG_CHAT_ID, `✅ Отправлено на +${match[1]}`);
                } catch (e) { await tgBot.sendMessage(TG_CHAT_ID, `❌ Ошибка: ${e.message}`); }
            }
            return;
        }

        if (tgMsg.reply_to_message && tgMsg.reply_to_message.text) {
            const match = tgMsg.reply_to_message.text.match(/WA_ID:\s*([0-9]+@c\.us)/);
            if (match && match[1]) {
                try {
                    if (tgMsg.photo) {
                        const fileLink = await tgBot.getFileLink(tgMsg.photo[tgMsg.photo.length - 1].file_id);
                        await client.sendMessage(match[1], await MessageMedia.fromUrl(fileLink), { caption: tgMsg.caption || '' });
                    } else if (tgMsg.text) {
                        await client.sendMessage(match[1], tgMsg.text);
                    }
                    db.log(`✅ Ответ отправлен в WA (${match[1]})`);
                } catch (err) { db.log(`❌ Ошибка моста ТГ->WA`); }
            }
        }
    });

    tgBot.on('callback_query', async (query) => {
        if (query.message.chat.id.toString() !== TG_CHAT_ID) return;
        const action = query.data;

        if (action.startsWith('toggle_')) {
            const key = action.replace('toggle_', '');
            if (key === 'aiEnabled' && !GEMINI_API_KEY) {
                await tgBot.answerCallbackQuery(query.id, { text: '❌ Ошибка: Не задан GEMINI_API_KEY', show_alert: true });
                return;
            }
            const newSettings = db.toggleSetting(key);
            db.saveToDisk(); // Принудительно сохраняем настройки по клику
            
            await tgBot.editMessageReplyMarkup(getSettingsKeyboard(newSettings).reply_markup, {
                chat_id: query.message.chat.id, message_id: query.message.message_id
            });
            await tgBot.answerCallbackQuery(query.id, { text: 'Обновлено' });
        } 
        else if (action === 'sys_status') {
            const freeRAM = Math.round(os.freemem() / 1024 / 1024);
            const processRAM = Math.round(process.memoryUsage().rss / 1024 / 1024); // НОВОЕ: Память самого Node.js
            const stats = `💻 Сервер Node.js\n🧠 RAM Хоста: ${freeRAM}MB free\n📦 RAM Скрипта: ${processRAM}MB\n🔥 CPU Load: ${os.loadavg()[0].toFixed(2)}\n⏱ Uptime: ${Math.floor(os.uptime()/3600)}ч`;
            await tgBot.answerCallbackQuery(query.id, { text: stats, show_alert: true });
        }
    });
}

const sendToTelegram = async (text) => {
    if (!tgBot || !TG_CHAT_ID) return;
    try { await tgBot.sendMessage(TG_CHAT_ID, text, { parse_mode: 'Markdown' }); } catch (err) {}
};

// ==========================================
// 5. ИНТЕЛЛЕКТУАЛЬНЫЙ ГЕНЕРАТОР ОТВЕТОВ
// ==========================================
const generateAIResponse = async (messageText, senderName, waId) => {
    if (!genAI) return null;
    try {
        const model = genAI.getGenerativeModel({ model: "gemini-pro" });
        let prompt = `Ты виртуальный помощник Ернияза. Ернияз сейчас занят. Пользователь "${senderName}" написал: "${messageText}". Ответь коротко, по делу и с небольшой долей умного сарказма или юмора.`;

        const customPrompt = db.getCustomPrompt(waId);
        if (customPrompt) {
            prompt = `Ты виртуальный помощник Ернияза. Пользователь "${senderName}" написал: "${messageText}". 
            ВНИМАНИЕ! Для этого человека установлено специальное правило: "${customPrompt}". 
            Строго следуй этому правилу.`;
        }

        const result = await model.generateContent(prompt);
        return result.response.text();
    } catch (e) {
        db.log(`❌ Ошибка ИИ: ${e.message}`);
        return null;
    }
};

// ==========================================
// 6. СОБЫТИЯ WHATSAPP И ЛОГИКА ОТВЕТОВ
// ==========================================
client.on('qr', (qr) => { qrcode.generate(qr, { small: true }); db.log('⏳ Сканируй QR-код!'); });

client.on('ready', () => {
    db.log('🚀 WhatsApp успешно подключен!');
    setInterval(async () => {
        if (db.getSettings().alwaysOnline) {
            try { await client.sendPresenceAvailable(); } catch (e) {}
        }
    }, 60000);
});

client.on('message', async (msg) => {
    const text = msg.body.toLowerCase();
    const isGroup = msg.from.includes('@g.us');
    const settings = db.getSettings();
    
    if (msg.isStatus) return;

    if (text === '!ping') { await msg.reply('🤖 Система стабильна. Ресурсы оптимизированы.'); return; }
    
    if (text.startsWith('!напомни ')) {
        const parts = msg.body.split(' ');
        const minutes = parseInt(parts[1], 10);
        const reminderText = parts.slice(2).join(' ');
        if (!isNaN(minutes) && minutes > 0 && reminderText) {
            await msg.reply(`⏳ Напомню через ${minutes} мин.`);
            setTimeout(async () => { await msg.reply(`⏰ *НАПОМИНАНИЕ:*\n${reminderText}`); }, minutes * 60 * 1000);
        }
        return;
    }

    if (text.startsWith('!тамақ') || text.startsWith('!еда')) {
        const carbs = parseInt(text.replace(/[^\d]/g, ''), 10);
        if (!isNaN(carbs)) {
            await msg.reply(`Шырын үшін есептеу:\nСенде ${carbs} грамм көмірсу бар.\n💉 Қажетті инсулин мөлшері: *${(carbs / 10).toFixed(1)} бірлік*.\nАс дәмді болсын! 🍽️`);
        }
        return;
    }
    if (text === '!анализ') { await msg.reply('🩺 Қан талдауларын үнемі тексеріп тұру маңызды.'); return; }
    if (text === '!дом' || text === '!home') { await msg.reply('🏠 *Умный дом (VECTOR Beta 1)*\nВсё штатно.'); return; }

    if (!isGroup) {
        const contact = await msg.getContact();
        const senderName = contact.name || contact.pushname || msg.from.replace('@c.us', '');
        let autoReplied = false;

        const customReply = db.getCustomReply(msg.from);
        if (customReply) {
            await msg.reply(customReply);
            autoReplied = true;
            db.log(`🎯 Отправлен фикс. ответ для ${msg.from}`);
        } 
        else if (settings.aiEnabled && !msg.hasMedia) {
            const aiText = await generateAIResponse(msg.body, senderName, msg.from);
            if (aiText) {
                await msg.reply(`[AI]: ${aiText}`);
                autoReplied = true;
                db.log(`🤖 ИИ ответил ${msg.from}`);
            }
        }
        else if (settings.autoReplyUrgent && (text.includes('срочно') || text.includes('важно'))) {
            await msg.reply(settings.defaultAutoReply);
            autoReplied = true;
        }

        if (tgBot && TG_CHAT_ID) {
            let tgMessage = `💬 *От:* ${senderName}\n`;
            if (autoReplied) tgMessage += `_(Ответил бот)_\n\n`; else tgMessage += `\n`;

            if (msg.hasMedia) {
                if (settings.forwardMedia) {
                    try {
                        const media = await msg.downloadMedia();
                        tgMessage += `_[Вложение: ${media.mimetype}]_\n`;
                        const buffer = Buffer.from(media.data, 'base64');
                        if (media.mimetype.includes('image')) { await tgBot.sendPhoto(TG_CHAT_ID, buffer, { caption: tgMessage + (msg.body || '') }); return; } 
                        else if (media.mimetype.includes('audio') || media.mimetype.includes('ogg')) { await tgBot.sendVoice(TG_CHAT_ID, buffer); tgMessage += '🎙️ *Голосовое*'; } 
                        else { await tgBot.sendDocument(TG_CHAT_ID, buffer); }
                    } catch (e) { tgMessage += '_[Ошибка загрузки]_\n'; }
                } else { tgMessage += `📁 _[Медиа скрыто]_\n${msg.body}`; }
            } else { tgMessage += `${msg.body}`; }

            tgMessage += `\n\n---\n\`WA_ID: ${msg.from}\`\n_(Ответь на текст)_`;
            await sendToTelegram(tgMessage);
        }
    }
});

client.initialize();