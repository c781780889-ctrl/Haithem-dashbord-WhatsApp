'use strict';

jest.mock('bcryptjs', () => ({ compare: jest.fn() }));
jest.mock('speakeasy', () => ({ totp: { verify: jest.fn() } }));
jest.mock('qrcode', () => ({}));
jest.mock('../../database/SystemDB', () => ({
    isBlocked: jest.fn(),
    get: jest.fn(),
    recordAttempt: jest.fn().mockResolvedValue(undefined),
    log: jest.fn().mockResolvedValue(undefined),
    run: jest.fn().mockResolvedValue(undefined),
    saveRefreshToken: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../../core/JWTService', () => ({
    issueTokenPair: jest.fn(),
    registerFamily: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../../core/EncryptionService', () => ({}));
jest.mock('../../core/Logger', () => ({ child: () => ({ info: jest.fn(), error: jest.fn(), warn: jest.fn() }) }));

const bcrypt = require('bcryptjs');
const SystemDB = require('../../database/SystemDB');
const JWTService = require('../../core/JWTService');
const AuthController = require('./AuthController');

function response() {
    return {
        status: jest.fn().mockReturnThis(),
        json: jest.fn().mockReturnThis(),
    };
}

function request(body = {}) {
    return {
        body,
        requestId: 'test-request-123',
        originalUrl: '/api/v1/auth/login',
        headers: { 'user-agent': 'jest' },
        socket: { remoteAddress: '127.0.0.1' },
    };
}

describe('AuthController.login', () => {
    beforeEach(() => jest.clearAllMocks());

    test('returns 401 for an unknown user and preserves requestId', async () => {
        SystemDB.isBlocked.mockResolvedValue(null);
        SystemDB.get.mockResolvedValue(null);
        const res = response();

        await AuthController.login(request({ username: 'missing', password: 'secret1' }), res);

        expect(res.status).toHaveBeenCalledWith(401);
        expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: false, requestId: 'test-request-123' }));
    });

    test('returns 503 when PostgreSQL is unavailable instead of a generic 500', async () => {
        SystemDB.isBlocked.mockRejectedValue(Object.assign(new Error('connect timeout'), { code: 'ETIMEDOUT' }));
        const res = response();

        await AuthController.login(request({ username: 'admin', password: 'secret1' }), res);

        expect(res.status).toHaveBeenCalledWith(503);
        expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'DATABASE_UNAVAILABLE', requestId: 'test-request-123' }));
    });

    test('returns 401 for an invalid password', async () => {
        SystemDB.isBlocked.mockResolvedValue(null);
        SystemDB.get.mockResolvedValue({ id: 'u1', username: 'admin', password: 'hash', role: 'super_admin' });
        bcrypt.compare.mockResolvedValue(false);
        const res = response();

        await AuthController.login(request({ username: 'admin', password: 'wrongpass' }), res);

        expect(res.status).toHaveBeenCalledWith(401);
        expect(JWTService.issueTokenPair).not.toHaveBeenCalled();
    });
});
