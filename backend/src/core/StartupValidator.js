'use strict';
function validate() {
    const PORT = parseInt(process.env.PORT || '8080', 10);
    if (!process.env.DATABASE_URL) console.warn('[StartupValidator] WARNING: DATABASE_URL not set');
    if (!process.env.REDIS_URL)    console.warn('[StartupValidator] WARNING: REDIS_URL not set');
    const telegramApiId = process.env.TELEGRAM_API_ID || process.env.TELEGRAM_APP_ID || process.env.TELEGRAM_APIID || process.env.API_ID;
    const telegramApiHash = process.env.TELEGRAM_API_HASH || process.env.TELEGRAM_APP_HASH || process.env.TELEGRAM_APIHASH || process.env.API_HASH;
    const telegramSessionKey = process.env.SESSION_ENCRYPTION_KEY;
    console.log(`[StartupValidator] PORT=${PORT} | ENV=${process.env.NODE_ENV || 'development'}`);
    console.log(`[StartupValidator] Telegram API configured: ${Boolean(telegramApiId && telegramApiHash)} | Session encryption key configured: ${Boolean(telegramSessionKey)}`);
    return PORT;
}
module.exports = { validate };
