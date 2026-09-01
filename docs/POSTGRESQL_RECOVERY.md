# PostgreSQL Recovery

## الحالة المتوقعة في حادثة الإنتاج

عند ظهور `No space left on device` أو `database system is not yet accepting connections`، تكون الأولوية لاستعادة قدرة PostgreSQL على الكتابة، خصوصًا إلى WAL. لا تُحذف ملفات `PGDATA` أو `pg_wal` يدويًا؛ فـ WAL جزء من آلية استعادة الاتساق بعد الأعطال [1].

## ترتيب العمل

| المرحلة | الإجراء | معيار النجاح |
|---|---|---|
| Detect | قراءة Deploy Logs وVolume Metrics | تحديد disk/WAL/bloat/replication slot |
| Freeze | إيقاف الحملات والـ workers غير الضرورية | لا عمليات كتابة كبيرة جديدة |
| Backup | استخدام نسخة Railway أو `pg_dump` إلى تخزين خارجي | نسخة قابلة للتحقق |
| Free safe space | زيادة Volume أو إزالة ملفات تطبيق مصرح بها | مساحة حرة كافية |
| Restart | إعادة تشغيل خدمة PostgreSQL | حالة Online/Healthy |
| Validate | اختبار اتصال واستكمال recovery | قبول `SELECT 1` وعدم وجود WAL errors |
| Maintain | `VACUUM (ANALYZE)` عند الحاجة | تقليل dead tuples دون lock شامل |

## فحوص SQL بعد عودة الاتصال

```sql
SELECT current_database(), pg_database_size(current_database());
SELECT * FROM pg_stat_database WHERE datname = current_database();
SELECT schemaname, relname, n_live_tup, n_dead_tup, last_autovacuum
FROM pg_stat_user_tables
ORDER BY n_dead_tup DESC
LIMIT 20;
SELECT slot_name, active,
       pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn) AS retained_bytes
FROM pg_replication_slots;
```

لا تنفذ حذفًا بناءً على هذه النتائج وحدها. إذا كان السبب replication slot غير نشط، أصلح أو أزل slot فقط بعد إثبات أنه غير مطلوب للنسخ أو CDC.

## إعدادات الاتصال

يستخدم المشروع pool محدودًا عبر `DB_POOL_MAX` مع `connectionTimeoutMillis` و`statement_timeout` و`query_timeout`. يجب حساب `DB_POOL_MAX` على أساس سعة PostgreSQL وعدد نسخ التطبيق والعمال، لا رفعه عشوائيًا لتجنب Connection Storm.

## References

[1]: https://www.postgresql.org/docs/current/wal-intro.html "PostgreSQL Write-Ahead Logging"
[2]: https://www.postgresql.org/docs/current/routine-vacuuming.html "PostgreSQL Routine Vacuuming"
