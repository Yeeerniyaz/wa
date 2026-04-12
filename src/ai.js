import db from './db.js';

const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY;

// Кеш истории: senderName -> [{role, content}[]]
const aiConversations = new Map();

// DeepSeek модели (можно выбирать разные модели)
const DEEPSEEK_MODELS = [
    'deepseek-chat',      // Основная модель
    'deepseek-reasoner'   // Более умная модель (если доступна)
];

export async function generateAIResponse(messageText, senderName, activePrompt) {
    if (!DEEPSEEK_API_KEY) {
        db.log(`❌ Ошибка ИИ: Отсутствует DEEPSEEK_API_KEY!`);
        return '⚠️ *[Системная Ошибка Bots]* Не настроен API ключ DeepSeek. Проверьте файл .env!';
    }
    
    try {
        // 1. Инициализируем историю диалога для конкретного собеседника
        if (!aiConversations.has(senderName)) {
            aiConversations.set(senderName, []);
        }
        const chatHistory = aiConversations.get(senderName);

        // 2. Оптимизированный промпт для DeepSeek
        const sysInstruction = `Ты - это Ернияз. Имя собеседника: ${senderName}.

МОЁ ПРАВИЛО ОТВЕТА: "${activePrompt || 'Просто дурачься и подкалывай, шути если к месту, но ничего не соглашайся и не решай'}"

ВАЖНО:
1. Отвечай ОТ ПЕРВОГО ЛИЦА ("Я", "меня", "мне")
2. Строго следуй правилу выше
3. Если собеседник пишет на казахском - отвечай на казахском, на русском - на русском
4. Будь коротким и естественным, как в мессенджере
5. НИКОГДА не соглашайся с собеседником полностью, всегда выражай сомнение или шути
6. НИКОГДА не решай задачи собеседника, не давай полезных советов
7. Поддержи диалог, но дурачься, подкалывай собеседника, шути если уместно
8. Будь немного саркастичным, но дружелюбным
9. Можно использовать имя собеседника для обращения
10. Если собеседник задает серьезный вопрос - отвечай шуткой или меняй тему
11. Не предлагай помощь, не бери на себя обязательства
12. Используй историю диалога для контекста, чтобы шутки были уместными
13. Будь остроумным, игривым, но не злым

История диалога (последние сообщения):
${chatHistory.slice(-4).map(m => `${m.role === 'user' ? 'Собеседник' : 'Ты'}: ${m.content}`).join('\n')}

Сейчас собеседник написал: "${messageText}"

Ответь от моего имени, следуя правилу:`;

        // 3. Собираем структуру для API DeepSeek
        const messages = [
            { role: 'system', content: sysInstruction },
            ...chatHistory, // Подмешиваем память предыдущих реплик
            { role: 'user', content: `Ответь на сообщение: "${messageText}"` }
        ];

        let aiText = '';
        let lastError = '';

        // 4. Запрос к DeepSeek API
        for (const modelId of DEEPSEEK_MODELS) {
            try {
                const response = await fetch('https://api.deepseek.com/v1/chat/completions', {
                    method: 'POST',
                    headers: {
                        'Authorization': `Bearer ${DEEPSEEK_API_KEY}`,
                        'Content-Type': 'application/json',
                        'Accept': 'application/json'
                    },
                    body: JSON.stringify({
                        model: modelId,
                        messages: messages,
                        temperature: 0.7,
                        max_tokens: 512, // Уменьшим немного для быстрых ответов
                        stream: false
                    })
                });

                if (!response.ok) {
                    const errorText = await response.text();
                    db.log(`⚠️ DeepSeek HTTP ${response.status}: ${errorText.slice(0, 100)}`);
                    // Пробуем следующую модель
                    continue;
                }

                const data = await response.json();
                if (data.choices && data.choices[0]?.message?.content) {
                    aiText = data.choices[0].message.content.trim();
                    break; // Успешно получили ответ, выходим из цикла
                }
            } catch (err) {
                lastError = err.message;
                db.log(`⚠️ DeepSeek Warning (${modelId}): ${err.message.slice(0, 100)}`);
                // Если ошибка сети, идем к следующей модели
            }
        }
        
        if (!aiText) {
            db.log(`❌ DeepSeek не ответил. Последняя ошибка: ${lastError.slice(0, 100)}`);
            return `🔌 *[Сбой нейросети]* DeepSeek недоступен. (${lastError.slice(0, 30)}...)`;
        }

        // 5. Сохраняем историю диалога
        chatHistory.push({ role: 'user', content: messageText });
        chatHistory.push({ role: 'assistant', content: aiText });
        
        // Ограничиваем глубину памяти
        if (chatHistory.length > 6) { // Немного меньше для экономии токенов
            chatHistory.splice(0, chatHistory.length - 6); 
        }

        db.incStat('ai_replies');
        return aiText;
    } catch (e) {
        db.log(`❌ DeepSeek Critical: ${e.message}`);
        return `💥 *[Критическая ошибка DeepSeek]* ${e.message}`;
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