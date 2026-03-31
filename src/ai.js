import db from './db.js';

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;

// Кеш истории: senderName -> [{role, content}[]]
const aiConversations = new Map();

// Модели для fallback (от сильных бесплатным к быстрым)
const fallbackModels = [
    'openrouter/free'
];

export async function generateAIResponse(messageText, senderName, activePrompt) {
    if (!OPENROUTER_API_KEY) return null;
    try {
        // 1. Инициализируем историю диалога для конкретного собеседника
        if (!aiConversations.has(senderName)) {
            aiConversations.set(senderName, []);
        }
        const chatHistory = aiConversations.get(senderName);

        // 2. Железобетонный системный промпт (правило теперь в центре внимания)
        const sysInstruction = `Ты - это Ернияз. Имя твоего собеседника: ${senderName}. 
Твоя задача: прочитать сообщение собеседника и ответить ему СТРОГО В РАМКАХ заданного правила. Отвечай ОТ ПЕРВОГО ЛИЦА ("Я").

МОЁ ПРАВИЛО ДЛЯ ТВОЕГО ОТВЕТА: "${activePrompt || 'Просто скажи, что я занят'}"

ИНСТРУКЦИЯ: Сформулируй готовый текст ответа собеседнику ОТ МОЕГО ИМЕНИ (я). Переведи смысл правила на язык собеседника (если он пишет на казахском - отвечай на казахском, если на русском - на русском).
КАТЕГОРИЧЕСКИ ЗАПРЕЩЕНО отвечать на вопросы собеседника или решать его задачи, если это противоречит правилу.
Отвечай коротко и естественно, как живой человек в мессенджере. Никаких формальностей.`;

        const userTrigger = `ВХОДЯЩЕЕ СООБЩЕНИЕ ОТ СОБЕСЕДНИКА: "${messageText}"\n\nСГЕНЕРИРУЙ ТОЛЬКО ТЕКСТ ОТВЕТА (без кавычек):`;

        // 3. Собираем правильную структуру для API (Система -> История -> Текущий вопрос)
        const messages = [
            { role: 'system', content: sysInstruction },
            ...chatHistory, // Подмешиваем память предыдущих реплик
            { role: 'user', content: userTrigger }
        ];

        let aiText = 'Кешіріңіз, түсінбедім.';

        // 4. Запрос к нейросети
        for (const modelId of fallbackModels) {
            try {
                const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
                    method: 'POST',
                    headers: {
                        'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
                        'Content-Type': 'application/json',
                        'HTTP-Referer': 'https://github.com/Yeeerniyaz/wa',
                        'X-Title': 'WhatsApp Bot'
                    },
                    body: JSON.stringify({
                        model: modelId,
                        messages: messages,
                        temperature: 0.7,
                        max_tokens: 1024,
                    })
                });

                if (!response.ok) {
                    throw new Error(await response.text());
                }

                const data = await response.json();
                if (data.choices && data.choices[0]?.message?.content) {
                    aiText = data.choices[0].message.content.trim();
                    break; // Успешно получили ответ, выходим из цикла
                }
            } catch (err) {
                db.log(`⚠️ AI Warning (${modelId}): ${err.message}`);
                // Если ошибка (например, упал OpenRouter), идем к следующей модели в списке
            }
        }

        // 5. Сохраняем текущий обмен репликами в историю для будущих ответов
        chatHistory.push({ role: 'user', content: messageText });
        chatHistory.push({ role: 'assistant', content: aiText });
        
        // Ограничиваем глубину памяти (чтобы ИИ не забыл начальную инструкцию и не переполнил лимит токенов)
        if (chatHistory.length > 8) {
            chatHistory.splice(0, chatHistory.length - 8); 
        }

        db.incStat('ai_replies');
        return aiText;
    } catch (e) {
        db.log(`❌ AI ошибка (OpenRouter): ${e.message}`);
        return null;
    }
}

// Умная очистка истории по номеру телефона
export function resetAIHistory(identifier) {
    // Вытаскиваем только цифры из JID или принимаем senderName
    const searchKey = identifier.replace(/\D/g, ''); 
    for (const [key, value] of aiConversations.entries()) {
        if (key.includes(searchKey)) {
            aiConversations.delete(key);
            db.log(`🔄 Память ИИ для диалога с ${key} очищена.`);
        }
    }
}