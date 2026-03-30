import db from './src/db.js';
import { connectToWhatsApp } from './src/whatsapp.js';
import './src/telegram.js';

// ГЛОБАЛЬНАЯ ОБРАБОТКА ОШИБОК
process.on('unhandledRejection', (reason) => {
    const msg = reason instanceof Error ? reason.message : String(reason);
    db.log(`⚠️ UnhandledRejection: ${msg}`);
    console.error(reason);
});

process.on('uncaughtException', (err) => {
    db.log(`🔥 UncaughtException: ${err.message}`);
    console.error(err);
    setTimeout(() => process.exit(1), 2000);
});

db.log('🟡 Бот запускается (Модульная Архитектура v2.0)...');
connectToWhatsApp();