'use strict';

jest.mock('pg', () => ({
    Pool: jest.fn(),
}));

const { Pool } = require('pg');
const postgres = require('./postgres');

describe('postgres transient recovery and configuration safety', () => {
    beforeEach(() => {
        jest.resetModules();
        Pool.mockReset();
        process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test';
    });

    afterEach(async () => {
        await postgres.closeAll();
    });

    test('retries a transient query failure and preserves the query contract', async () => {
        const query = jest
            .fn()
            .mockRejectedValueOnce(Object.assign(new Error('Connection terminated due to connection timeout'), { code: 'ETIMEDOUT' }))
            .mockResolvedValueOnce({ rows: [{ ok: 1 }], rowCount: 1 });
        const pool = { query, on: jest.fn(), end: jest.fn().mockResolvedValue(), options: { max: 5 } };
        Pool.mockImplementation(() => pool);

        await expect(postgres.query('SELECT 1')).resolves.toEqual({ rows: [{ ok: 1 }], rowCount: 1 });
        expect(query).toHaveBeenCalledTimes(2);
    });

    test('rejects an unresolved Railway variable reference before creating a pool', () => {
        process.env.DATABASE_URL = '${{Postgres.DATABASE_URL}}';
        expect(() => postgres.getPool()).toThrow(/unresolved Railway variable reference/i);
        expect(Pool).not.toHaveBeenCalled();
    });

    test('retries client acquisition after a transient database outage', async () => {
        const connect = jest
            .fn()
            .mockRejectedValueOnce(Object.assign(new Error('connect timeout'), { code: 'ETIMEDOUT' }))
            .mockResolvedValueOnce({ release: jest.fn() });
        const pool = { connect, on: jest.fn(), end: jest.fn().mockResolvedValue(), options: { max: 5 } };
        Pool.mockImplementation(() => pool);

        await expect(postgres.getClient()).resolves.toEqual(expect.objectContaining({ release: expect.any(Function) }));
        expect(connect).toHaveBeenCalledTimes(2);
    });
});
