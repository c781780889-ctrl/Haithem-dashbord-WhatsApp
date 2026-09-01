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

## تحقق إنتاجي بعد آخر نشر

في 2026-09-01 23:40 UTC أعاد `GET /health/deep` استجابة `503` بحالة `unhealthy`:

```json
{
  "postgres": {"status":"error","ms":3001,"message":"PostgreSQL timeout"},
  "redis": {"status":"ok","ms":2},
  "whatsapp": {"status":"error","ms":3000,"message":"WhatsApp DB check timeout"}
}
```

هذا يثبت أن Redis يعمل، لكن PostgreSQL لم يعد يقبل الاتصال بعد، وأن التطبيق المنشور ما زال ينتظر الاعتماد الأساسي. فتح صفحة PostgreSQL في Railway عبر الجلسة الحالية لا يعرض عناصر التحكم أو السجلات، لذلك لا يمكن تحديد نوع تلف Volume من التطبيق وحده.

لم تُحذف أي بيانات أو ملفات PostgreSQL، ولم يُحذف Volume، ولم تُنفذ إعادة تهيئة.
