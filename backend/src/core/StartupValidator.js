'use strict';

function isUsableUrl(value, protocols) {
    if (!value || typeof value !== 'string') return false;
    try {
        const parsed = new URL(value.trim());
        return protocols.includes(parsed.protocol) && Boolean(parsed.hostname);
    } catch (_) {
        return false;
    }
}

function firstUsableUrl(values, protocols) {
    return values.find((value) => isUsableUrl(value, protocols)) || '';
}

/**
 * Railway injects reference variables only when they are declared on the
 * application service. These aliases keep local setups and older Railway
 * variable names compatible; the canonical names remain DATABASE_URL and
 * REDIS_URL throughout the application.
 */
function normalizeServiceUrls() {
    process.env.DATABASE_URL = firstUsableUrl([
        process.env.DATABASE_URL,
        process.env.POSTGRES_URL,
        process.env.POSTGRES_PRIVATE_URL,
        process.env.POSTGRESQL_URL,
    ], ['postgres:', 'postgresql:']);

    process.env.REDIS_URL = firstUsableUrl([
        process.env.REDIS_URL,
        process.env.REDIS_PRIVATE_URL,
        process.env.REDIS_CONNECTION_URL,
        process.env.REDIS_PUBLIC_URL,
    ], ['redis:', 'rediss:']);
}

function validate() {
    normalizeServiceUrls();
    const PORT = parseInt(process.env.PORT || '8080', 10);
    if (!process.env.DATABASE_URL) {
        console.warn('[StartupValidator] DATABASE_URL is missing or invalid. Railway app service must reference the PostgreSQL service, e.g. ${{Postgres.DATABASE_URL}}.');
    }
    if (!process.env.REDIS_URL) {
        console.warn('[StartupValidator] REDIS_URL is missing or invalid. Railway app service must reference the Redis service, e.g. ${{Redis.REDIS_URL}}.');
    }
    const telegramApiId = process.env.TELEGRAM_API_ID || process.env.TELEGRAM_APP_ID || process.env.TELEGRAM_APIID || process.env.API_ID;
    const telegramApiHash = process.env.TELEGRAM_API_HASH || process.env.TELEGRAM_APP_HASH || process.env.TELEGRAM_APIHASH || process.env.API_HASH;
    const telegramSessionKey = process.env.SESSION_ENCRYPTION_KEY;
    console.log(`[StartupValidator] PORT=${PORT} | ENV=${process.env.NODE_ENV || 'development'}`);
    console.log(`[StartupValidator] Database configured: ${Boolean(process.env.DATABASE_URL)} | Redis configured: ${Boolean(process.env.REDIS_URL)}`);
    console.log(`[StartupValidator] Telegram API configured: ${Boolean(telegramApiId && telegramApiHash)} | Session encryption key configured: ${Boolean(telegramSessionKey)}`);
    return PORT;
}

module.exports = { validate, normalizeServiceUrls, isUsableUrl };
