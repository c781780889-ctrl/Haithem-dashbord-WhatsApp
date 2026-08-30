'use strict';
/**
 * postgres.js — المصدر الوحيد (Single Source of Truth) لاتصال PostgreSQL في المشروع
 * ─────────────────────────────────────────────────────────────────────────────
 * توحيد طبقة قاعدة البيانات (Database Unification):
 *  - كل وحدات المشروع (SystemDB, DatabaseManager, المحللون، الخدمات، المتحكمون)
 *    تستخدم الـ pool المركزي الوحيد في هذا الملف — لا يُسمح بإنشاء pool جديد
 *    من `pg` مباشرة في أي مكان آخر.
 *  - إعدادات موحّدة: keepAlive + إعادة إنشاء الـ pool تلقائيًا عند انقطاع
 *    الاتصال + DB_POOL_MAX قابل للضبط من البيئة.
 *  - دعم Schemas: createAccountPool(schemaName) — اتصال عميل مخصّص لكل حساب
 *    (acc_<id>) مع SET search_path، لإعادة استخدام نفس إعدادات الاتصال.
 *
 * الاستخدام:
 *   const { query, queryOne, queryAll, getClient, createAccountPool, closeAll } = require('./lib/postgres');
 */
const { Pool } = require('pg');

let pool = null;

// إعدادات الاتصال المشتركة (تُطبَّق على كل الـ pools في المشروع)
function poolOptions(overrides = {}) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
        throw new Error('[PostgreSQL] DATABASE_URL is required.');
    }

    const isLocal = connectionString.includes('localhost') || connectionString.includes('127.0.0.1');
    return Object.assign({
        connectionString,
        ssl: isLocal ? false : { rejectUnauthorized: false },
        max: parseInt(process.env.DB_POOL_MAX || '5', 10),
        idleTimeoutMillis: 60000,
        connectionTimeoutMillis: 10000,
        keepAlive: true,
        keepAliveInitialDelayMillis: 10000,
    }, overrides);
}

function createPool(opts = {}) {
    const p = new Pool(poolOptions(opts));

    p.on('connect', () => {
        console.log('[PostgreSQL] New client connected.');
    });

    p.on('error', (err, client) => {
        console.error('[PostgreSQL] Pool error:', err.message);
        // إعادة إنشاء الـ pool إذا انقطع الاتصال نهائياً
        if (err.code === 'ECONNRESET' || err.code === 'ECONNREFUSED' || err.message.includes('Connection terminated')) {
            console.log('[PostgreSQL] Recreating pool due to connection error...');
            pool = null;
        }
    });

    console.log('[PostgreSQL] Pool created. Max connections:', p.options.max);
    return p;
}

function getPool() {
    if (!pool) {
        pool = createPool();
    }
    return pool;
}

async function query(sql, params = []) {
    const p = getPool();
    try {
        return await p.query(sql, params);
    } catch (err) {
        // إذا انقطع الاتصال، نحذف الـ pool لإعادة إنشائه في المرة القادمة
        if (err.message.includes('Connection terminated') || err.code === 'ECONNRESET') {
            console.error('[PostgreSQL] Connection lost, will reconnect on next query.');
            pool = null;
        }
        console.error('[PostgreSQL] Query error:', err.message, '\nSQL:', sql.trim().slice(0, 200));
        throw err;
    }
}

async function queryOne(sql, params = []) {
    const res = await query(sql, params);
    return res.rows[0] || null;
}

async function queryAll(sql, params = []) {
    const res = await query(sql, params);
    return res.rows;
}

async function getClient() {
    return getPool().connect();
}

/**
 * Execute a callback in a PostgreSQL transaction. The callback receives the
 * checked-out client so every statement participates in the same transaction.
 */
async function withTransaction(callback) {
    const client = await getClient();
    try {
        await client.query('BEGIN');
        const result = await callback(client);
        await client.query('COMMIT');
        return result;
    } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw error;
    } finally {
        client.release();
    }
}

/**
 * Acquire a PostgreSQL advisory lock on a stable text key. The lock is held
 * on the checked-out session until the callback completes, so all callers of
 * this helper coordinate across backend replicas without holding an open DB
 * transaction during a slow Telegram request.
 */
async function withAdvisoryLock(key, callback, options = {}) {
    const client = await getClient();
    const wait = options.wait !== false;
    try {
        const lock = await client.query(
            `SELECT ${wait ? 'pg_advisory_lock(hashtext($1))' : 'pg_try_advisory_lock(hashtext($1)) AS locked'}`,
            [String(key)]
        );
        if (!wait && !lock.rows[0]?.locked) return { locked: false };
        return await callback(client);
    } finally {
        await client.query('SELECT pg_advisory_unlock(hashtext($1))', [String(key)]).catch(() => {});
        client.release();
    }
}

/**
 * createAccountPool — عميل اتصال مخصّص لـ schema حساب محدد
 * (acc_<accountId>) مع SET search_path لكل استعلام.
 * يعيد استخدام نفس إعدادات الاتصال الموحّدة (ssl, keepAlive, timeouts).
 */
function createAccountPool(accountId, schemaName) {
    // إعدادات مخصصة: اتصال واحد مُعاد استخدامه (max: 2) لعملاء الـ schemas
    const opts = poolOptions({ max: 2 });
    const p = new Pool(opts);

    p.on('error', (err) => {
        console.error(`[PostgreSQL:acc-${accountId}] Pool error:`, err.message);
    });

    return {
        async query(sql, params = []) {
            const client = await p.connect();
            try {
                await client.query(`SET search_path TO "${schemaName}", public`);
                return await client.query(sql, params);
            } finally {
                client.release();
            }
        },
        async get(sql, params = []) {
            const r = await this.query(sql, params);
            return r.rows[0] || null;
        },
        async all(sql, params = []) {
            const r = await this.query(sql, params);
            return r.rows;
        },
        async run(sql, params = []) {
            const r = await this.query(sql, params);
            return { rowCount: r.rowCount };
        },
        async end() {
            await p.end();
        },
    };
}

/**
 * closeAll — إغلاق كل pools في الخادم (للاستخدام عند الإيقاف)
 */
async function closeAll() {
    if (pool) { await pool.end(); pool = null; }
}

module.exports = { getPool, query, queryOne, queryAll, getClient, withTransaction, withAdvisoryLock, createAccountPool, closeAll, poolOptions };
