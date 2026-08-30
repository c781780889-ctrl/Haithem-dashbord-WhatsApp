# إعداد PostgreSQL وRedis على Railway

## سبب التعطل

تظهر الرسائل التالية عندما تكون خدمات PostgreSQL وRedis موجودة في المشروع، لكن متغيرات الاتصال لم تُعرَّف داخل **خدمة التطبيق**:

```text
[StartupValidator] WARNING: DATABASE_URL not set
[StartupValidator] WARNING: REDIS_URL not set
[PostgreSQL] DATABASE_URL is required
[RedisManager] REDIS_URL is required
```

إضافة قاعدة البيانات وRedis وحدها لا تكفي؛ يجب إضافة **Reference Variables** إلى خدمة `Haithem-dashboard-WhatsApp` أو إلى الخدمة التي تشغّل هذا المستودع.

## الإعداد المطلوب في Railway

افتح خدمة التطبيق، ثم **Variables → New Variable → Add Reference**، وأضف المتغيرين التاليين:

| اسم المتغير في خدمة التطبيق | القيمة المرجعية |
| --- | --- |
| `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` |
| `REDIS_URL` | `${{Redis.REDIS_URL}}` |

إذا كانت أسماء الخدمات مختلفة، استبدل `Postgres` و`Redis` بالاسم الظاهر على Project Canvas، مع إبقاء اسم المتغير المصدر كما هو. مثال: إذا كان اسم خدمة قاعدة البيانات `PostgreSQL`, فاستخدم `${{PostgreSQL.DATABASE_URL}}`.

بعد الحفظ، نفّذ **Redeploy** للخدمة. لا تضع قيم الاتصال يدوياً ولا تنسخ كلمات المرور إلى GitHub.

## التحقق من نجاح النشر

في Deploy Logs يجب أن يظهر ما يشبه:

```text
[StartupValidator] Database configured: true | Redis configured: true
[Server] Listening on port <PORT>
```

ويجب ألا تظهر رسائل `DATABASE_URL is required` أو `REDIS_URL is required`. كما يمكن اختبار:

```text
https://<your-public-domain>/health
```

ثم مراجعة `/health/ready` بعد اكتمال تهيئة قاعدة البيانات وRedis.

## ملاحظة مهمة

الكود يدعم أيضاً الأسماء البديلة `POSTGRES_URL`, `POSTGRES_PRIVATE_URL`, `POSTGRESQL_URL`, `REDIS_PRIVATE_URL`, `REDIS_CONNECTION_URL`, و`REDIS_PUBLIC_URL`، لكن الإعداد الموصى به على Railway هو استخدام مرجعي المتغيرين القياسيين `DATABASE_URL` و`REDIS_URL` أعلاه، لأن جميع طبقات التطبيق وBullMQ وSocket.IO تعتمد عليهما.

## المصادر

- [Railway: Deploy a SaaS Backend with Postgres, Workers, and Webhooks](https://docs.railway.com/guides/saas-backend)
- [Railway: Variables Reference](https://docs.railway.com/variables/reference)
- [Railway: Redis](https://docs.railway.com/databases/redis)
