# Redis and BullMQ Recovery

## تشخيص MISCONF

رسالة `MISCONF Redis is configured to save RDB snapshots, but it's currently unable to persist to disk` تعني أن Redis لم يتمكن من حفظ persistence على القرص. الأسباب المحتملة هي امتلاء التخزين أو صلاحيات الكتابة أو فشل RDB/AOF. يجب مراجعة Redis Logs وVolume Metrics أولًا؛ لا يكفي تعطيل الحماية دون إصلاح التخزين [1] [2].

## الإجراء الآمن

أوقف الأعمال غير الضرورية مؤقتًا، افحص المساحة، راجع `LASTSAVE` و`INFO persistence`، ثم أعد تشغيل Redis بعد معالجة السبب. لا تحذف `dump.rdb` أو `appendonly.aof` أو ملفات Volume يدويًا. إذا كان Redis مُدارًا ويمنع `CONFIG SET`، يجب تغيير الإعداد من مزود الاستضافة بدل تكرار المحاولة من التطبيق.

## سلوك التطبيق

يستخدم التطبيق اتصالات منفصلة للـ cache وpublisher وsubscriber وrate limit، بينما تستخدم BullMQ اتصالاتها الخاصة. كل اتصال يملك `connectTimeout` و`commandTimeout` واستراتيجية exponential backoff مع jitter. تمنع هذه السياسة rapid reconnect storm، لكنها لا تعالج Volume ممتلئًا وحدها.

## BullMQ retention

تحدد QueueManager سياسة احتفاظ للمهام المكتملة والفاشلة. يجب الاحتفاظ بالمهام الفاشلة مدة قصيرة للفحص ثم إزالتها، وعدم حذف المهام `waiting` أو `active` أو `delayed` تلقائيًا. عند emergency mode تُعلّق الطوابير غير الأساسية فقط، مع إبقاء العمليات الأساسية تحت المراقبة.

## التحقق

```text
Redis: PING = PONG
Persistence: last save advances after a write
BullMQ: waiting/active/failing counts are finite
Workers: no repeated identical errors without rate limiting
Socket.IO: one pub/sub subscription per process
```

## References

[1]: https://redis.io/faq/doc/296s7bo3im/how-to-fix-error-error-misconf-redis-is-configured-to-save-rdb-snapshots "Redis MISCONF FAQ"
[2]: https://redis.io/docs/latest/operate/oss_and_stack/management/persistence/ "Redis Persistence"
[3]: https://docs.bullmq.io/guide/queues/auto-removal-of-jobs "BullMQ Auto-removal of Jobs"
