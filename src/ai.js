import db from './db.js';

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;

// Кеш истории: jid → [{role, content}[]]
const aiConversations = new Map();

// Модели для fallback (от сильных бесплатным к быстрым)
const fallbackModels = [
    'meta-llama/llama-3.3-70b-instruct:free',
    'openrouter/free'
];

export async function generateAIResponse(messageText, senderName, activePrompt) {
    if (!OPENROUTER_API_KEY) return null;
    try {
        const sysInstruction = `Ты - интеллектуальный автоответчик Ернияза. Имя собеседника: ${senderName}. Твоя задача: прочитать его сообщение и ответить СТРОГО В РАМКАХ заданного правила.`;

        // Оборачиваем реальное сообщение в жесткие инструкции
        const userTrigger = `ВХОДЯЩЕЕ СООБЩЕНИЕ:\n"${messageText}"\n\nМОЁ ПРАВИЛО ДЛЯ ОТВЕТА: "${activePrompt || 'Просто скажи, что Ернияз занят'}". 
        
КАТЕГОРИЧЕСКИ ЗАПРЕЩЕНО:
1) Помогать собеседнику решать его задачи.
2) Отвечать на математические или логические вопросы (даже если 2+2).
3) Вести свободный диалог.

Просто вежливо и коротко сформулируй мой ответ (правило) с учетом его сообщения на его же языке.`;

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
