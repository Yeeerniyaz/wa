import TelegramBot from 'node-telegram-bot-api';
import os from 'os';
import db from './db.js';
import { resetAIHistory } from './ai.js';

let waModule = null;
import('./whatsapp.js').then(m => waModule = m);

const TG_TOKEN = process.env.TG_TOKEN;
export const TG_CHAT_ID = process.env.TG_CHAT_ID;

if (!TG_TOKEN || !TG_CHAT_ID) {
    console.error('❌ КРИТИЧНО: TG_TOKEN и TG_CHAT_ID обязательны в .env');
    process.exit(1);
}

const tgBot = new TelegramBot(TG_TOKEN, { polling: true });

tgBot.setMyCommands([
    { command: '/menu', description: '🚀 Главное меню (Все кнопки)' },
    { command: '/top', description: '📊 Топ-10 активных чатов' }
]).catch(err => console.error('Ошибка меню Telegram:', err.message));

export const sendToTelegram = async (text, extra = {}) => {
    try {
        await tgBot.sendMessage(TG_CHAT_ID, text, { parse_mode: 'Markdown', ...extra });
    } catch (err) {
        console.error('❌ TG ошибка:', err.message);
    }
};

// ==========================================
// СИСТЕМА СОСТОЯНИЙ (WIZARD) И ПАРСЕРЫ
// ==========================================
const userStates = new Map();

const cancelKeyboard = {
    reply_markup: {
        inline_keyboard: [[{ text: '❌ Отмена', callback_data: 'cancel_action' }]]
    }
};

// Умный парсер времени (относительное "15м" и точное "14:30")
function parseTimeInput(input) {
    input = input.trim().toLowerCase();
    const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Almaty' }));
    let targetMs = 0;

    if (input.endsWith('m') || input.endsWith('м') || /^\+?\d+$/.test(input)) {
        const mins = parseInt(input.replace(/\D/g, ''), 10);
        if (isNaN(mins)) return null;
        targetMs = Date.now() + mins * 60000;
    } else if (input.includes(':')) {
        const [h, m] = input.split(':').map(Number);
        if (isNaN(h) || isNaN(m) || h < 0 || h > 23 || m < 0 || m > 59) return null;
        now.setHours(h, m, 0, 0);
        targetMs = now.getTime();
        if (targetMs <= Date.now()) targetMs += 86400000; // Если время прошло, ставим на завтра
    } else {
        return null;
    }
    return targetMs;
}

// ==========================================
// МЕНЮ (ГЛАВНОЕ И ПОДМЕНЮ)
// ==========================================
const getMainMenu = () => {
    const s = db.getSettings();
    return {
        reply_markup: {
            inline_keyboard: [
                [
                    { text: `${s.alwaysOnline ? '🟢' : '⚫'} Онлайн`, callback_data: 'toggle_alwaysOnline' },
                    { text: `${s.aiEnabled ? '🤖' : '⚫'} AI-Ответы`, callback_data: 'toggle_aiEnabled' },
                    { text: `${s.autoReplyUrgent ? '🚨' : '⚫'} Базовый`, callback_data: 'toggle_autoReplyUrgent' },
                ],
                [
                    { text: `${s.forwardMedia ? '🖼️' : '⚫'} Медиа`, callback_data: 'toggle_forwardMedia' },
                    { text: `${s.antiSpam ? '🛡️' : '⚫'} Антиспам`, callback_data: 'toggle_antiSpam' },
                ],
                // НОВЫЕ СУПЕРФУНКЦИИ v2.1
                [
                    { text: '🪄 Макросы (Словарь)', callback_data: 'menu_macros' },
                    { text: '⏰ Планировщик (Таймер)', callback_data: 'menu_schedule' },
                ],
                [
                    { text: '💬 Кастомные ответы', callback_data: 'menu_custom_replies' },
                    { text: '🧠 Настройки ИИ', callback_data: 'menu_ai_settings' },
                ],
                [
                    { text: '🛡️ Приватность (Доступ)', callback_data: 'menu_privacy' },
                    { text: '📤 Написать в WA', callback_data: 'ask_send_wa' },
                ],
                [
                    { text: '👤 Досье на контакт', callback_data: 'ask_stat' },
                    { text: '📊 Топ-10', callback_data: 'show_top' },
                ],
                [
                    { text: '💻 Инфо скрипта', callback_data: 'sys_status' },
                ],
            ],
        },
    };
};

const getPrivacyMenu = () => {
    const s = db.getSettings();
    const modes = {
        'all': '🟢 ВСЕМ',
        'contacts_only': '👤 Только моим Контактам',
        'unknown_only': '❓ Только Неизвестным',
        'whitelist_only': '🌟 Только VIP-списку',
        'none': '🔴 НИКОМУ (Игнор)'
    };
    const modeText = modes[s.replyAudience] || modes['all'];
    return {
        reply_markup: {
            inline_keyboard: [
                [{ text: `Ресурс: ${modeText}`, callback_data: 'cycle_audience' }],
                [{ text: '🌟 Белый список (VIP)', callback_data: 'menu_whitelist' }, { text: '🚫 Черный список', callback_data: 'menu_blacklist' }],
                [{ text: '🔙 Назад в меню', callback_data: 'back_to_menu' }]
            ]
        }
    };
};

const getWhitelistMenu = () => ({
    reply_markup: {
        inline_keyboard: [
            [{ text: '➕ Добавить VIP', callback_data: 'ask_whitelist_add' }, { text: '➖ Удалить VIP', callback_data: 'ask_whitelist_del' }],
            [{ text: '📋 Список VIP', callback_data: 'list_whitelist' }],
            [{ text: '🔙 Назад к Приватности', callback_data: 'menu_privacy' }]
        ]
    }
});

const getBlacklistMenu = () => ({
    reply_markup: {
        inline_keyboard: [
            [{ text: '➕ В Черный список', callback_data: 'ask_blacklist_add' }, { text: '➖ Убрать из ЧС', callback_data: 'ask_blacklist_del' }],
            [{ text: '📋 Показать ЧС', callback_data: 'list_blacklist' }],
            [{ text: '🔙 Назад к Приватности', callback_data: 'menu_privacy' }]
        ]
    }
});

const getMacrosMenu = () => ({
    reply_markup: {
        inline_keyboard: [
            [{ text: '➕ Добавить макрос', callback_data: 'ask_macro_add' }],
            [{ text: '➖ Удалить макрос', callback_data: 'ask_macro_del' }],
            [{ text: '📋 Список макросов', callback_data: 'list_macros' }],
            [{ text: '🔙 Назад в меню', callback_data: 'back_to_menu' }]
        ]
    }
});

const getScheduleMenu = () => ({
    reply_markup: {
        inline_keyboard: [
            [{ text: '➕ Запланировать сообщение', callback_data: 'ask_schedule_add' }],
            [{ text: '➖ Отменить отправку', callback_data: 'ask_schedule_del' }],
            [{ text: '📋 Очередь отправки', callback_data: 'list_schedule' }],
            [{ text: '🔙 Назад в меню', callback_data: 'back_to_menu' }]
        ]
    }
});

const getCustomRepliesMenu = () => ({
    reply_markup: {
        inline_keyboard: [
            [{ text: '⏱ Настроить Кулдаун', callback_data: 'ask_cooldown' }, { text: '💬 Базовый ответ', callback_data: 'ask_default_text' }],
            [{ text: '➕ Добавить', callback_data: 'ask_reply_add' }, { text: '➖ Удалить', callback_data: 'ask_reply_del' }],
            [{ text: '📋 Все ответы', callback_data: 'list_replies' }, { text: '🔙 Назад', callback_data: 'back_to_menu' }]
        ]
    }
});

const getAIMenu = () => ({
    reply_markup: {
        inline_keyboard: [
            [{ text: '🌍 ИИ для ВСЕХ (Шаблоны)', callback_data: 'show_ai_templates' }],
            [{ text: '🧠 Добавить правило', callback_data: 'ask_prompt_add' }, { text: '➖ Удалить правило', callback_data: 'ask_prompt_del' }],
            [{ text: '🔄 Сбросить память', callback_data: 'ask_ai_reset' }, { text: '📋 Все правила', callback_data: 'list_prompts' }],
            [{ text: '🔙 Назад в меню', callback_data: 'back_to_menu' }]
        ]
    }
});

const persistentKeyboard = {
    reply_markup: {
        keyboard: [[{ text: '🚀 Главное меню' }], [{ text: '📊 Топ-10 чатов' }, { text: '📱 Отправить в WA' }]],
        resize_keyboard: true,
        is_persistent: true
    }
};

// ==========================================
// ОБРАБОТЧИК ТЕКСТА (WIZARDS)
// ==========================================
tgBot.on('message', async (tgMsg) => {
    if (tgMsg.chat.id.toString() !== TG_CHAT_ID) return;
    const text = tgMsg.text || '';
    const state = userStates.get(TG_CHAT_ID);

    if (state && text && !text.startsWith('/') && !['🚀 Главное меню', '📊 Топ-10 чатов', '📱 Отправить в WA'].includes(text)) {
        
        // --- ПЛАНИРОВЩИК ---
        if (state.action === 'add_schedule_step1') {
            const num = text.replace(/\D/g, '');
            if (!num) return sendToTelegram('❌ Некорректный номер. Попробуй еще раз.', cancelKeyboard);
            userStates.set(TG_CHAT_ID, { action: 'add_schedule_step2', data: { num } });
            await sendToTelegram(`⏰ Номер *+${num}* принят.\n\nКогда отправить?\nНапиши точное время (например \`14:30\`) или через сколько минут (например \`15м\` или \`60\`):`, cancelKeyboard);
            return;
        }

        if (state.action === 'add_schedule_step2') {
            const targetMs = parseTimeInput(text);
            if (!targetMs) return sendToTelegram('❌ Не понял формат времени. Напиши `14:30` или `15м`:', cancelKeyboard);
            
            const num = state.data.num;
            userStates.set(TG_CHAT_ID, { action: 'add_schedule_step3', data: { num, targetMs } });
            const timeStr = new Date(targetMs).toLocaleString('ru-RU', { timeZone: 'Asia/Almaty' });
            await sendToTelegram(`✅ Время установлено на: *${timeStr}*\n\nТеперь отправь **текст сообщения**, которое нужно запланировать:`, cancelKeyboard);
            return;
        }

        if (state.action === 'add_schedule_step3') {
            const { num, targetMs } = state.data;
            const id = db.addScheduledMsg(num, text, targetMs);
            const timeStr = new Date(targetMs).toLocaleString('ru-RU', { timeZone: 'Asia/Almaty' });
            await sendToTelegram(`✅ Запланировано! [ID: \`${id}\`]\nСообщение будет отправлено на *+${num}* в *${timeStr}*.`);
            userStates.delete(TG_CHAT_ID);
            return;
        }

        if (state.action === 'del_schedule') {
            db.deleteScheduledMsg(text.trim());
            await sendToTelegram(`🗑 Если задача с таким ID существовала, она удалена из очереди.`);
            userStates.delete(TG_CHAT_ID);
            return;
        }

        // --- МАКРОСЫ ---
        if (state.action === 'add_macro_step1') {
            const shortCode = text.trim().toLowerCase();
            if (shortCode.includes(' ')) return sendToTelegram('❌ Короткий код должен быть без пробелов (например `!счет` или `здравствуйте`). Попробуй еще:', cancelKeyboard);
            userStates.set(TG_CHAT_ID, { action: 'add_macro_step2', data: { shortCode } });
            await sendToTelegram(`🪄 Код \`${shortCode}\` принят.\n\nТеперь отправь **полный текст**, на который бот будет его заменять:`, cancelKeyboard);
            return;
        }

        if (state.action === 'add_macro_step2') {
            const shortCode = state.data.shortCode;
            db.setMacro(shortCode, text);
            await sendToTelegram(`✅ Макрос сохранён!\nТеперь если ты напишешь \`${shortCode}\`, бот заменит его на эту простыню.`);
            userStates.delete(TG_CHAT_ID);
            return;
        }

        if (state.action === 'del_macro') {
            db.deleteMacro(text.trim());
            await sendToTelegram(`🗑 Макрос \`${text}\` удалён.`);
            userStates.delete(TG_CHAT_ID);
            return;
        }

        // --- ПРИВАТНОСТЬ И АУДИТОРИЯ ---
        if (state.action === 'add_whitelist') {
            const num = text.replace(/\D/g, '');
            if (!num) return sendToTelegram('❌ Ошибка. Жду номер:', cancelKeyboard);
            db.addWhitelist(num); sendToTelegram(`🌟 +${num} добавлен в VIP-список.`); userStates.delete(TG_CHAT_ID); return;
        }
        if (state.action === 'del_whitelist') {
            const num = text.replace(/\D/g, ''); db.remWhitelist(num); sendToTelegram(`🗑 +${num} удален из VIP-списка.`); userStates.delete(TG_CHAT_ID); return;
        }
        if (state.action === 'add_blacklist') {
            const num = text.replace(/\D/g, '');
            if (!num) return sendToTelegram('❌ Ошибка. Жду номер:', cancelKeyboard);
            db.addBlacklist(num); sendToTelegram(`🚫 +${num} отправлен в Черный список. Бот будет его игнорировать.`); userStates.delete(TG_CHAT_ID); return;
        }
        if (state.action === 'del_blacklist') {
            const num = text.replace(/\D/g, ''); db.remBlacklist(num); sendToTelegram(`♻️ +${num} вызволен из Черного списка.`); userStates.delete(TG_CHAT_ID); return;
        }

        // --- СТАРЫЕ СОСТОЯНИЯ ---
        if (state.action === 'set_cooldown') {
            const secs = parseInt(text, 10);
            if (!isNaN(secs) && secs >= 0) { db.setSetting('antiSpamCooldown', secs); db.forceSave(); sendToTelegram(`✅ Задержка: *${secs} сек*`); }
            userStates.delete(TG_CHAT_ID); return;
        }

        if (state.action === 'set_default_reply') {
            db.setSetting('defaultAutoReply', text); db.forceSave(); sendToTelegram('✅ Базовый текст обновлён!');
            userStates.delete(TG_CHAT_ID); return;
        }

        if (state.action === 'set_global_ai') {
            db.setSetting('globalAIPrompt', text); db.forceSave(); sendToTelegram(`✅ ИИ отвечает всем:\n_${text}_`);
            userStates.delete(TG_CHAT_ID); return;
        }

        if (state.action === 'add_reply_step1') {
            const num = text.replace(/\D/g, '');
            if (!num) return sendToTelegram('❌ Некорректный номер.', cancelKeyboard);
            userStates.set(TG_CHAT_ID, { action: 'add_reply_step2', data: { num } });
            const kb = {
                reply_markup: {
                    inline_keyboard: [
                        [{text:'👋 Привет, я занят',callback_data:`set_p_def_1_${num}`}, {text:'❤️ Люблю + Занят',callback_data:`set_p_def_2_${num}`}],
                        [{text:'💼 Официально',callback_data:`set_p_def_3_${num}`}, {text:'🤬 Игнор / Отказ',callback_data:`set_p_def_4_${num}`}],
                        [{text:'❌ Отмена', callback_data:'cancel_action'}]
                    ]
                }
            };
            await sendToTelegram(`📌 Отправь **свой текст ответа** для *+${num}* или выбери готовый:`, kb); return;
        }

        if (state.action === 'add_reply_step2') {
            db.setCustomReply(state.data.num, text); sendToTelegram(`✅ Ответ для *+${state.data.num}* сохранен.`);
            userStates.delete(TG_CHAT_ID); return;
        }

        if (state.action === 'del_reply') {
            db.deleteCustomReply(text.replace(/\D/g, '')); sendToTelegram(`🗑 Ответ удалён.`);
            userStates.delete(TG_CHAT_ID); return;
        }

        if (state.action === 'add_prompt_step1') {
            const num = text.replace(/\D/g, '');
            if (!num) return sendToTelegram('❌ Ошибка.', cancelKeyboard);
            userStates.set(TG_CHAT_ID, { action: 'add_prompt_step2', data: { num } });
            const kb = {
                reply_markup: {
                    inline_keyboard: [
                        [{text:'🤝 Бро (Друг)',callback_data:`set_p_ai_1_${num}`}, {text:'💼 Формально (Коллега)',callback_data:`set_p_ai_2_${num}`}],
                        [{text:'❤️ Романтика (Любовь)',callback_data:`set_p_ai_3_${num}`}, {text:'🙅‍♂️ Холодно (Отшивать)',callback_data:`set_p_ai_4_${num}`}],
                        [{text:'🇰🇿 Қазақша',callback_data:`set_p_ai_5_${num}`}, {text:'🤡 Гуль / Тролль',callback_data:`set_p_ai_6_${num}`}],
                        [{text:'❌ Отмена', callback_data:'cancel_action'}]
                    ]
                }
            };
            await sendToTelegram(`🧠 Отправь **свою инструкцию ИИ** для *+${num}* или выбери шаблон:`, kb); return;
        }

        if (state.action === 'add_prompt_step2') {
            db.setCustomPrompt(state.data.num, text);
            if (waModule) resetAIHistory(waModule.toWAJid(state.data.num));
            sendToTelegram(`✅ ИИ правило сохранено.`);
            userStates.delete(TG_CHAT_ID); return;
        }

        if (state.action === 'del_prompt') {
            const num = text.replace(/\D/g, '');
            db.deleteCustomPrompt(num);
            if (waModule) resetAIHistory(waModule.toWAJid(num));
            sendToTelegram(`🗑 Правило ИИ удалено.`);
            userStates.delete(TG_CHAT_ID); return;
        }

        if (state.action === 'reset_ai') {
            const num = text.replace(/\D/g, '');
            if (waModule) resetAIHistory(waModule.toWAJid(num));
            sendToTelegram(`🔄 Память ИИ стёрта.`);
            userStates.delete(TG_CHAT_ID); return;
        }

        if (state.action === 'send_wa_step1') {
            const num = text.replace(/\D/g, '');
            if (!num) return sendToTelegram('❌ Некорректный номер.', cancelKeyboard);
            userStates.set(TG_CHAT_ID, { action: 'send_wa_step2', data: { num } });
            await sendToTelegram(`📤 Введи **сообщение** для *+${num}*:`, cancelKeyboard); return;
        }

        if (state.action === 'send_wa_step2') {
            if (!waModule) return sendToTelegram('❌ Ядро WA еще грузится...');
            try {
                await waModule.enqueueWA(() => waModule.sendTypingAndMessage(waModule.toWAJid(state.data.num), { text }));
                sendToTelegram(`✅ Успешно доставлено!`); db.incStat('manual_sends');
            } catch (err) { sendToTelegram(`❌ Ошибка отправки: ${err.message}`); }
            userStates.delete(TG_CHAT_ID); return;
        }

        if (state.action === 'get_stat') {
            const num = text.replace(/\D/g, '');
            userStates.delete(TG_CHAT_ID);
            const c = db.getContact(num);
            if (!c) return sendToTelegram(`❓ Контакт *+${num}* ни разу не писал боту.`);
            const hasReply = (waModule && db.getCustomReply(waModule.toWAJid(num))) ? '✅' : '❌';
            const hasPrompt = (waModule && db.getCustomPrompt(waModule.toWAJid(num))) ? '✅' : '❌';
            await sendToTelegram(
                `👤 *Досье на +${num}*\n📛 Имя WA: ${c.name || '—'}\n📨 Сообщений: *${c.count}*\n🕐 Первый контакт: ${c.firstSeen}\n🕑 Последний: ${c.lastSeen}\n💬 Написал:\n_${c.lastMsg || '—'}_\n\n📌 Свой ответ: ${hasReply}\n🧠 Свое правило ИИ: ${hasPrompt}`
            );
            return;
        }
    }

    // --- БАЗОВЫЕ КОМАНДЫ ---
    if (text === '/start' || text === '/menu' || text === '🚀 Главное меню') {
        userStates.delete(TG_CHAT_ID);
        if (text === '/start') await tgBot.sendMessage(TG_CHAT_ID, '👋 Добро пожаловать!', persistentKeyboard);
        await tgBot.sendMessage(TG_CHAT_ID, '🚀 *ГЛАВНОЕ УПРАВЛЕНИЕ БОТОМ v2.1*\nВыберите категорию:', { parse_mode: 'Markdown', ...getMainMenu() });
        return;
    }

    if (text === '/top' || text === '📊 Топ-10 чатов') {
        userStates.delete(TG_CHAT_ID);
        const contacts = db.getAllContacts();
        const sorted = Object.entries(contacts).sort(([, a], [, b]) => b.count - a.count).slice(0, 10);
        if (sorted.length === 0) return sendToTelegram('📭 База пуста.');
        const lines = sorted.map(([num, c], i) => `${i + 1}. *${c.name || '+' + num}* — ${c.count} сообщ.\n   _${c.lastSeen}_`);
        await sendToTelegram(`📊 *Топ-10:*\n\n` + lines.join('\n\n')); return;
    }

    if (text === '📱 Отправить в WA') {
        userStates.set(TG_CHAT_ID, { action: 'send_wa_step1' });
        await sendToTelegram('📤 *Отправка*\nУкажите номер абонента:', cancelKeyboard); return;
    }

    // --- МОСТ TG -> WA ---
    if (tgMsg.reply_to_message && waModule) {
        const refText = tgMsg.reply_to_message.text || tgMsg.reply_to_message.caption || '';
        const waMatch = refText.match(/WA_ID:\s*([0-9]+@s\.whatsapp\.net)/);
        if (waMatch) {
            const waJid = waMatch[1];
            try {
                if (tgMsg.photo) {
                    const fileLink = await tgBot.getFileLink(tgMsg.photo[tgMsg.photo.length - 1].file_id);
                    const buffer = Buffer.from(await (await fetch(fileLink)).arrayBuffer());
                    await waModule.enqueueWA(() => waModule.sock.sendMessage(waJid, { image: buffer, caption: tgMsg.caption || '' }));
                } else if (tgMsg.video) {
                    const fileLink = await tgBot.getFileLink(tgMsg.video.file_id);
                    const buffer = Buffer.from(await (await fetch(fileLink)).arrayBuffer());
                    await waModule.enqueueWA(() => waModule.sock.sendMessage(waJid, { video: buffer, caption: tgMsg.caption || '' }));
                } else if (tgMsg.document) {
                    const fileLink = await tgBot.getFileLink(tgMsg.document.file_id);
                    const buffer = Buffer.from(await (await fetch(fileLink)).arrayBuffer());
                    await waModule.enqueueWA(() => waModule.sock.sendMessage(waJid, { document: buffer, mimetype: tgMsg.document.mime_type, fileName: tgMsg.document.file_name || 'file' }));
                } else if (tgMsg.voice || tgMsg.audio) {
                    const fileLink = await tgBot.getFileLink((tgMsg.voice || tgMsg.audio).file_id);
                    const buffer = Buffer.from(await (await fetch(fileLink)).arrayBuffer());
                    await waModule.enqueueWA(() => waModule.sock.sendMessage(waJid, { audio: buffer, mimetype: 'audio/ogg; codecs=opus', ptt: true }));
                } else if (tgMsg.text) {
                    await waModule.enqueueWA(() => waModule.sendTypingAndMessage(waJid, { text: tgMsg.text }));
                }
                await tgBot.sendMessage(TG_CHAT_ID, '✅ Доставлено', { reply_to_message_id: tgMsg.message_id });
                db.incStat('bridge_sends');
            } catch (err) { await tgBot.sendMessage(TG_CHAT_ID, `❌ Ошибка моста: ${err.message}`, { reply_to_message_id: tgMsg.message_id }); }
        }
    }
});

// ==========================================
// ОБРАБОТКА КНОПОК
// ==========================================
tgBot.on('callback_query', async (query) => {
    if (query.message.chat.id.toString() !== TG_CHAT_ID) return;
    const action = query.data;

    // --- НАВИГАЦИЯ МЕНЮ ---
    if (action === 'back_to_menu') {
        await tgBot.editMessageText('🚀 *ГЛАВНОЕ УПРАВЛЕНИЕ БОТОМ v2.1*\nВыберите категорию:', { chat_id: query.message.chat.id, message_id: query.message.message_id, parse_mode: 'Markdown', ...getMainMenu() }); return;
    }
    if (action === 'menu_macros') {
        await tgBot.editMessageText('🪄 *Управление Макросами*\nБот автоматически заменит твое короткое слово на длинный текст.', { chat_id: query.message.chat.id, message_id: query.message.message_id, parse_mode: 'Markdown', ...getMacrosMenu() }); return;
    }
    if (action === 'menu_schedule') {
        await tgBot.editMessageText('⏰ *Планировщик Сообщений*\nЗапланируй отправку сообщения на точное время или через таймер.', { chat_id: query.message.chat.id, message_id: query.message.message_id, parse_mode: 'Markdown', ...getScheduleMenu() }); return;
    }
    if (action === 'menu_custom_replies') {
        await tgBot.editMessageText('💬 *Базовые и Кастомные Ответы*\nНастройка поведения бота без ИИ.', { chat_id: query.message.chat.id, message_id: query.message.message_id, parse_mode: 'Markdown', ...getCustomRepliesMenu() }); return;
    }
    if (action === 'menu_ai_settings') {
        await tgBot.editMessageText('🧠 *Управление Искусственным Интеллектом*\nНастройка правил поведения нейросети.', { chat_id: query.message.chat.id, message_id: query.message.message_id, parse_mode: 'Markdown', ...getAIMenu() }); return;
    }

    if (action === 'cancel_action') {
        userStates.delete(TG_CHAT_ID);
        await tgBot.editMessageText('❌ Действие отменено.', { chat_id: query.message.chat.id, message_id: query.message.message_id }); return;
    }

    // --- ТУМБЛЕРЫ ---
    if (action.startsWith('toggle_')) {
        const key = action.replace('toggle_', '');
        db.toggleSetting(key); db.forceSave();
        await tgBot.editMessageReplyMarkup(getMainMenu().reply_markup, { chat_id: query.message.chat.id, message_id: query.message.message_id });
        await tgBot.answerCallbackQuery(query.id, { text: '✅ Переключено' }); return;
    }

    // --- АУДИТОРИЯ И ПРИВАТНОСТЬ ---
    if (action === 'cycle_audience') {
        const order = ['all', 'contacts_only', 'unknown_only', 'whitelist_only', 'none'];
        const current = db.getAudienceMode();
        const nextIndex = (order.indexOf(current) + 1) % order.length;
        db.setAudienceMode(order[nextIndex]);
        await tgBot.editMessageReplyMarkup(getPrivacyMenu().reply_markup, { chat_id: query.message.chat.id, message_id: query.message.message_id });
        await tgBot.answerCallbackQuery(query.id); return;
    }

    if (action === 'menu_privacy') {
        await tgBot.editMessageText('🛡️ *Управление Приватностью*\nНастрой, кому бот может отвечать, добавь людей в Черный список или перейди в Тихий Режим.', { chat_id: query.message.chat.id, message_id: query.message.message_id, parse_mode: 'Markdown', ...getPrivacyMenu() }); return;
    }
    if (action === 'menu_whitelist') {
        await tgBot.editMessageText('🌟 *VIP-список (Белый)*\nЭти люди получают Глобальные ответы даже в Режиме Тишины.', { chat_id: query.message.chat.id, message_id: query.message.message_id, parse_mode: 'Markdown', ...getWhitelistMenu() }); return;
    }
    if (action === 'menu_blacklist') {
        await tgBot.editMessageText('🚫 *Черный список (Игнор)*\nБот ВООБЩЕ не будет читать их сообщения и брать в статистику.', { chat_id: query.message.chat.id, message_id: query.message.message_id, parse_mode: 'Markdown', ...getBlacklistMenu() }); return;
    }
    
    // Кнопки ЧС / БС
    if (action === 'ask_whitelist_add') { userStates.set(TG_CHAT_ID, { action: 'add_whitelist' }); await sendToTelegram('🌟 Введи номер для добавления в VIP:', cancelKeyboard); tgBot.answerCallbackQuery(query.id); return; }
    if (action === 'ask_whitelist_del') { userStates.set(TG_CHAT_ID, { action: 'del_whitelist' }); await sendToTelegram('➖ Введи номер для удаления из VIP:', cancelKeyboard); tgBot.answerCallbackQuery(query.id); return; }
    if (action === 'list_whitelist') {
        const w = db.getWhitelist(); if (!w.length) return tgBot.answerCallbackQuery(query.id, { text: 'VIP пуст', show_alert: true });
        await sendToTelegram('🌟 *VIP-список:*\n' + w.map(n => `• +${n}`).join('\n')); tgBot.answerCallbackQuery(query.id); return;
    }
    
    if (action === 'ask_blacklist_add') { userStates.set(TG_CHAT_ID, { action: 'add_blacklist' }); await sendToTelegram('🚫 Введи номер для Черного списка:', cancelKeyboard); tgBot.answerCallbackQuery(query.id); return; }
    if (action === 'ask_blacklist_del') { userStates.set(TG_CHAT_ID, { action: 'del_blacklist' }); await sendToTelegram('➖ Введи номер для амнистии (удаление из ЧС):', cancelKeyboard); tgBot.answerCallbackQuery(query.id); return; }
    if (action === 'list_blacklist') {
        const b = db.getBlacklist(); if (!b.length) return tgBot.answerCallbackQuery(query.id, { text: 'ЧС пуст', show_alert: true });
        await sendToTelegram('🚫 *Черный список:*\n' + b.map(n => `• +${n}`).join('\n')); tgBot.answerCallbackQuery(query.id); return;
    }

    // --- КНОПКИ ПЛАНИРОВЩИКА ---
    if (action === 'ask_schedule_add') {
        userStates.set(TG_CHAT_ID, { action: 'add_schedule_step1' });
        await sendToTelegram('⏰ *Планировщик*\nКому отправим сообщение? Введи номер:', cancelKeyboard);
        await tgBot.answerCallbackQuery(query.id); return;
    }
    if (action === 'ask_schedule_del') {
        userStates.set(TG_CHAT_ID, { action: 'del_schedule' });
        await sendToTelegram('➖ Введи ID задачи для удаления (его можно посмотреть в списке очереди):', cancelKeyboard);
        await tgBot.answerCallbackQuery(query.id); return;
    }
    if (action === 'list_schedule') {
        const list = db.getAllScheduled();
        if (!list.length) { await tgBot.answerCallbackQuery(query.id, { text: 'Очередь пуста', show_alert: true }); return; }
        const txt = '📋 *Очередь отправки:*\n\n' + list.map(m => `🆔 \`${m.id}\`\n👤 +${m.jid}\n⏰ ${new Date(m.sendAt).toLocaleString('ru-RU', { timeZone: 'Asia/Almaty' })}\n💬 _${m.text.slice(0, 40)}_`).join('\n\n');
        await sendToTelegram(txt); await tgBot.answerCallbackQuery(query.id); return;
    }

    // --- КНОПКИ МАКРОСОВ ---
    if (action === 'ask_macro_add') {
        userStates.set(TG_CHAT_ID, { action: 'add_macro_step1' });
        await sendToTelegram('🪄 *Новый макрос*\nВведи короткое слово-триггер (например `!рек`):', cancelKeyboard);
        await tgBot.answerCallbackQuery(query.id); return;
    }
    if (action === 'ask_macro_del') {
        userStates.set(TG_CHAT_ID, { action: 'del_macro' });
        await sendToTelegram('➖ Введи слово-триггер для удаления макроса:', cancelKeyboard);
        await tgBot.answerCallbackQuery(query.id); return;
    }
    if (action === 'list_macros') {
        const m = db.getAllMacros();
        if (!Object.keys(m).length) { await tgBot.answerCallbackQuery(query.id, { text: 'Словарь пуст', show_alert: true }); return; }
        const txt = '📋 *Словарь макросов:*\n\n' + Object.entries(m).map(([k,v]) => `• \`${k}\` ➡️ _${v.slice(0, 60)}_`).join('\n\n');
        await sendToTelegram(txt); await tgBot.answerCallbackQuery(query.id); return;
    }

    // --- СТАРЫЕ ДЕЙСТВИЯ (Остались без изменений) ---
    if (action === 'ask_cooldown') { userStates.set(TG_CHAT_ID, { action: 'set_cooldown' }); sendToTelegram('⏱ Введите кулдаун (сек):', cancelKeyboard); tgBot.answerCallbackQuery(query.id); }
    else if (action === 'ask_default_text') { 
        userStates.set(TG_CHAT_ID, { action: 'set_default_reply' }); 
        const kb = {
            reply_markup: {
                inline_keyboard: [
                    [{text:'🚗 Я за рулем', callback_data:'set_def_tpl_1'}, {text:'😴 Я сплю', callback_data:'set_def_tpl_2'}],
                    [{text:'⏳ Занят, потом', callback_data:'set_def_tpl_3'}, {text:'📞 Позвоните', callback_data:'set_def_tpl_4'}],
                    [{text:'❌ Отмена', callback_data:'cancel_action'}]
                ]
            }
        };
        sendToTelegram('💬 Введите свой текст базового автоответа или выберите шаблон:', kb); 
        tgBot.answerCallbackQuery(query.id); 
    }
    else if (action === 'ask_reply_add') { userStates.set(TG_CHAT_ID, { action: 'add_reply_step1' }); sendToTelegram('📌 Введите номер абонента для автоответа:', cancelKeyboard); tgBot.answerCallbackQuery(query.id); }
    else if (action === 'ask_reply_del') { userStates.set(TG_CHAT_ID, { action: 'del_reply' }); sendToTelegram('➖ Введите номер для удаления автоответа:', cancelKeyboard); tgBot.answerCallbackQuery(query.id); }
    else if (action === 'list_replies') {
        const r = db.listCustomReplies();
        if (!Object.keys(r).length) tgBot.answerCallbackQuery(query.id, { text: 'Пусто', show_alert: true });
        else { sendToTelegram('📋 *Автоответы:*\n' + Object.entries(r).map(([k,v]) => `• +${k}: _${typeof v === 'string' ? v.slice(0, 40) : '[Сложное правило]'}_`).join('\n')); tgBot.answerCallbackQuery(query.id); }
    }
    else if (action === 'ask_prompt_add') { userStates.set(TG_CHAT_ID, { action: 'add_prompt_step1' }); sendToTelegram('🧠 Введите номер абонента для ИИ:', cancelKeyboard); tgBot.answerCallbackQuery(query.id); }
    else if (action === 'ask_prompt_del') { userStates.set(TG_CHAT_ID, { action: 'del_prompt' }); sendToTelegram('➖ Введите номер для удаления ИИ-правила:', cancelKeyboard); tgBot.answerCallbackQuery(query.id); }
    else if (action === 'list_prompts') {
        const p = db.listCustomPrompts();
        if (!Object.keys(p).length) tgBot.answerCallbackQuery(query.id, { text: 'Пусто', show_alert: true });
        else { sendToTelegram('🧠 *Правила ИИ:*\n' + Object.entries(p).map(([k,v]) => `• +${k}: _${v.slice(0, 60)}_`).join('\n')); tgBot.answerCallbackQuery(query.id); }
    }
    else if (action === 'ask_ai_reset') { userStates.set(TG_CHAT_ID, { action: 'reset_ai' }); sendToTelegram('🔄 Введите номер для очистки контекста ИИ:', cancelKeyboard); tgBot.answerCallbackQuery(query.id); }
    else if (action === 'show_ai_templates') {
        const tpl = { reply_markup: { inline_keyboard: [ 
            [{text:'🚗 За рулем',callback_data:'set_ai_template_1'}, {text:'😴 Сплю',callback_data:'set_ai_template_2'}], 
            [{text:'💼 Совещание',callback_data:'set_ai_template_3'}, {text:'🏋️‍♂️ В зале',callback_data:'set_ai_template_4'}],
            [{text:'🍽 На обеде',callback_data:'set_ai_template_5'}, {text:'🎮 Играю',callback_data:'set_ai_template_6'}],
            [{text:'👍 Соглашаться',callback_data:'set_ai_template_7'}, {text:'🙅‍♂️ Негатив',callback_data:'set_ai_template_8'}],
            [{text:'✏️ Свой текст',callback_data:'ask_global_ai'}], 
            [{text:'❌ Выключить ИИ для всех',callback_data:'disable_global_ai'}], 
            [{text:'🔙 Назад',callback_data:'menu_ai_settings'}] 
        ] } };
        tgBot.editMessageText(`🌍 *Глобальный ИИ*\nТекущий: _${db.getSettings().globalAIPrompt || 'Отключен'}_`, { chat_id: query.message.chat.id, message_id: query.message.message_id, parse_mode: 'Markdown', ...tpl });
    }
    else if (action.startsWith('set_ai_template_')) {
        const t = action.split('_')[3];
        const templates = {
            '1': 'Я сейчас за рулем и не могу печатать. Отвечу, как припаркуюсь.',
            '2': 'Я сейчас сплю и не вижу сообщений.',
            '3': 'У меня важное рабочее совещание, я очень занят.',
            '4': 'Я на жесткой тренировке в зале, перезвоню позже.',
            '5': 'Я кушаю, приятного мне аппетита. Не отвлекать.',
            '6': 'Я играю в соревновательную игру и потею, не могу говорить.',
            '7': 'Просто соглашайся со всем, что говорит собеседник, но коротко.',
            '8': 'Отвечай грубо, скажи что ты обиделся и не хочешь общаться.',
        };
        db.setSetting('globalAIPrompt', templates[t]); 
        db.forceSave(); 
        tgBot.answerCallbackQuery(query.id, {text:'Шаблон применен!'}); 
        tgBot.editMessageText(`✅ Глобальный шаблон применен!\n\nИИ теперь говорит: _${templates[t]}_`, { chat_id: query.message.chat.id, message_id: query.message.message_id, parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{text:'🔙 Назад',callback_data:'show_ai_templates'}]] } });
    }
    else if (action.startsWith('set_def_tpl_')) {
        const id = action.split('_')[3];
        const t = {
            '1': 'Я сейчас за рулем. Отвечу, как припаркуюсь.',
            '2': 'Я сейчас сплю. Прочитаю утром.',
            '3': 'Я сейчас очень занят. Отвечу позже.',
            '4': 'Я не могу сейчас писать. Пожалуйста, позвоните мне если срочно.'
        };
        db.setSetting('defaultAutoReply', t[id]); db.forceSave();
        tgBot.editMessageText(`✅ Базовый текст обновлён на:\n_${t[id]}_`, { chat_id: query.message.chat.id, message_id: query.message.message_id, parse_mode: 'Markdown' });
        userStates.delete(TG_CHAT_ID); tgBot.answerCallbackQuery(query.id);
    }
    else if (action.startsWith('set_p_ai_')) {
        const parts = action.split('_'); const id = parts[3]; const num = parts[4];
        const t = {
            '1': 'Это мой хороший друг. Общайся с ним тепло, дружелюбно, используй бро, братан. Соглашайся на встречи, кидай смешные реакции.',
            '2': 'Это коллега по работе. Общайся строго официально, по делу, без смайликов и эмоций. Коротко и ясно.',
            '3': 'Это моя любовь. Отвечай очень нежно, с любовью, используй много милых смайликов и сердечек.',
            '4': 'Это спамер или неприятный человек. Отвечай максимально холодно на "отвали", говори что не интересно, или просто переводи тему.',
            '5': 'Жауапты тек Қазақ тілінде қайтар. Өте әдепті және қысқа жауап бер.',
            '6': 'Отвечай на все сообщения постиронией, шути, используй сарказм, веди себя как аниме-псих, не давай прямых ответов.'
        };
        db.setCustomPrompt(num, t[id]); if (waModule) resetAIHistory(waModule.toWAJid(num));
        tgBot.editMessageText(`✅ ИИ правило для *+${num}* сохранено:\n_${t[id]}_`, { chat_id: query.message.chat.id, message_id: query.message.message_id, parse_mode: 'Markdown' });
        userStates.delete(TG_CHAT_ID); tgBot.answerCallbackQuery(query.id);
    }
    else if (action.startsWith('set_p_def_')) {
        const parts = action.split('_'); const id = parts[3]; const num = parts[4];
        const t = {
            '1': 'Привет! Я сейчас немного занят, напишу тебе чуть позже обязательно.',
            '2': 'Я тоже тебя очень сильно люблю! Скоро освобожусь и напишу 😘',
            '3': 'Здравствуйте. Я сейчас не могу ответить. Пожалуйста, напишите мне на рабочий номер или перезвоните позже.',
            '4': 'Пожалуйста, больше не пишите мне.'
        };
        db.setCustomReply(num, t[id]);
        tgBot.editMessageText(`✅ Ответ для *+${num}* сохранен:\n_${t[id]}_`, { chat_id: query.message.chat.id, message_id: query.message.message_id, parse_mode: 'Markdown' });
        userStates.delete(TG_CHAT_ID); tgBot.answerCallbackQuery(query.id);
    }
    else if (action === 'ask_global_ai') { userStates.set(TG_CHAT_ID, { action: 'set_global_ai' }); sendToTelegram('🌍 Введите глобальное правило ИИ:', cancelKeyboard); tgBot.answerCallbackQuery(query.id); }
    else if (action === 'disable_global_ai') { db.setSetting('globalAIPrompt', ''); db.forceSave(); tgBot.answerCallbackQuery(query.id, {text:'Отключено'}); }
    else if (action === 'ask_send_wa') { userStates.set(TG_CHAT_ID, { action: 'send_wa_step1' }); sendToTelegram('📤 Кому пишем? Введите номер:', cancelKeyboard); tgBot.answerCallbackQuery(query.id); }
    else if (action === 'ask_stat') { userStates.set(TG_CHAT_ID, { action: 'get_stat' }); sendToTelegram('👤 Введите номер для досье:', cancelKeyboard); tgBot.answerCallbackQuery(query.id); }
    else if (action === 'show_top') {
        const sorted = Object.entries(db.getAllContacts()).sort(([, a], [, b]) => b.count - a.count).slice(0, 10);
        if (!sorted.length) tgBot.answerCallbackQuery(query.id, { text: 'Пусто', show_alert: true });
        else { sendToTelegram(`📊 *Топ-10:*\n\n` + sorted.map(([num, c], i) => `${i + 1}. *${c.name || '+' + num}* — ${c.count} сообщ.`).join('\n\n')); tgBot.answerCallbackQuery(query.id); }
    }
    else if (action === 'sys_status') {
        const freeRAM = Math.round(os.freemem() / 1024 / 1024);
        const scriptRAM = Math.round(process.memoryUsage().rss / 1024 / 1024);
        const qLen = waModule ? waModule.waQueue.length : 0;
        tgBot.answerCallbackQuery(query.id, { text: `💻 Система\nСвободно: ${freeRAM}MB\nБот жрет: ${scriptRAM}MB\nОчередь: ${qLen}`, show_alert: true });
    }
});

export default tgBot;