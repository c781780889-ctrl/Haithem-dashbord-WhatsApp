# Production Health Checks

## Endpoints

| Endpoint | المعنى | السلوك |
|---|---|---|
| `GET /health` | Liveness | يثبت أن عملية Node.js حية ويرد بسرعة دون اتصال خارجي. |
| `GET /health/ready` | Readiness | يثبت اكتمال bootstrap والاستعداد لاستقبال الطلبات. |
| `GET /health/database` | PostgreSQL | يفحص اتصال `SELECT 1` بمهلة قصيرة ولا يكشف تفاصيل الخطأ. |
| `GET /health/redis` | Redis | يفحص `PING` ولا يعرض عنوان الاتصال أو الأسرار. |
| `GET /health/deep` | فحص شامل | يجمع PostgreSQL وRedis وحالة حسابات WhatsApp باستخدام `Promise.allSettled`. |
| `GET /metrics` | Prometheus | يعرض مؤشرات تشغيلية، ويحمي بمفتاح `METRICS_SECRET` عند الحاجة. |

## Response policy

تُستخدم `200` لـ liveness والخدمات السليمة، و`503` عند فشل dependency في الفحص الخاص بها. لا تحتوي الاستجابات على كلمات مرور أو URLs أو عناوين داخلية أو stack traces أو معلومات PostgreSQL التفصيلية.

## Authentication failure

عند تعطل PostgreSQL أثناء تسجيل الدخول، يسجل الخادم التفاصيل داخليًا ويرجع `503` مع رسالة عامة مثل «قاعدة البيانات غير جاهزة حاليًا». لا يعرض للمستخدم connection string أو اسم المضيف أو stack trace.

## Railway configuration

يفضل أن يكون health check الخاص بـ Railway هو `/health` حتى لا يؤدي توقف dependency مؤقت إلى restart loop. يستخدم `/health/ready` للمراقبة والتوجيه بعد اكتمال bootstrap. راجع إعداد Volume وحالة Deploy وRestart Policy في Railway قبل تغيير مسار health check [1].

## تحقق ما بعد النشر

يجب إثبات قبول PostgreSQL للاتصالات، ورد Redis بـ `PONG`، وسلامة BullMQ، وبدء Node.js، ونجاح تسجيل الدخول، وفتح Dashboard، واتصال Socket.IO، ووجود مساحة كافية، وعدم ظهور `No space left on device` أو `database system is not yet accepting connections`.

## References

[1]: https://docs.railway.com/volumes/reference "Railway Volumes Reference"
[2]: https://www.postgresql.org/docs/current/routine-vacuuming.html "PostgreSQL Routine Vacuuming"
