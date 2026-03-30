import TelegramBot from 'node-telegram-bot-api';
import os from 'os';
import db from './db.js';
import { resetAIHistory } from './ai.js';

// Из-за циклической зависимости импортируем whatsapp.js отложенно
let waModule = null;
import('./whatsapp.js').then(m => waModule = m);

const TG_TOKEN = process.env.TG_TOKEN;
export const TG_CHAT_ID = process.env.TG_CHAT_ID;

if (!TG_TOKEN || !TG_CHAT_ID) {
    console.error('❌ КРИТИЧНО: TG_TOKEN и TG_CHAT_ID обязательны в .env');
    process.exit(1);
}

const tgBot = new TelegramBot(TG_TOKEN, { polling: true });

export const sendToTelegram = async (text, extra = {}) => {
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
                { text: `${s.autoReplyUrgent ? '🚨' : '⚫'} Базовый ответ`, callback_data: 'toggle_autoReplyUrgent' },
                { text: `${s.forwardMedia ? '🖼️' : '⚫'} Пересылка медиа`, callback_data: 'toggle_forwardMedia' },
            ],
            [
                { text: `${s.antiSpam ? '🛡️' : '⚫'} Антиспам`, callback_data: 'toggle_antiSpam' },
                { text: '📊 Статус системы', callback_data: 'sys_status' },
            ],
            [
                { text: '📋 Мои ответы', callback_data: 'list_replies' },
                { text: '🧠 Правила ИИ', callback_data: 'list_prompts' },
            ],
            [
                { text: '📈 Статистика общения', callback_data: 'show_stats' },
                { text: '📜 Логи консоли', callback_data: 'show_logs' },
            ],
        ],
    },
});

tgBot.on('message', async (tgMsg) => {
    if (tgMsg.chat.id.toString() !== TG_CHAT_ID) return;
    const text = tgMsg.text || '';
    const settings = db.getSettings();

    if (text === '/start' || text === '/menu') {
        const helpText =
            `⚙️ *МЕГА-УДОБНАЯ ПАНЕЛЬ WA-БОТА*\n\n` +
            `*📤 Написать человеку:*\n\`/send 77012345678 Привет!\`\n\n` +
            `*📌 Свой ответ на контакт:*\n\`/setreply 77012345678 Я занят\`\n\`/delreply 77012345678\`\n\n` +
            `*🧠 Персональное правило ИИ:*\n\`/setprompt 77012345678 Общайся только на казахском\`\n\`/delprompt 77012345678\`\n\n` +
            `*💬 Изменить базовый ответ:*\n\`/setdefault Я перезвоню\`\n\n` +
            `*⏱️ Кудаун антиспама:*\n\`/setcooldown 60\`\n\n` +
            `*🗑️ Очистить память ИИ:*\n\`/resetai 77012345678\`\n\n` +
            `*👤 Досье на контакт:*\n\`/stat 77012345678\`\n\`/top\` — кто чаще пишет`;
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
        if (m) { db.setCustomReply(m[1], m[2]); db.forceSave(); await sendToTelegram(`✅ Кастомный ответ для *+${m[1]}* сохранён.`); }
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
            if (waModule) resetAIHistory(waModule.toWAJid(m[1]));
            await sendToTelegram(`🧠 Умное правило для *+${m[1]}* сохранено:\n_${m[2]}_`);
        } else {
            await sendToTelegram('⚠️ Формат: `/setprompt 77012345678 Отвечай коротко`');
        }
        return;
    }

    if (text.startsWith('/delprompt ')) {
        const num = text.slice('/delprompt '.length).trim();
        db.deleteCustomPrompt(num);
        db.forceSave();
        if (waModule) resetAIHistory(waModule.toWAJid(num));
        await sendToTelegram(`🗑 Правило для *+${num}* удалено.`);
        return;
    }

    if (text.startsWith('/setcooldown ')) {
        const secs = parseInt(text.slice('/setcooldown '.length).trim(), 10);
        if (!isNaN(secs) && secs >= 0) {
            db.setSetting('antiSpamCooldown', secs);
            db.forceSave();
            await sendToTelegram(`✅ Ограничение частоты ответов: *${secs} сек*`);
        }
        return;
    }

    if (text.startsWith('/resetai ')) {
        const num = text.slice('/resetai '.length).trim();
        if (waModule) resetAIHistory(waModule.toWAJid(num));
        await sendToTelegram(`🔄 Память ИИ для *+${num}* стерта.`);
        return;
    }

    if (text.startsWith('/stat ')) {
        const num = text.slice('/stat '.length).trim().replace(/\D/g, '');
        const c = db.getContact(num);
        if (!c) {
            await sendToTelegram(`❓ Контакт *+${num}* ни разу не писал боту.`);
        } else {
            const hasReply = (waModule && db.getCustomReply(waModule.toWAJid(num))) ? '✅' : '❌';
            const hasPrompt = (waModule && db.getCustomPrompt(waModule.toWAJid(num))) ? '✅' : '❌';
            await sendToTelegram(
                `👤 *Досье на +${num}*\n` +
                `📛 Имя WA: ${c.name || '—'}\n` +
                `📨 Написал сообщений: *${c.count}*\n` +
                `🕐 Первый контакт: ${c.firstSeen}\n` +
                `🕑 Последний контакт: ${c.lastSeen}\n` +
                `💬 Что написал:\n_${c.lastMsg || '—'}_\n\n` +
                `📌 Свой ответ: ${hasReply}\n` +
                `🧠 Свое правило ИИ: ${hasPrompt}`
            );
        }
        return;
    }

    if (text === '/top') {
        const contacts = db.getAllContacts();
        const sorted = Object.entries(contacts).sort(([, a], [, b]) => b.count - a.count).slice(0, 10);
        if (sorted.length === 0) {
            await sendToTelegram('📭 База контактов пока пуста.');
        } else {
            const lines = sorted.map(([num, c], i) => `${i + 1}. *${c.name || '+' + num}* — ${c.count} сообщ.\n   _${c.lastSeen}_`);
            await sendToTelegram(`📊 *Самые общительные:*\n\n` + lines.join('\n\n'));
        }
        return;
    }

    if (text.startsWith('/send ') && waModule) {
        const m = text.match(/^\/send\s+(\d+)\s+(.+)$/s);
        if (m) {
            try {
                await waModule.enqueueWA(() => waModule.sock.sendMessage(waModule.toWAJid(m[1]), { text: m[2] }));
                await sendToTelegram(`✅ Сообщение доставлено на *+${m[1]}*`);
                db.incStat('manual_sends');
            } catch (e) {
                await sendToTelegram(`❌ Ошибка отправки: ${e.message}`);
            }
        }
        return;
    }

    // Ответ на пересланное сообщение из WA
    if (tgMsg.reply_to_message && waModule) {
        const refText = tgMsg.reply_to_message.text || tgMsg.reply_to_message.caption || '';
        const waMatch = refText.match(/WA_ID:\s*([0-9]+@s\.whatsapp\.net)/);
        if (waMatch) {
            const waJid = waMatch[1];
            try {
                if (tgMsg.photo) {
                    const fileLink = await tgBot.getFileLink(tgMsg.photo[tgMsg.photo.length - 1].file_id);
                    const res = await fetch(fileLink);
                    const buffer = Buffer.from(await res.arrayBuffer());
                    await waModule.enqueueWA(() => waModule.sock.sendMessage(waJid, { image: buffer, caption: tgMsg.caption || '' }));
                } else if (tgMsg.video) {
                    const fileLink = await tgBot.getFileLink(tgMsg.video.file_id);
                    const res = await fetch(fileLink);
                    const buffer = Buffer.from(await res.arrayBuffer());
                    await waModule.enqueueWA(() => waModule.sock.sendMessage(waJid, { video: buffer, caption: tgMsg.caption || '' }));
                } else if (tgMsg.document) {
                    const fileLink = await tgBot.getFileLink(tgMsg.document.file_id);
                    const res = await fetch(fileLink);
                    const buffer = Buffer.from(await res.arrayBuffer());
                    await waModule.enqueueWA(() => waModule.sock.sendMessage(waJid, { document: buffer, mimetype: tgMsg.document.mime_type, fileName: tgMsg.document.file_name || 'file' }));
                } else if (tgMsg.voice || tgMsg.audio) {
                    const fileLink = await tgBot.getFileLink((tgMsg.voice || tgMsg.audio).file_id);
                    const res = await fetch(fileLink);
                    const buffer = Buffer.from(await res.arrayBuffer());
                    await waModule.enqueueWA(() => waModule.sock.sendMessage(waJid, { audio: buffer, mimetype: 'audio/ogg; codecs=opus', ptt: true }));
                } else if (tgMsg.text) {
                    await waModule.enqueueWA(() => waModule.sock.sendMessage(waJid, { text: tgMsg.text }));
                }
                await tgBot.sendMessage(TG_CHAT_ID, '✅ Доставлено', { reply_to_message_id: tgMsg.message_id });
                db.incStat('bridge_sends');
            } catch (err) {
                await tgBot.sendMessage(TG_CHAT_ID, `❌ Ошибка моста: ${err.message}`, { reply_to_message_id: tgMsg.message_id });
            }
        }
    }
});

tgBot.on('callback_query', async (query) => {
    if (query.message.chat.id.toString() !== TG_CHAT_ID) return;
    const action = query.data;

    if (action.startsWith('toggle_')) {
        const key = action.replace('toggle_', '');
        if (key === 'aiEnabled' && !process.env.OPENROUTER_API_KEY) {
            await tgBot.answerCallbackQuery(query.id, { text: '❌ Нет OPENROUTER_API_KEY в .env', show_alert: true });
            return;
        }
        const s = db.toggleSetting(key);
        db.forceSave();
        await tgBot.editMessageReplyMarkup(getSettingsKeyboard(s).reply_markup, {
            chat_id: query.message.chat.id, message_id: query.message.message_id,
        });
        await tgBot.answerCallbackQuery(query.id, { text: '✅ Переключено' });
    }
    else if (action === 'sys_status') {
        const freeRAM = Math.round(os.freemem() / 1024 / 1024);
        const scriptRAM = Math.round(process.memoryUsage().rss / 1024 / 1024);
        const uptimeStr = `${Math.floor(process.uptime() / 3600)}ч ${Math.floor((process.uptime() % 3600) / 60)}м`;
        const qLen = waModule ? waModule.waQueue.length : 0;
        const stats = `💻 Baileys System\n🧠 Свободно RAM: ${freeRAM}MB\n📦 Бот съел: ${scriptRAM}MB\n🔥 Загрузка CPU: ${os.loadavg()[0].toFixed(2)}\n⏱ Аптайм: ${uptimeStr}\n📬 Очередь WA: ${qLen}`;
        await tgBot.answerCallbackQuery(query.id, { text: stats, show_alert: true });
    }
    else if (action === 'list_replies') {
        const r = db.listCustomReplies();
        if (!Object.keys(r).length) { await tgBot.answerCallbackQuery(query.id, { text: 'Пусто', show_alert: true }); }
        else { await sendToTelegram('📋 *Ответы:*\n' + Object.entries(r).map(([k,v]) => `+${k}: _${v.slice(0, 40)}_`).join('\n')); await tgBot.answerCallbackQuery(query.id); }
    }
    else if (action === 'list_prompts') {
        const p = db.listCustomPrompts();
        if (!Object.keys(p).length) { await tgBot.answerCallbackQuery(query.id, { text: 'Пусто', show_alert: true }); }
        else { await sendToTelegram('🧠 *Правила ИИ:*\n' + Object.entries(p).map(([k,v]) => `+${k}: _${v.slice(0, 60)}_`).join('\n')); await tgBot.answerCallbackQuery(query.id); }
    }
    else if (action === 'show_stats') {
        const s = db.getStats();
        const txt = '📈 *Использование:*\n' + (Object.keys(s).length ? Object.entries(s).map(([k, v]) => `• ${k}: *${v}*`).join('\n') : '_Пусто_');
        await tgBot.answerCallbackQuery(query.id, { text: txt.slice(0, 200), show_alert: true });
    }
    else if (action === 'show_logs') {
        const logs = db.data.logs.slice(-30).join('\n');
        await sendToTelegram(`\`\`\`\n${logs.slice(0, 3900)}\n\`\`\``);
        await tgBot.answerCallbackQuery(query.id);
    }
});

export default tgBot;
