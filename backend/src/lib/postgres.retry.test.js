'use strict';

jest.mock('pg', () => ({
    Pool: jest.fn(),
}));

const { Pool } = require('pg');
const postgres = require('./postgres');

describe('postgres query transient recovery', () => {
    beforeEach(() => {
        jest.resetModules();
        Pool.mockReset();
        process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test';
    });

    test('retries a transient connection failure and succeeds without replacing the query contract', async () => {
        const query = jest
            .fn()
            .mockRejectedValueOnce(Object.assign(new Error('Connection terminated due to connection timeout'), { code: 'ETIMEDOUT' }))
            .mockResolvedValueOnce({ rows: [{ ok: 1 }], rowCount: 1 });
        const pool = { query, on: jest.fn(), options: { max: 5 } };
        Pool.mockImplementation(() => pool);

        await expect(postgres.query('SELECT 1')).resolves.toEqual({ rows: [{ ok: 1 }], rowCount: 1 });
        expect(query).toHaveBeenCalledTimes(2);
    });
});
