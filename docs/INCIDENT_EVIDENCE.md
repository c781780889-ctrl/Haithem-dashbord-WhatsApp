# أدلة حادثة امتلاء التخزين وتعطل PostgreSQL

## حالة Railway المرصودة

- Redis ظهر بحالة Online بعد إعادة تشغيله.
- PostgreSQL ظهر بحالة Crashed في مشروع `proactive-spirit` مع Volume باسم `postgres-volume`.
- صفحة Backups أوضحت أن النسخ الاحتياطية وPITR غير متاحين على الخطة الحالية.
- رابط التطبيق كان يعيد `health = ok` لكنه بقي في `health/ready = starting`.
- فحص `health/deep` أعاد:
  - PostgreSQL: `PostgreSQL timeout`
  - Redis: `ok`
  - WhatsApp DB: `WhatsApp DB check timeout`
- تسجيل الدخول أعاد خطأ داخلي بعد انتظار يقارب 20 ثانية، وهو متسق مع عدم جاهزية PostgreSQL.

## أدلة السجلات المرفقة

Redis:

- `Write error while saving DB to the disk (rdbSaveRio)`
- `No space left on device`
- `Background saving error`

PostgreSQL:

- `could not write to file pg_wal/xlogtemp...: No space left on device`
- `database system was interrupted while in recovery`
- `database system is not yet accepting connections`
- `database system is shut down`

التطبيق:

- `Connection terminated due to connection timeout`
- `Bootstrap failed — HTTP server remains available; retrying dependencies in 30s`

## الاستنتاج الحالي

السبب الجذري المرجح والمدعوم بالأدلة هو امتلاء Volume أو عدم قدرة PostgreSQL على الكتابة إلى Volume، مع تأثير تابع على WAL ومرحلة recovery. Redis تأثر بالامتلاء نفسه، لكن حالته عادت Online بعد Restart. لم تُنفذ أي عملية حذف لملفات PostgreSQL أو `pg_wal` أو Volume، ولم يتم تنفيذ تنظيف جداول قبل عودة PostgreSQL والتحقق من النسخة الاحتياطية.

## قيود التحقق

لا يمكن قياس المساحة الحرة داخل Volume أو فحص `pg_wal` من التطبيق عندما تكون PostgreSQL متوقفة. يلزم قراءة PostgreSQL Deploy Logs وVolume Metrics من Railway قبل اختيار علاج نهائي. تعليمات المشروع تمنع حذف ملفات PostgreSQL الداخلية أو إعادة تهيئة Volume دون Backup صالح.
