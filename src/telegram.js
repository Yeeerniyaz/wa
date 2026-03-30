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

// Установка системного синего меню (возле смайликов/скрепки)
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
// СИСТЕМА СОСТОЯНИЙ (WIZARD)
// ==========================================
const userStates = new Map(); // chat_id -> { step: 'ASK_NUMBER', action: 'set_reply', data: {} }

const cancelKeyboard = {
    reply_markup: {
        inline_keyboard: [[{ text: '❌ Отмена', callback_data: 'cancel_action' }]]
    }
};

const getMainMenu = () => {
    const s = db.getSettings();
    return {
        reply_markup: {
            inline_keyboard: [
                // 1 РЯД: Тумблеры
                [
                    { text: `${s.alwaysOnline ? '🟢' : '⚫'} Онлайн`, callback_data: 'toggle_alwaysOnline' },
                    { text: `${s.aiEnabled ? '🤖' : '⚫'} AI-Ответы`, callback_data: 'toggle_aiEnabled' },
                    { text: `${s.autoReplyUrgent ? '🚨' : '⚫'} Базовый`, callback_data: 'toggle_autoReplyUrgent' },
                ],
                [
                    { text: `${s.forwardMedia ? '🖼️' : '⚫'} Медиа`, callback_data: 'toggle_forwardMedia' },
                    { text: `${s.antiSpam ? '🛡️' : '⚫'} Антиспам`, callback_data: 'toggle_antiSpam' },
                ],
                // 2 РЯД: Настройки
                [
                    { text: '⏱ Настроить Кулдаун', callback_data: 'ask_cooldown' },
                    { text: '💬 Изменить Базовый ответ', callback_data: 'ask_default_text' },
                ],
                // 3 РЯД: Кастомные ответы
                [
                    { text: '➕ Добавить ответ', callback_data: 'ask_reply_add' },
                    { text: '➖ Удалить ответ', callback_data: 'ask_reply_del' },
                    { text: '📋 Все ответы', callback_data: 'list_replies' },
                ],
                // 4 РЯД: Умный ИИ
                [
                    { text: '🌍 ИИ для ВСЕХ (Шаблоны)', callback_data: 'show_ai_templates' },
                ],
                [
                    { text: '🧠 Добавить правило ИИ', callback_data: 'ask_prompt_add' },
                    { text: '➖ Удалить правило ИИ', callback_data: 'ask_prompt_del' },
                ],
                [
                    { text: '🔄 Сбросить память ИИ', callback_data: 'ask_ai_reset' },
                    { text: '🧠 Все правила ИИ', callback_data: 'list_prompts' },
                ],
                // 5 РЯД: Интерактивы
                [
                    { text: '📤 Написать в WA', callback_data: 'ask_send_wa' },
                    { text: '👤 Досье на контакт', callback_data: 'ask_stat' },
                ],
                // 6 РЯД: Статистика
                [
                    { text: '📊 Топ-10', callback_data: 'show_top' },
                    { text: '📈 Статистика бота', callback_data: 'show_stats' },
                ],
                [
                    { text: '💻 Инфо скрипта', callback_data: 'sys_status' },
                    { text: '📜 Логи консоли', callback_data: 'show_logs' },
                ],
            ],
        },
    };
};

// Постоянная нижняя клавиатура (вместо букв)
const persistentKeyboard = {
    reply_markup: {
        keyboard: [
            [{ text: '🚀 Главное меню' }],
            [{ text: '📊 Топ-10 чатов' }, { text: '📱 Отправить в WA' }]
        ],
        resize_keyboard: true,
        is_persistent: true
    }
};

tgBot.on('message', async (tgMsg) => {
    if (tgMsg.chat.id.toString() !== TG_CHAT_ID) return;
    const text = tgMsg.text || '';
    const state = userStates.get(TG_CHAT_ID);

    // Если мы ждём ввода от пользователя
    if (state && text && !text.startsWith('/') && !text.startsWith('🚀') && !text.startsWith('📊') && !text.startsWith('📱')) {
        if (state.action === 'set_cooldown') {
            const secs = parseInt(text, 10);
            if (!isNaN(secs) && secs >= 0) {
                db.setSetting('antiSpamCooldown', secs);
                db.forceSave();
                await sendToTelegram(`✅ Задержка антиспама установлена на *${secs} сек*`);
            } else {
                await sendToTelegram('❌ Ошибка: нужно ввести число. Операция отменена.');
            }
            userStates.delete(TG_CHAT_ID);
            return;
        }

        if (state.action === 'set_default_reply') {
            db.setSetting('defaultAutoReply', text);
            db.forceSave();
            await sendToTelegram('✅ Базовый текст автоответа успешно обновлён!');
            userStates.delete(TG_CHAT_ID);
            return;
        }

        if (state.action === 'set_global_ai') {
            db.setSetting('globalAIPrompt', text);
            db.forceSave();
            await sendToTelegram(`✅ Отлично! Теперь ИИ отвечает всем по правилу:\n_${text}_`);
            userStates.delete(TG_CHAT_ID);
            return;
        }

        if (state.action === 'add_reply_step1') {
            const num = text.replace(/\D/g, '');
            if (!num) return sendToTelegram('❌ Некорректный номер. Попробуй еще раз или нажми Отмена.', cancelKeyboard);
            userStates.set(TG_CHAT_ID, { action: 'add_reply_step2', data: { num } });
            await sendToTelegram(`📌 Номер *+${num}* принят.\n\nТеперь отправь **текст ответа**, который бот всегда будет ему отправлять:`, cancelKeyboard);
            return;
        }

        if (state.action === 'add_reply_step2') {
            const num = state.data.num;
            db.setCustomReply(num, text);
            db.forceSave();
            await sendToTelegram(`✅ Успешно! Теперь бот будет отвечать на номер *+${num}* текстом:\n_${text}_`);
            userStates.delete(TG_CHAT_ID);
            return;
        }

        if (state.action === 'del_reply') {
            const num = text.replace(/\D/g, '');
            db.deleteCustomReply(num);
            db.forceSave();
            await sendToTelegram(`🗑 Кастомный ответ для *+${num}* удалён.`);
            userStates.delete(TG_CHAT_ID);
            return;
        }

        if (state.action === 'add_prompt_step1') {
            const num = text.replace(/\D/g, '');
            if (!num) return sendToTelegram('❌ Некорректный номер. Попробуй еще раз.', cancelKeyboard);
            userStates.set(TG_CHAT_ID, { action: 'add_prompt_step2', data: { num } });
            await sendToTelegram(`🧠 Номер *+${num}* принят.\n\nТеперь отправь **инструкцию ИИ** (например: "Отвечай только как гангстер"):`, cancelKeyboard);
            return;
        }

        if (state.action === 'add_prompt_step2') {
            const num = state.data.num;
            db.setCustomPrompt(num, text);
            db.forceSave();
            if (waModule) resetAIHistory(waModule.toWAJid(num));
            await sendToTelegram(`✅ Успешно! ИИ теперь общается с *+${num}* по правилу:\n_${text}_`);
            userStates.delete(TG_CHAT_ID);
            return;
        }

        if (state.action === 'del_prompt') {
            const num = text.replace(/\D/g, '');
            db.deleteCustomPrompt(num);
            db.forceSave();
            if (waModule) resetAIHistory(waModule.toWAJid(num));
            await sendToTelegram(`🗑 Правило ИИ для *+${num}* удалено.`);
            userStates.delete(TG_CHAT_ID);
            return;
        }

        if (state.action === 'reset_ai') {
            const num = text.replace(/\D/g, '');
            if (waModule) resetAIHistory(waModule.toWAJid(num));
            await sendToTelegram(`🔄 Память ИИ для диалога с *+${num}* полностью стёрта. Он забыл контекст.`);
            userStates.delete(TG_CHAT_ID);
            return;
        }

        if (state.action === 'send_wa_step1') {
            const num = text.replace(/\D/g, '');
            if (!num) return sendToTelegram('❌ Некорректный номер. Попробуй еще раз.', cancelKeyboard);
            userStates.set(TG_CHAT_ID, { action: 'send_wa_step2', data: { num } });
            await sendToTelegram(`📤 Номер *+${num}* принят.\n\nТеперь введи **сообщение**, которое я отправлю ему от твоего имени в WA:`, cancelKeyboard);
            return;
        }

        if (state.action === 'send_wa_step2') {
            if (!waModule) return sendToTelegram('❌ Ядро WA еще грузится...');
            const num = state.data.num;
            try {
                await waModule.enqueueWA(() => waModule.sock.sendMessage(waModule.toWAJid(num), { text }));
                await sendToTelegram(`✅ Успешно доставлено абоненту *+${num}*!`);
                db.incStat('manual_sends');
            } catch (err) {
                await sendToTelegram(`❌ Ошибка отправки: ${err.message}`);
            }
            userStates.delete(TG_CHAT_ID);
            return;
        }

        if (state.action === 'get_stat') {
            const num = text.replace(/\D/g, '');
            userStates.delete(TG_CHAT_ID);
            const c = db.getContact(num);
            if (!c) {
                return sendToTelegram(`❓ Контакт *+${num}* ни разу не писал боту.`);
            }
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
            return;
        }
    }

    if (text === '/start') {
        userStates.delete(TG_CHAT_ID);
        await tgBot.sendMessage(TG_CHAT_ID, '👋 Добро пожаловать! Нижняя клавиатура активирована.', persistentKeyboard);
        await tgBot.sendMessage(TG_CHAT_ID, '🚀 *ГЛАВНОЕ УПРАВЛЕНИЕ БОТОМ*\nВыберите действие:', { parse_mode: 'Markdown', ...getMainMenu() });
        return;
    }

    if (text === '/menu' || text === '🚀 Главное меню') {
        userStates.delete(TG_CHAT_ID); // Сбрасываем любые зависшие состояния при вызове меню
        await tgBot.sendMessage(TG_CHAT_ID, '🚀 *ГЛАВНОЕ УПРАВЛЕНИЕ БОТОМ*\nВыберите действие из меню кнопок ниже:', { parse_mode: 'Markdown', ...getMainMenu() });
        return;
    }

    if (text === '/top' || text === '📊 Топ-10 чатов') {
        userStates.delete(TG_CHAT_ID);
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

    if (text === '📱 Отправить в WA') {
        userStates.set(TG_CHAT_ID, { action: 'send_wa_step1' });
        await sendToTelegram('📤 *Сообщение через бота*\nШаг 1: Кому пишем? Укажите номер:', cancelKeyboard);
        return;
    }

    // Ответ на форвардное сообщение
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
                await tgBot.sendMessage(TG_CHAT_ID, '✅ Доставлено в WA', { reply_to_message_id: tgMsg.message_id });
                db.incStat('bridge_sends');
            } catch (err) {
                await tgBot.sendMessage(TG_CHAT_ID, `❌ Ошибка моста: ${err.message}`, { reply_to_message_id: tgMsg.message_id });
            }
        }
    }
});

// Обработка кнопок
tgBot.on('callback_query', async (query) => {
    if (query.message.chat.id.toString() !== TG_CHAT_ID) return;
    const action = query.data;

    if (action === 'cancel_action') {
        userStates.delete(TG_CHAT_ID);
        await tgBot.editMessageText('❌ Действие отменено.', { chat_id: query.message.chat.id, message_id: query.message.message_id });
        return;
    }

    if (action.startsWith('toggle_')) {
        const key = action.replace('toggle_', '');
        if (key === 'aiEnabled' && !process.env.OPENROUTER_API_KEY) {
            await tgBot.answerCallbackQuery(query.id, { text: '❌ Нет OPENROUTER_API_KEY в .env', show_alert: true });
            return;
        }
        db.toggleSetting(key);
        db.forceSave();
        await tgBot.editMessageReplyMarkup(getMainMenu().reply_markup, { chat_id: query.message.chat.id, message_id: query.message.message_id });
        await tgBot.answerCallbackQuery(query.id, { text: '✅ Настройка переключена' });
        return;
    }

    if (action === 'ask_cooldown') {
        userStates.set(TG_CHAT_ID, { action: 'set_cooldown' });
        await sendToTelegram('⏱ *Антиспам*\nВведите количество секунд (например: 60), в течение которых бот будет молчать после ответа контакту:', cancelKeyboard);
        await tgBot.answerCallbackQuery(query.id);
    }
    
    else if (action === 'ask_default_text') {
        userStates.set(TG_CHAT_ID, { action: 'set_default_reply' });
        await sendToTelegram('💬 Введите новый *базовый ответ*, который бот будет отправлять всем, если ИИ отключен:', cancelKeyboard);
        await tgBot.answerCallbackQuery(query.id);
    }
    
    else if (action === 'ask_reply_add') {
        userStates.set(TG_CHAT_ID, { action: 'add_reply_step1' });
        await sendToTelegram('📌 *Добавление кастомного ответа*\nШаг 1: Введите номер телефона абонента в любом формате (например 77012345678):', cancelKeyboard);
        await tgBot.answerCallbackQuery(query.id);
    }
    
    else if (action === 'ask_reply_del') {
        userStates.set(TG_CHAT_ID, { action: 'del_reply' });
        await sendToTelegram('➖ Введите номер абонента для удаления его кастомного ответа:', cancelKeyboard);
        await tgBot.answerCallbackQuery(query.id);
    }
    
    else if (action === 'ask_prompt_add') {
        userStates.set(TG_CHAT_ID, { action: 'add_prompt_step1' });
        await sendToTelegram('🧠 *Добавление правила ИИ*\nШаг 1: Введите номер телефона абонента (например 77012345678):', cancelKeyboard);
        await tgBot.answerCallbackQuery(query.id);
    }
    
    else if (action === 'ask_prompt_del') {
        userStates.set(TG_CHAT_ID, { action: 'del_prompt' });
        await sendToTelegram('➖ Введите номер абонента для удаления его индивидуального правила ИИ:', cancelKeyboard);
        await tgBot.answerCallbackQuery(query.id);
    }

    else if (action === 'show_ai_templates') {
        const templatesMarkup = {
            reply_markup: {
                inline_keyboard: [
                    [{ text: '🚗 За рулём', callback_data: 'set_ai_template_1' }],
                    [{ text: '😴 Сплю', callback_data: 'set_ai_template_2' }],
                    [{ text: '👍 Соглашаться со всем', callback_data: 'set_ai_template_3' }],
                    [{ text: '💼 На совещании', callback_data: 'set_ai_template_4' }],
                    [{ text: '✏️ Свой текст для всех', callback_data: 'ask_global_ai' }],
                    [{ text: '❌ Выключить ИИ для всех', callback_data: 'disable_global_ai' }],
                    [{ text: '🔙 Назад', callback_data: 'back_to_menu' }]
                ]
            }
        };
        const currentGlobal = db.getSettings().globalAIPrompt || 'Отключен (ИИ отвечает только по личным правилам)';
        await tgBot.editMessageText(`🌍 *Глобальное поведение ИИ*\nТекущий режим для всех: _${currentGlobal}_\n\nВыберите готовый шаблон или напишите свой:`, {
            chat_id: query.message.chat.id,
            message_id: query.message.message_id,
            parse_mode: 'Markdown',
            ...templatesMarkup
        });
        return;
    }

    else if (action.startsWith('set_ai_template_')) {
        const t = action.split('_')[3];
        let p = '';
        if (t === '1') p = 'Скажи, что я веду машину и отвечу позже.';
        if (t === '2') p = 'Скажи, что я сейчас сплю.';
        if (t === '3') p = 'Соглашайся со всем, что скажет собеседник, но отвечай очень коротко.';
        if (t === '4') p = 'Скажи, что я на совещании по работе.';
        
        db.setSetting('globalAIPrompt', p);
        db.forceSave();
        await tgBot.answerCallbackQuery(query.id, { text: '✅ Глобальный шаблон применен!' });
        await tgBot.editMessageText(`✅ *Успешно!*\nИИ теперь отвечает всем: _${p}_`, {
            chat_id: query.message.chat.id,
            message_id: query.message.message_id,
            parse_mode: 'Markdown',
            reply_markup: { inline_keyboard: [[{ text: '🔙 Назад', callback_data: 'back_to_menu' }]] }
        });
        return;
    }

    else if (action === 'ask_global_ai') {
        userStates.set(TG_CHAT_ID, { action: 'set_global_ai' });
        await sendToTelegram('🌍 *Свой глобальный промпт*\nНапишите инструкцию для ИИ, которая будет применяться ко ВСЕМ контактам (если у них нет личного правила):', cancelKeyboard);
        await tgBot.answerCallbackQuery(query.id);
    }

    else if (action === 'disable_global_ai') {
        db.setSetting('globalAIPrompt', '');
        db.forceSave();
        await tgBot.answerCallbackQuery(query.id, { text: '❌ Глобальный ИИ отключен' });
        await tgBot.editMessageText(`✅ *Глобальный ИИ отключен.*\nТеперь нейросеть будет отвечать только тем контактам, для которых задано личное правило. Всем остальным улетит базовый ответ.`, {
            chat_id: query.message.chat.id,
            message_id: query.message.message_id,
            parse_mode: 'Markdown',
            reply_markup: { inline_keyboard: [[{ text: '🔙 Назад', callback_data: 'back_to_menu' }]] }
        });
        return;
    }

    else if (action === 'back_to_menu') {
        await tgBot.editMessageText('🚀 *ГЛАВНОЕ УПРАВЛЕНИЕ БОТОМ*\nВыберите действие из меню кнопок ниже:', {
            chat_id: query.message.chat.id,
            message_id: query.message.message_id,
            parse_mode: 'Markdown',
            ...getMainMenu()
        });
        return;
    }

    else if (action === 'ask_ai_reset') {
        userStates.set(TG_CHAT_ID, { action: 'reset_ai' });
        await sendToTelegram('🔄 Введите номер абонента, чтобы стереть память контекста ИИ для его диалога:', cancelKeyboard);
        await tgBot.answerCallbackQuery(query.id);
    }

    else if (action === 'ask_send_wa') {
        userStates.set(TG_CHAT_ID, { action: 'send_wa_step1' });
        await sendToTelegram('📤 *Сообщение через бота*\nШаг 1: Кому пишем? Укажите номер:', cancelKeyboard);
        await tgBot.answerCallbackQuery(query.id);
    }

    else if (action === 'ask_stat') {
        userStates.set(TG_CHAT_ID, { action: 'get_stat' });
        await sendToTelegram('👤 Поиск досье на абонента.\nВведите его номер телефона:', cancelKeyboard);
        await tgBot.answerCallbackQuery(query.id);
    }

    else if (action === 'show_top') {
        const contacts = db.getAllContacts();
        const sorted = Object.entries(contacts).sort(([, a], [, b]) => b.count - a.count).slice(0, 10);
        if (sorted.length === 0) { await tgBot.answerCallbackQuery(query.id, { text: 'Пусто', show_alert: true }); }
        else {
            const lines = sorted.map(([num, c], i) => `${i + 1}. *${c.name || '+' + num}* — ${c.count} сообщ.\n   _${c.lastSeen}_`);
            await sendToTelegram(`📊 *Топ-10 болтунов:*\n\n` + lines.join('\n\n'));
            await tgBot.answerCallbackQuery(query.id);
        }
    }

    else if (action === 'sys_status') {
        const freeRAM = Math.round(os.freemem() / 1024 / 1024);
        const scriptRAM = Math.round(process.memoryUsage().rss / 1024 / 1024);
        const uptimeStr = `${Math.floor(process.uptime() / 3600)}ч ${Math.floor((process.uptime() % 3600) / 60)}м`;
        const qLen = waModule ? waModule.waQueue.length : 0;
        const stats = `💻 Baileys System\n🧠 Свободно RAM: ${freeRAM}MB\n📦 Бот работает на: ${scriptRAM}MB\n🔥 CPU: ${os.loadavg()[0].toFixed(2)}\n⏱ Аптайм: ${uptimeStr}\n📬 Очередь отправки WA: ${qLen}`;
        await tgBot.answerCallbackQuery(query.id, { text: stats, show_alert: true });
    }

    else if (action === 'list_replies') {
        const r = db.listCustomReplies();
        if (!Object.keys(r).length) { await tgBot.answerCallbackQuery(query.id, { text: 'Нет записей', show_alert: true }); }
        else { await sendToTelegram('📋 *Все ваши кастомные ответы:*\n\n' + Object.entries(r).map(([k,v]) => `• +${k}: _${v.slice(0, 80)}_`).join('\n\n')); await tgBot.answerCallbackQuery(query.id); }
    }

    else if (action === 'list_prompts') {
        const p = db.listCustomPrompts();
        if (!Object.keys(p).length) { await tgBot.answerCallbackQuery(query.id, { text: 'Нет записей', show_alert: true }); }
        else { await sendToTelegram('🧠 *Все индивидуальные правила ИИ:*\n\n' + Object.entries(p).map(([k,v]) => `• +${k}: _${v.slice(0, 80)}_`).join('\n\n')); await tgBot.answerCallbackQuery(query.id); }
    }

    else if (action === 'show_stats') {
        const s = db.getStats();
        const txt = '📈 *Статистика расхода:*\n' + (Object.keys(s).length ? Object.entries(s).map(([k, v]) => `• ${k}: *${v}*`).join('\n') : '_Пусто_');
        await tgBot.answerCallbackQuery(query.id, { text: txt.slice(0, 300), show_alert: true });
    }

    else if (action === 'show_logs') {
        const logs = db.data.logs.slice(-30).join('\n');
        await sendToTelegram(`\`\`\`\n${logs.slice(0, 3900)}\n\`\`\``);
        await tgBot.answerCallbackQuery(query.id);
    }
});

export default tgBot;
