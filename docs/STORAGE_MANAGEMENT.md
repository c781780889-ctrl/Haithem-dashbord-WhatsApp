# Storage Management

## الهدف

يستخدم المشروع ثلاث طبقات تخزين مختلفة: PostgreSQL لبيانات الأعمال، Redis للبيانات المؤقتة والطوابير، وVolume الخاص بالخدمة لملفات التطبيق. لا يجوز تطبيق سياسة واحدة على الطبقات الثلاث؛ فالحسابات والرسائل والجلسات بيانات أساسية، بينما سجلات التشغيل والمهام المكتملة والملفات المؤقتة مرشحة للاحتفاظ المحدود.

| Feature | Storage | Retention | Cleanup | الحماية |
|---|---|---|---|---|
| الحسابات والمستخدمون | PostgreSQL | دائم | لا يوجد تلقائيًا | لا حذف تلقائي |
| الرسائل والمحادثات | PostgreSQL | حسب متطلبات المنتج | غير مفعّل | لا حذف تلقائي |
| جلسات WhatsApp/Telegram | PostgreSQL/Redis وملفات جلسة | طالما الحساب نشط | لا حذف تلقائي للجلسات النشطة | حفظ الجلسات النشطة |
| Activity/Login logs | PostgreSQL | 90 يومًا أو حسب السياسة | تنظيف صريح بعد الموافقة | لا يمس الحسابات والرسائل |
| Refresh tokens المنتهية | PostgreSQL | حتى الانتهاء ثم احتفاظ قصير | تنظيف مجدول مشروط | لا يمس كلمات المرور |
| BullMQ completed jobs | Redis | 24 ساعة | `removeOnComplete` | لا حذف jobs النشطة |
| BullMQ failed jobs | Redis | 7 أيام | `removeOnFail` | الاحتفاظ للفحص |
| ملفات التطبيق المؤقتة | Volume التطبيق | 24 ساعة افتراضيًا | معطل افتراضيًا | مجلدات allowlist فقط |
| PostgreSQL WAL وRedis RDB/AOF | Volume الخدمة | يديره المحرك | لا حذف من التطبيق | لا لمس يدوي |

## مستويات التخزين

تستخدم `StorageMonitor` العتبات التالية: طبيعي تحت 70%، تحذير عند 70%، مرتفع عند 80%، حرج عند 90%، وطوارئ عند 95%. يقيس المراقب مساحة الملفات وinodes الخاصة بخدمة التطبيق فقط، لأن التطبيق لا يملك صلاحية آمنة لقياس Volume خدمة PostgreSQL أو Redis عندما تكون الخدمة متوقفة.

كما يستخدم `PostgresStorageMonitor` استعلامات PostgreSQL لقياس حجم قاعدة البيانات والجداول والفهارس وWAL والملفات المؤقتة وreplication slots عند توفر الاتصال. عند 90% لا ينفذ حذف بيانات؛ يقتصر الإجراء الآمن على `VACUUM (ANALYZE)` للجداول ذات الصفوف الميتة إذا كان ذلك مفعّلًا.

## الإعدادات

```dotenv
STORAGE_MONITOR_PATH=/app
STORAGE_MONITOR_INTERVAL_MS=60000
ALERT_STORAGE_WARNING_THRESHOLD=70
ALERT_STORAGE_HIGH_THRESHOLD=80
ALERT_STORAGE_CRITICAL_THRESHOLD=90
ALERT_STORAGE_EMERGENCY_THRESHOLD=95
STORAGE_AUTO_CLEANUP=false
APP_CLEANUP_DIRS=
APP_TEMP_RETENTION_MS=86400000
POSTGRES_STORAGE_AUTO_VACUUM=true
```

التنظيف التلقائي معطل افتراضيًا. إذا فُعّل، يجب أن تكون `APP_CLEANUP_DIRS` قائمة صريحة بمجلدات مؤقتة يملكها التطبيق فقط. لا تُضاف إليها مسارات PostgreSQL أو Redis أو `sessions` أو `credentials` أو مجلدات الرسائل.

## منع الامتلاء

يجب ضبط حجم Volume وفق النمو المتوقع، مع مراقبة استخدامه من Railway Console. زيادة المساحة علاج للبنية التحتية وليست بديلًا عن retention وlog rotation وتحليل نمو الجداول. توصي Railway باستخدام Volumes للبيانات الدائمة [1]، بينما يتطلب PostgreSQL فحص WAL والصفوف الميتة والفتحات replication بدل حذف الملفات يدويًا [2].

## PostgreSQL maintenance

استخدم `VACUUM (ANALYZE)` في أوقات مناسبة، وراقب `n_dead_tup` و`last_autovacuum` و`last_autoanalyze`. لا تستخدم `VACUUM FULL` عشوائيًا في الإنتاج لأنه قد يحتاج lock ويخلق ضغطًا إضافيًا على المساحة. لا تطبق retention على جدول الرسائل أو الحسابات قبل اعتماد سياسة منتج واضحة.

## BullMQ وRedis

توجد سياسات احتفاظ للمهام المكتملة والفاشلة في QueueManager. يجب مراجعة كل Queue جديدة والتأكد من `removeOnComplete` و`removeOnFail`. يستخدم Redis اتصالات منفصلة للـ cache وpub/sub وrate limit وBullMQ، مع timeout وexponential backoff وjitter. لا تُحذف مفاتيح Redis عشوائيًا، ولا يُغيّر `stop-writes-on-bgsave-error` إلا كإجراء مؤقت بعد إصلاح سبب فشل persistence.

## القياسات المطلوبة

يُستحسن تصدير `disk_usage_percent` و`disk_free_bytes` و`postgres_status` و`redis_status` و`redis_memory_usage` و`redis_rdb_last_save` و`bullmq_waiting_jobs` و`bullmq_failed_jobs` و`db_connections` و`db_query_latency` و`auth_failures` و`startup_failures` إلى نظام المراقبة. يجب حماية `/metrics` عبر `METRICS_SECRET` عند تعريضه خارج الشبكة الداخلية.

## References

[1]: https://docs.railway.com/volumes/reference "Railway Volumes Reference"
[2]: https://www.postgresql.org/docs/current/wal-intro.html "PostgreSQL Write-Ahead Logging"
[3]: https://redis.io/docs/latest/operate/oss_and_stack/management/persistence/ "Redis Persistence"
