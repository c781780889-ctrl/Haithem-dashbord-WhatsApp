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

بعد الحفظ، نفّذ **Redeploy** للخدمة. لا تضع قيمة `redis://` يدوياً؛ هذه قيمة غير مكتملة وتؤدي إلى الخطأ `TypeError: Invalid URL`. استخدم مرجع Railway أو الصق رابط Redis الكامل الذي يحتوي على المضيف والمنفذ وكلمة المرور. لا تنسخ كلمات المرور إلى GitHub.

## المتغيرات الأخرى: ما هو مطلوب وما هو اختياري؟

لا تضف كل المتغيرات عشوائياً. لتشغيل اللوحة، أضف المتغيرين المرجعيين أعلاه، ثم أضف أسرار الأمان التالية بقيم عشوائية قوية:

| المتغيرات | الحالة | الاستخدام |
| --- | --- | --- |
| `ADMIN_USERNAME`, `ADMIN_PASSWORD` | موصى بها | بيانات دخول المدير الأول. الكود يملك قيماً افتراضية، لكن لا يُنصح باستخدامها في الإنتاج. |
| `RESET_ADMIN_PASSWORD` | مؤقتة | اضبطها إلى `true` في Redeploy واحد فقط لتحديث كلمة مرور المدير الموجود، ثم احذفها أو أعدها إلى `false` بعد نجاح الدخول. |
| `JWT_SECRET`, `JWT_REFRESH_SECRET` | مطلوبة أمنياً | توقيع رموز الدخول وتجديدها؛ يجب أن تكون قيمتين مختلفتين وقويتين. |
| `ENCRYPTION_KEY` | مطلوبة أمنياً | تشفير البيانات الحساسة؛ استخدم 64 محرفاً سداسياً. |
| `SESSION_ENCRYPTION_KEY` | مطلوبة عند استخدام Telegram/استعادة الجلسات | تشفير جلسات Telegram المخزنة. |
| `TELEGRAM_API_ID`, `TELEGRAM_API_HASH` | اختيارية | مطلوبة فقط لميزات Telegram التي تستخدم MTProto. |
| `GEMINI_ENABLED`, `GEMINI_API_KEY` وبقية إعدادات Gemini | اختيارية | مطلوبة فقط عند تفعيل ميزات Gemini؛ اترك `GEMINI_ENABLED=false` إن لم يكن المفتاح متاحاً. |
| `GEMINI_API_VERSION`, `GEMINI_CONCURRENCY`, `GEMINI_MAX_RETRIES`, `GEMINI_MODEL`, `GEMINI_RPM`, `GEMINI_TIMEOUT_MS` | اختيارية | إعدادات Gemini ولها قيم افتراضية في التطبيق. |
| `ADMIN_TELEGRAM_IDS` | اختيارية | ربط معرفات Telegram بصلاحيات المدير عند استخدام هذا التكامل. |

لإعادة تعيين كلمة مرور مدير موجود، أضف `RESET_ADMIN_PASSWORD=true` مؤقتاً إلى خدمة التطبيق، ثم نفّذ Redeploy. بعد نجاح تسجيل الدخول، احذف المتغير أو أعده إلى `false` ثم نفّذ Redeploy آخر حتى لا تُستبدل كلمة المرور مستقبلاً.

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
