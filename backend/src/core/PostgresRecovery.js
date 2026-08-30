'use strict';

const DEFAULT_RETRY_DELAYS_MS = [1000, 2000, 4000, 8000, 12000, 15000, 15000, 15000, 15000, 15000, 15000];

function isPostgresRecoveryError(error) {
    const code = String(error?.code || '');
    const message = String(error?.message || '').toLowerCase();
    return code === '57P03'
        || message.includes('database system is in recovery')
        || message.includes('the database system is starting up');
}

async function withRecoveryRetry(operation, options = {}) {
    const delays = Array.isArray(options.delays) ? options.delays : DEFAULT_RETRY_DELAYS_MS;
    const logger = options.logger || console;

    for (let attempt = 0; ; attempt += 1) {
        try {
            return await operation();
        } catch (error) {
            const delay = delays[attempt];
            if (!isPostgresRecoveryError(error) || delay === undefined) throw error;
            logger.warn?.(
                { attempt: attempt + 1, retryInMs: delay, code: error.code },
                '[Database] PostgreSQL is recovering; retrying initialization.'
            );
            await new Promise(resolve => setTimeout(resolve, delay));
        }
    }
}

module.exports = { DEFAULT_RETRY_DELAYS_MS, isPostgresRecoveryError, withRecoveryRetry };
