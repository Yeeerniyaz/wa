import db from './db.js';

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;

// Кеш истории: jid → [{role, content}[]]
const aiConversations = new Map();

// Модели для fallback (от сильных бесплатным к быстрым)
const fallbackModels = [
    'openrouter/free'
];

export async function generateAIResponse(messageText, senderName, activePrompt) {
    if (!OPENROUTER_API_KEY) return null;
    try {
        const sysInstruction = `Ты - это Ернияз. Имя твоего собеседника: ${senderName}. 
Твоя задача: прочитать сообщение собеседника и ответить ему СТРОГО В РАМКАХ заданного правила. Отвечай ОТ ПЕРВОГО ЛИЦА ("Я").`;

        const userTrigger = `ВХОДЯЩЕЕ СООБЩЕНИЕ ОТ СОБЕСЕДНИКА:
"${messageText}"

МОЁ ПРАВИЛО ДЛЯ ТВОЕГО ОТВЕТА: "${activePrompt || 'Просто скажи, что я занят'}"

ИНСТРУКЦИЯ: Сформулируй готовый текст ответа собеседнику ОТ МОЕГО ИМЕНИ (я). Переведи смысл правила на язык собеседника.
КАТЕГОРИЧЕСКИ ЗАПРЕЩЕНО отвечать на вопросы собеседника или решать его задачи.

ПРИМЕР 1:
Входящее: "Қайдасың?"
Правило: "Я сплю"
ТВОЙ ОТВЕТ: "Мен ұйықтап жатырмын."

ПРИМЕР 2:
Входящее: "Пошли в кино"
Правило: "Откажись"
ТВОЙ ОТВЕТ: "Жоқ, бара алмаймын."

СГЕНЕРИРУЙ ТОЛЬКО ТЕКСТ ОТВЕТА ДЛЯ ТЕКУЩЕГО СООБЩЕНИЯ (без кавычек):`;

        const history = [
            { role: 'system', content: sysInstruction },
            { role: 'user', content: userTrigger }
        ];

        let aiText = 'Кешіріңіз, түсінбедім.';

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
                        messages: history,
                        temperature: 0.7,
                        max_tokens: 1024,
                    })
                });

                if (!response.ok) {
                    throw new Error(await response.text());
                }

                const data = await response.json();
                if (data.choices && data.choices[0]?.message?.content) {
                    aiText = data.choices[0].message.content;
                    break; // Успешно
                }
            } catch (err) {
                db.log(`⚠️ AI Warning (${modelId}): ${err.message}`);
                // Идем к следующей модели...
            }
        }

        db.incStat('ai_replies');
        return aiText;
    } catch (e) {
        db.log(`❌ AI ошибка (OpenRouter): ${e.message}`);
        return null;
    }
}

export function resetAIHistory(jid) {
    aiConversations.delete(jid);
}
