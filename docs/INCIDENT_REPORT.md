# INCIDENT REPORT

## Root Cause

السبب الجذري المدعوم بسجلات الإنتاج هو فشل الكتابة إلى تخزين PostgreSQL وRedis. ظهرت رسائل `No space left on device` و`could not write to file pg_wal` و`rdbSaveRio`، ثم دخل PostgreSQL في recovery ولم يعد يقبل الاتصالات. تأثر Redis بالامتلاء نفسه، بينما كان BullMQ يفشل في حفظ حالة الطوابير.

## Evidence

كان Redis يعود إلى Online بعد Restart، لكن PostgreSQL يعود إلى Crash، ويعيد التطبيق `PostgreSQL timeout` في `GET /health/deep` و`WhatsApp DB check timeout`. سجل Railway أظهر تكرار أخطاء Redis حتى وصل إلى Rate Limit للسجلات. لم تُحذف أي بيانات أو ملفات PostgreSQL، ولم يُحذف Volume أو يُعاد تهيئته.

## PostgreSQL

| الحقل | النتيجة |
|---|---|
| Status | غير جاهز أثناء آخر تحقق إنتاجي |
| Cause | امتلاء أو عدم قدرة Volume على الكتابة؛ يحتمل WAL/recovery، ويحتاج Deploy Logs وVolume Metrics لإثبات النوع النهائي |
| Fix | وضع مهلات pool/query/statement، مراقب حجم PostgreSQL، فحص WAL/slots والجداول، وRunbook يمنع حذف WAL |
| Validation | آخر `/health/deep` سجّل timeout؛ يلزم أن تصبح `health/database = ok` بعد إصلاح Railway |

## Redis

| الحقل | النتيجة |
|---|---|
| Status | Online وPING ناجح بعد Restart |
| Cause | فشل RDB snapshot بسبب التخزين |
| Fix | اتصالات منفصلة، command/connect timeout، exponential backoff مع jitter، rate-limited logging، ومحاولة مؤقتة لتجاوز stop-writes guard عند سماح المزود |
| Validation | `redis.status = ok` في `/health/deep` |

## BullMQ

| الحقل | النتيجة |
|---|---|
| Status | يتأثر عند توقف Redis |
| Cause | Redis persistence/write failure |
| Fix | retention للمهام المكتملة والفاشلة، emergency mode للطوابير غير الأساسية، وعزل فشل الطوابير عن HTTP bootstrap |
| Validation | اختبارات Backend ناجحة؛ التحقق الإنتاجي يتطلب Redis وPostgreSQL جاهزين معًا |

## Node.js

| الحقل | النتيجة |
|---|---|
| Status | Liveness يستمر، والعملية لا تنهي نفسها بسبب dependency مؤقتة |
| Cause | bootstrap dependency failure كان يؤدي إلى retry أو 502 في النسخ السابقة |
| Fix | إبقاء HTTP server حيًا، retry متدرج، وإيقاف graceful للمراقبين والطوابير |
| Validation | `/health` متاح، بينما readiness يبقى 503 حتى تكتمل الاعتماديات |

## Authentication

| الحقل | النتيجة |
|---|---|
| Status | يعتمد على PostgreSQL |
| Cause | login query timeout عند عدم جاهزية قاعدة البيانات |
| Fix | إرجاع 503 برسالة عامة دون كشف connection strings أو stack traces |
| Validation | يلزم اختبار login بعد عودة PostgreSQL |

## Disk

لا يمكن استخراج Before/After الفعلي من التطبيق أثناء توقف PostgreSQL؛ قياس Volume يتم من Railway Console. يجب تسجيله قبل وبعد زيادة المساحة أو معالجة الملفات الآمنة.

## Files Removed

لم تُحذف ملفات. لم تُلمس `PGDATA` أو `pg_wal` أو Redis persistence أو Volume.

## Files Preserved

الحسابات والرسائل والمحادثات والقواعد والنتائج والجلسات وملفات PostgreSQL وRedis محفوظة.

## Database Integrity

لم تُنفذ `DROP DATABASE` أو `initdb` أو `VACUUM FULL` أو حذف يدوي لملفات WAL. جداول مراقبة PostgreSQL لها retention خاص بها فقط عند توفر الاتصال.

## Security

أضيفت استجابات health آمنة، وإخفاء رسائل dependency الحساسة، واستثناء ملفات الأسرار والنسخ الاحتياطية والسجلات والملفات المؤقتة من Git. يجب تدوير كلمة مرور الإدارة التي تم مشاركتها سابقًا مع أي طرف آخر كإجراء أمني.

## Monitoring

أضيف `StorageMonitor` لمراقبة مساحة وinodes خدمة التطبيق، و`PostgresStorageMonitor` لمراقبة حجم قاعدة البيانات والجداول والفهارس وWAL والملفات المؤقتة والـ replication slots. التنظيف التلقائي لملفات التطبيق معطل افتراضيًا، ولا توجد صلاحية للتطبيق لحذف ملفات PostgreSQL أو Redis.

## Prevention

يجب ضبط Volume أكبر عند الحاجة، وتفعيل نسخة احتياطية خارجية أو Railway إن كانت متاحة، وضبط retention وlog rotation، ومراقبة العتبات 70/80/90/95%، ومراجعة نمو الجداول وBullMQ وRedis. لا يكفي تعديل الكود إذا كان Volume PostgreSQL ممتلئًا؛ يلزم إجراء Railway Console لإصلاح أو توسيع البنية التحتية.

## Deployment

آخر التغييرات مرفوعة إلى `main` في الالتزام `0974d70`، وتشمل تحسين health وRedis وPostgreSQL وStorageMonitor وRunbooks. نجحت فحوص الصياغة، و25 مجموعة اختبار و90 اختبارًا، وبناء Frontend.

## Required Railway Actions

أصلح PostgreSQL من Railway Console بعد حفظ Deploy Logs، وتحقق من Volume Metrics، وأعد تشغيل PostgreSQL بعد توفير مساحة آمنة، ثم أعد نشر التطبيق. لا تحذف Volume ولا تعيد إنشاء PostgreSQL قبل وجود نسخة احتياطية وخطة استعادة.

## References

[1]: https://docs.railway.com/volumes/reference "Railway Volumes Reference"
[2]: https://www.postgresql.org/docs/current/wal-intro.html "PostgreSQL Write-Ahead Logging"
[3]: https://redis.io/faq/doc/296s7bo3im/how-to-fix-error-error-misconf-redis-is-configured-to-save-rdb-snapshots "Redis MISCONF FAQ"
[4]: https://docs.bullmq.io/guide/queues/auto-removal-of-jobs "BullMQ Auto-removal of Jobs"
