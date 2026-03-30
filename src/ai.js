import db from './db.js';

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;

// Кеш истории: jid → [{role, content}[]]
const aiConversations = new Map();

// Модели для fallback (от сильных бесплатным к быстрым)
const fallbackModels = [
    'qwen/qwen-2.5-72b-instruct:free',
    'meta-llama/llama-3.3-70b-instruct:free',
    'mistralai/mistral-7b-instruct:free',
    'google/gemma-2-9b-it:free'
];

export async function generateAIResponse(messageText, senderName, jid) {
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
        // Обновляем системный промпт
        history[0].content = sysInstruction;
        history.push({ role: 'user', content: messageText });

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

        history.push({ role: 'assistant', content: aiText });

        // Ограничиваем историю 15 репликами
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

export function resetAIHistory(jid) {
    aiConversations.delete(jid);
}
