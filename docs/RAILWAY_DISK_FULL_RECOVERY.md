# Railway Disk-Full Recovery Runbook

هذا الدليل مخصص لحوادث توقف PostgreSQL أو Redis بسبب امتلاء التخزين. الهدف هو إعادة الخدمة بأقل مخاطرة، مع الحفاظ على بيانات الحسابات والرسائل والجلسات. لا يُحذف Volume ولا تُحذف ملفات `PGDATA` أو `pg_wal` يدويًا.

## 1. Detect

ابدأ من Railway Console بمراجعة حالة PostgreSQL وRedis وVolume Metrics وDeploy Logs. افحص `/health` و`/health/ready` و`/health/deep` من التطبيق. الحالة `health = ok` تعني أن عملية Node.js حية فقط، أما `ready` فتتطلب اكتمال الاعتماديات.

الأدلة المهمة هي `No space left on device`، وفشل `rdbSaveRio` في Redis، وفشل الكتابة إلى `pg_wal`، و`database system is not yet accepting connections`. احفظ السجل قبل إعادة التشغيل.

## 2. Freeze destructive operations

أوقف أي تنظيف تلقائي أو migrations غير ضرورية أو حملات أو أعمال Queue كبيرة. لا تستخدم `DROP DATABASE` أو `initdb` أو `rm -rf` داخل Volume. لا تحذف `pg_wal` أو ملفات Redis persistence؛ فـ WAL جزء من آلية اتساق PostgreSQL [1]، وRedis persistence يحتاج تشخيصًا قبل تغيير إعداداته [2].

## 3. Backup

تحقق من وجود نسخة Railway أو نسخة خارجية صالحة. إذا كانت PostgreSQL متاحة مؤقتًا، خذ نسخة منطقية عبر `pg_dump` إلى تخزين خارجي، وليس إلى Volume المتعطل. إذا لم توجد نسخة، لا تعِد تهيئة Volume؛ صعّد الحادث إلى مزود الاستضافة.

## 4. Identify disk consumer

من Railway راجع حجم Volume والمخطط الزمني. داخل PostgreSQL، بعد عودة الاتصال، افحص الجداول والفهارس وWAL وreplication slots والملفات المؤقتة عبر `PostgresStorageMonitor`. لا تعتبر قاعدة البيانات الأكبر سببًا تلقائيًا؛ افصل بين نمو الجداول، bloat، WAL المحتجز، والسجلات الخارجية.

## 5. Free safe space

المسموح به هو زيادة Volume، إزالة ملفات التطبيق المؤقتة التي يملكها التطبيق بعد التحقق من مالكها وعمرها، ضبط تدوير سجلات التطبيق، وتنظيف BullMQ jobs المكتملة حسب retention. لا تلمس ملفات PostgreSQL أو Redis. حذف بيانات الأعمال مثل الرسائل والحسابات يحتاج سياسة مستقلة وموافقة منفصلة.

## 6. Restart PostgreSQL

بعد وجود مساحة كافية، أعد تشغيل خدمة PostgreSQL من Railway Console وانتظر حالة `Online/Healthy`. لا تعِد تشغيل التطبيق في حلقة متكررة أثناء recovery.

## 7. Validate PostgreSQL

تحقق من أن PostgreSQL يقبل الاتصالات، وأن recovery اكتمل، ولا توجد أخطاء WAL أو `not yet accepting connections`. اختبر `/health/database` ثم `/health/ready`.

## 8. Validate Redis and BullMQ

اختبر Redis عبر `PING = PONG` و`/health/redis`. راجع `waiting`, `active`, `completed`, و`failed` في BullMQ. تأكد من أن workers لا تعيد الاتصال بسرعة أو تسجل نفس الخطأ بلا حدود.

## 9. Validate Node.js and Authentication

تحقق من `/health`، ثم افتح الصفحة الرئيسية وسجّل الدخول. يجب إرجاع `503 Service temporarily unavailable` عند تعطل قاعدة البيانات بدل كشف تفاصيل الاتصال أو stack trace.

## 10. Validate Socket.IO and Dashboard

اختبر اتصال Socket.IO من المتصفح، وراقب عدم تكرار listeners أو subscriptions بعد Redis restart. افتح Dashboard وتحقق من الحسابات والرسائل دون تنفيذ عمليات كتابة كبيرة.

## 11. Monitor and prevent recurrence

فعّل مراقبة التخزين عند 70% و80% و90% و95%، مع تنبيه مبكر، وراقب نمو الجداول وWAL وRedis memory وBullMQ failed jobs. احتفظ بسجلات التشغيل وفق retention، واجعل أي تنظيف تلقائي محصورًا بمجلدات تطبيق مصرح بها ومغلقًا افتراضيًا.

## 12. Post-incident analysis

وثّق Root Cause وSecondary Causes وContributing Factors وFailure Chain وImmediate Fix وPermanent Fix وPrevention. اذكر ما تم الحفاظ عليه، وما تم تنظيفه، وما بقي يحتاج إجراءً من Railway Console.

## أوامر ممنوعة

```text
rm -rf /var/lib/postgresql/*
rm -rf pg_wal/*
rm -rf PGDATA/*
DROP DATABASE
initdb
```

لا تُستخدم هذه الإجراءات إلا في Disaster Recovery مثبت، مع نسخة احتياطية وخطة استعادة مكتوبة.

## References

[1]: https://www.postgresql.org/docs/current/wal-intro.html "PostgreSQL Write-Ahead Logging"
[2]: https://redis.io/faq/doc/296s7bo3im/how-to-fix-error-error-misconf-redis-is-configured-to-save-rdb-snapshots "Redis MISCONF FAQ"
[3]: https://docs.railway.com/volumes/reference "Railway Volumes Reference"
