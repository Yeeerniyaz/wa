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
            logs: [], customReplies: {}, customAIPrompts: {},
            stats: {}, contacts: {}, settings: { ...DEFAULT_SETTINGS }
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
            // Миграция
            d.settings = { ...DEFAULT_SETTINGS, ...d.settings };
            d.customReplies = d.customReplies || {};
            d.customAIPrompts = d.customAIPrompts || {};
            d.stats = d.stats || {};
            d.contacts = d.contacts || {};
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

    getSettings() { return this.data.settings; }
    toggleSetting(k) { this.data.settings[k] = !this.data.settings[k]; this._dirty = true; return this.data.settings; }
    setSetting(k, v) { this.data.settings[k] = v; this._dirty = true; }

    setCustomReply(n, t) { this.data.customReplies[n] = t; this._dirty = true; }
    deleteCustomReply(n) { delete this.data.customReplies[n]; this._dirty = true; }
    getCustomReply(jid) { return this.data.customReplies[jid.replace(/\D/g, '')] || null; }

    setCustomPrompt(n, t) { this.data.customAIPrompts[n] = t; this._dirty = true; }
    deleteCustomPrompt(n) { delete this.data.customAIPrompts[n]; this._dirty = true; }
    getCustomPrompt(jid) { return this.data.customAIPrompts[jid.replace(/\D/g, '')] || null; }

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
}

const db = new LocalDB();
export default db;
