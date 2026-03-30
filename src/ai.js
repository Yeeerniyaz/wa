import db from './db.js';

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;

// Кеш истории: jid → [{role, content}[]]
const aiConversations = new Map();

// Модели для fallback (от сильных бесплатным к быстрым)
const fallbackModels = [
    'meta-llama/llama-3.3-70b-instruct:free',
    'openrouter/free'
];

export async function generateAIResponse(senderName, activePrompt) {
    if (!OPENROUTER_API_KEY) return null;
    try {
        // Жесткая изоляция ИИ от реальных сообщений. Он больше не ведет диалогов.
        const sysInstruction = `Сен Ернияздың ботысың. Саған адамдармен сөйлесуге, олардың сұрақтарына (мысалы 2+2) жауап беруге ҚАТАҢ ТЫЙЫМ САЛЫНАДЫ. Сен тек мына ережені орындауың керек: "${activePrompt || ''}". Осы ереже бойынша ғана қысқа жауап бер.`;

        // ВМЕСТО реального текста сообщения передаем заглушку
        const blindMessage = `[Бұл автоматты триггер. Маған ешқандай сұраққа жауап берме, тек өзіңе берілген ережені (промпт) орындап, бір ғана қысқа жауап жаз.]`;

        // Больше никакой памяти (history). Автоответчику она вредит.
        const history = [
            { role: 'system', content: sysInstruction },
            { role: 'user', content: blindMessage }
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
