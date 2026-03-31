import fs from 'fs';
import path from 'path';

// Абсолютный путь к папке data, которая будет смонтирована в Docker
const DATA_DIR = path.join(process.cwd(), 'data');
const DB_FILE = path.join(DATA_DIR, 'database.json');
const LOG_FILE = path.join(DATA_DIR, 'bot.log');

// Убеждаемся, что папка существует
if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
}

const DEFAULT_SETTINGS = {
    alwaysOnline: true,
    autoReplyUrgent: true,
    forwardMedia: true,
    aiEnabled: false,
    defaultAutoReply: 'Ернияз қазір бос емес. Кейінірек жазады.',
    antiSpam: true,
    antiSpamCooldown: 60,
    globalAIPrompt: ''
};

class LocalDB {
    constructor() {
        this.data = this._init();
        this._dirty = false;

        setInterval(() => { if (this._dirty) { this._saveToDisk(); this._dirty = false; } }, 120_000);
        
        // Гарантированное сохранение при выходе
        process.on('SIGINT', () => { this._saveToDisk(); process.exit(); });
        process.on('SIGTERM', () => { this._saveToDisk(); process.exit(); });
    }

    _init() {
        const defaultData = () => ({
            logs: [], 
            customReplies: {}, 
            customAIPrompts: {},
            stats: {}, 
            contacts: {}, 
            settings: { ...DEFAULT_SETTINGS },
            // Новые сущности для продвинутого функционала v2.1
            macros: {}, 
            scheduled: [] 
        });

        if (!fs.existsSync(DB_FILE)) {
            const d = defaultData();
            fs.writeFileSync(DB_FILE, JSON.stringify(d, null, 2));
            console.log('📁 БД data/database.json создана с нуля.');
            return d;
        }

        try {
            const raw = fs.readFileSync(DB_FILE, 'utf8').trim();
            if (!raw) throw new Error('Пустой файл');
            const d = JSON.parse(raw);
            
            // Миграция и слияние со старой структурой
            d.settings = { ...DEFAULT_SETTINGS, ...d.settings };
            d.customReplies = d.customReplies || {};
            d.customAIPrompts = d.customAIPrompts || {};
            d.stats = d.stats || {};
            d.contacts = d.contacts || {};
            
            // Инициализация новых таблиц, если обновляемся со старой версии
            d.macros = d.macros || {};
            d.scheduled = d.scheduled || [];
            
            return d;
        } catch (err) {
            console.error(`⚠️ database.json повреждён (${err.message}). Пересоздаём...`);
            const backup = DB_FILE + '.bak.' + Date.now();
            try { fs.renameSync(DB_FILE, backup); } catch (_) { }
            const d = defaultData();
            fs.writeFileSync(DB_FILE, JSON.stringify(d, null, 2));
            return d;
        }
    }

    _saveToDisk() {
        fs.writeFile(DB_FILE, JSON.stringify(this.data, null, 2), err => {
            if (err) console.error('❌ Ошибка записи БД:', err.message);
        });
    }

    forceSave() { this._dirty = true; this._saveToDisk(); this._dirty = false; }

    log(msg) {
        const time = new Date().toLocaleString('ru-RU', { timeZone: 'Asia/Almaty' });
        const line = `[${time}] ${msg}`;
        console.log(line);
        this.data.logs.push(line);
        if (this.data.logs.length > 1000) this.data.logs.splice(0, this.data.logs.length - 1000);
        fs.appendFile(LOG_FILE, line + '\n', () => { });
        this._dirty = true;
    }

    // ==========================================
    // НАСТРОЙКИ (SETTINGS)
    // ==========================================
    getSettings() { return this.data.settings; }
    toggleSetting(k) { this.data.settings[k] = !this.data.settings[k]; this._dirty = true; return this.data.settings; }
    setSetting(k, v) { this.data.settings[k] = v; this._dirty = true; }

    // ==========================================
    // КАСТОМНЫЕ ОТВЕТЫ (ОБЫЧНЫЕ И ПО ВРЕМЕНИ)
    // ==========================================
    setCustomReply(n, t) { 
        this.data.customReplies[n] = t; 
        this._dirty = true; 
    }

    // Новый метод: сохранение ответа со сложной логикой времени суток
    setAdvancedCustomReply(n, defaultText, timeRules = []) {
        this.data.customReplies[n] = {
            type: 'advanced',
            default: defaultText,
            timeRules: timeRules // формат: [{ start: '22:00', end: '08:00', text: 'Сплю' }]
        };
        this._dirty = true;
    }

    deleteCustomReply(n) { 
        delete this.data.customReplies[n]; 
        this._dirty = true; 
    }

    getCustomReply(jid) { 
        const num = jid.replace(/\D/g, '');
        const reply = this.data.customReplies[num];
        
        if (!reply) return null;

        // Обратная совместимость со старыми строковыми ответами
        if (typeof reply === 'string') return reply;

        // Обработка новой логики с расписанием (Time-based routing)
        if (reply.type === 'advanced') {
            const almatyTime = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Almaty' }));
            const currentHour = almatyTime.getHours();
            const currentMin = almatyTime.getMinutes();
            const currentDecimalTime = currentHour + currentMin / 60;

            for (const rule of reply.timeRules) {
                const [startH, startM] = rule.start.split(':').map(Number);
                const [endH, endM] = rule.end.split(':').map(Number);
                const startDecimal = startH + startM / 60;
                const endDecimal = endH + endM / 60;

                let isMatch = false;
                if (startDecimal < endDecimal) {
                    // В пределах одного дня (например, с 10:00 до 18:00)
                    isMatch = currentDecimalTime >= startDecimal && currentDecimalTime <= endDecimal;
                } else {
                    // Переход через полночь (например, с 22:00 до 08:00)
                    isMatch = currentDecimalTime >= startDecimal || currentDecimalTime <= endDecimal;
                }

                if (isMatch) return rule.text;
            }
            // Если ни одно правило по времени не подошло, отдаем дефолтный
            return reply.default || null;
        }

        return null;
    }

    // ==========================================
    // ПРАВИЛА ИИ (AI PROMPTS)
    // ==========================================
    setCustomPrompt(n, t) { this.data.customAIPrompts[n] = t; this._dirty = true; }
    deleteCustomPrompt(n) { delete this.data.customAIPrompts[n]; this._dirty = true; }
    getCustomPrompt(jid) { return this.data.customAIPrompts[jid.replace(/\D/g, '')] || null; }

    // ==========================================
    // СТАТИСТИКА И КОНТАКТЫ
    // ==========================================
    incStat(key) { this.data.stats[key] = (this.data.stats[key] || 0) + 1; this._dirty = true; }
    getStats() { return this.data.stats; }

    trackContact(jid, name, lastMsg) {
        const num = jid.replace(/\D/g, '');
        const now = new Date().toLocaleString('ru-RU', { timeZone: 'Asia/Almaty' });
        if (!this.data.contacts[num]) {
            this.data.contacts[num] = { name, count: 0, firstSeen: now, lastSeen: now, lastMsg: '' };
        }
        const c = this.data.contacts[num];
        c.count++;
        c.lastSeen = now;
        c.lastMsg = lastMsg ? lastMsg.slice(0, 100) : '';
        if (name && name !== num) c.name = name;
        this._dirty = true;
    }
    
    getContact(num) { return this.data.contacts[num.replace(/\D/g, '')] || null; }
    getAllContacts() { return this.data.contacts; }

    listCustomReplies() { return this.data.customReplies; }
    listCustomPrompts() { return this.data.customAIPrompts; }

    // ==========================================
    // МАКРОСЫ (Писать мало - отправить много)
    // ==========================================
    setMacro(shortCode, fullText) {
        this.data.macros[shortCode.toLowerCase()] = fullText;
        this._dirty = true;
    }

    getMacro(shortCode) {
        return this.data.macros[shortCode.toLowerCase()] || null;
    }

    getAllMacros() {
        return this.data.macros;
    }

    deleteMacro(shortCode) {
        delete this.data.macros[shortCode.toLowerCase()];
        this._dirty = true;
    }

    // ==========================================
    // ПЛАНИРОВЩИК (Scheduled Messages)
    // ==========================================
    addScheduledMsg(jid, text, sendAtMs) {
        const id = Date.now().toString(36) + Math.random().toString(36).substring(2, 6);
        this.data.scheduled.push({
            id,
            jid: jid.replace(/\D/g, ''), // Храним только цифры для надежности
            text,
            sendAt: sendAtMs,
            sent: false
        });
        this._dirty = true;
        return id;
    }

    getPendingScheduled() {
        const now = Date.now();
        return this.data.scheduled.filter(m => !m.sent && m.sendAt <= now);
    }

    getAllScheduled() {
        return this.data.scheduled.filter(m => !m.sent).sort((a, b) => a.sendAt - b.sendAt);
    }

    markScheduledSent(id) {
        const msg = this.data.scheduled.find(m => m.id === id);
        if (msg) {
            msg.sent = true;
            this._dirty = true;
        }
    }

    deleteScheduledMsg(id) {
        this.data.scheduled = this.data.scheduled.filter(m => m.id !== id);
        this._dirty = true;
    }
}

const db = new LocalDB();
export default db;