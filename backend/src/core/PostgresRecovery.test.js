'use strict';
const { isPostgresRecoveryError, withRecoveryRetry } = require('./PostgresRecovery');

describe('PostgresRecovery', () => {
    test('classifies connection timeout as retryable', () => {
        expect(isPostgresRecoveryError(Object.assign(new Error('Connection terminated due to connection timeout'), { code: 'ETIMEDOUT' }))).toBe(true);
    });

    test('retries a transient connection failure and then succeeds', async () => {
        const operation = jest.fn()
            .mockRejectedValueOnce(Object.assign(new Error('connect timeout'), { code: 'ETIMEDOUT' }))
            .mockResolvedValue('ok');
        await expect(withRecoveryRetry(operation, { delays: [0], logger: { warn: jest.fn() } })).resolves.toBe('ok');
        expect(operation).toHaveBeenCalledTimes(2);
    });
});
