ممتاز! الملف جاهز والاسم صح. الحين **اضغط على المحرر الأبيض** والصق هذا المحتوى:

---

```markdown
<div dir="rtl">

# WhatsApp Enterprise Dashboard

لوحة تحكم متكاملة لإدارة بوت واتساب — تصميم احترافي بمستوى الشركات الكبرى.

## هيكل المشروع

```
whatsapp-dashboard-new/
├── Dockerfile
├── backend/            ← Node.js + Express + PostgreSQL + Redis
│   ├── index.js
│   ├── package.json
│   └── src/
│       ├── api/
│       ├── bot/
│       ├── database/
│       └── scheduler/
└── frontend/           ← React + TypeScript + Tailwind v4 + shadcn/ui
    ├── vite.config.ts
    ├── tsconfig.json
    └── src/
        ├── App.tsx
        ├── index.css       ← Design tokens (Dark + Light)
        ├── components/
        │   ├── layout/     ← Sidebar, TopBar, AppLayout
        │   └── ui/         ← shadcn/ui components
        ├── views/          ← جميع الصفحات
        └── utils/
```

## أقسام لوحة التحكم

| المسار | القسم |
|--------|--------|
| `/` | الرئيسية — إحصائيات + رسوم بيانية |
| `/accounts` | إدارة الحسابات — إضافة / ربط QR / حذف |
| `/campaigns` | الحملات — معالج 5 خطوات |
| `/ad-library` | مكتبة الإعلانات |
| `/direct-publish` | النشر المباشر |
| `/schedules` | النشر المجدول |

## تشغيل محلي

شغّل PostgreSQL وRedis أولًا، ثم جهّز متغيرات البيئة. بعد ذلك نفّذ كل مجموعة أوامر في طرفية مستقلة:

```bash
# Backend
cd backend
npm ci
cp .env.example .env
# عدّل .env ثم شغّل الخادم
node index.js
```

```bash
# Frontend — طرفية مستقلة
cd frontend
npm ci
npm run dev
```

## Docker

يتطلب تشغيل النسخة الكاملة PostgreSQL وRedis. للتشغيل المحلي، انسخ ملف البيئة ثم ضع قيمًا حقيقية للمتغيرين `DATABASE_URL` و`REDIS_URL` قبل تشغيل الحاوية.

```bash
cp backend/.env.example backend/.env
# عدّل backend/.env ولا ترفع الملف إلى GitHub
docker build -t wa-dashboard .
docker run --env-file backend/.env -p 8080:5000 wa-dashboard
```

يستمع التطبيق داخل الحاوية على `PORT` الذي تحدده المنصة، أو على `5000` افتراضيًا محليًا.

**برمجة: المهندس / هيثم العقلاني**


## 🛠️ التقنيات المستخدمة

### الخلفية
- Node.js 20 + Express 5
- Socket.IO 4
- PostgreSQL
- Redis + BullMQ
- Baileys (واجهة واتساب)
- JWT للمصادقة

### الواجهة الأمامية
- React + Vite
- Socket.IO Client

---

## النشر على Railway

ملف `railway.json` يحدد استخدام `Dockerfile` ومسار فحص الصحة `/health`. سبب توقف الخدمة إذا ظهرت الرسالتان `DATABASE_URL is required` و`REDIS_URL is required` هو أن التطبيق يعتمد على PostgreSQL وRedis ولا يستطيع إنشاء اتصالاته بدونهما.

أنشئ مشروعًا جديدًا واربطه بالمستودع، ثم أضف خدمتين داخل المشروع من Railway: **PostgreSQL** و**Redis**. بعد ذلك، في خدمة التطبيق، أضف مراجع المتغيرات التالية من الخدمتين، باستخدام أسماء الخدمات الفعلية إذا كانت مختلفة:

```text
DATABASE_URL=${{Postgres.DATABASE_URL}}
REDIS_URL=${{Redis.REDIS_URL}}
```

إذا سمّيت الخدمتين باسم مختلف، استبدل `Postgres` و`Redis` بالاسم الظاهر في Railway. لا تضف `PORT` يدويًا؛ Railway يحقنه تلقائيًا.

### مراقبة مساحة PostgreSQL

يحتوي الخادم على مراقب دوري مستقل عن فتح لوحة التحكم، يقيس حجم قاعدة البيانات الحالية باستخدام PostgreSQL، ثم يقارنه بالسعة التخزينية المخصصة للخدمة. يطبق المراقب مستويات `70% Warning` و`80% High Risk` و`90% Critical` و`95% Emergency Warning` و`98% Emergency Mode`. عند 80% فأعلى يُحلل أكبر الجداول والفهارس وWAL والملفات المؤقتة وReplication Slots، ويعرض السبب والتوصيات. عند 90% يمكنه تنفيذ `VACUUM (ANALYZE)` آمنًا على الجداول ذات الصفوف الميتة فقط؛ ولا يحذف بيانات أو فهارس أو Replication Slots. عند 95% و98% يعلن حالة الطوارئ ويمنع النظام أي تنظيف خطِر، بينما إيقاف المهام غير الأساسية يعتمد على تكامل كل مهمة مع حالة الطوارئ ولا يوقف العمليات الأساسية.

تُحفظ القياسات والأحداث والإجراءات في PostgreSQL، وتظهر الحالة في صفحة **مساحة PostgreSQL** داخل قسم الإدارة، مع تحديث دوري. يستخدم النظام قفلًا استشاريًا لمنع التنفيذ المكرر عند تشغيل أكثر من نسخة من الخادم، ويرسل التنبيه مرة واحدة عند تغير المستوى ثم يعيد إرساله عند تغير المستوى أو العودة للحالة الطبيعية.

اضبط `POSTGRES_STORAGE_LIMIT_BYTES` على السعة الفعلية المخصصة من مزود PostgreSQL. ويمكن تغيير الحد أو الفاصل الزمني عند الحاجة:

| المتغير | الوصف | القيمة الافتراضية |
|---|---|---|
| `POSTGRES_STORAGE_LIMIT_BYTES` | السعة القصوى لقاعدة البيانات بالبايت؛ تفعيل هذا المتغير مطلوب للمراقبة | غير محددة، والمراقب متوقف |
| `POSTGRES_STORAGE_ALERT_THRESHOLD_PERCENT` | نسبة إطلاق التنبيه | `70` |
| `POSTGRES_STORAGE_MONITOR_INTERVAL_MS` | الفاصل بين الفحوصات بالميلي ثانية | `60000` |
| `POSTGRES_STORAGE_AUTO_VACUUM` | تشغيل `VACUUM (ANALYZE)` الآمن عند 90% فأعلى | `true` |

أضف كذلك المتغيرات الأساسية الآتية في خدمة التطبيق:

| المتغير | القيمة أو الوصف |
|---|---|
| `NODE_ENV` | `production` |
| `JWT_SECRET` | قيمة عشوائية طويلة لا تقل عن 32 حرفًا |
| `JWT_REFRESH_SECRET` | قيمة عشوائية مختلفة لا تقل عن 32 حرفًا |
| `ADMIN_USERNAME` | اسم مستخدم الإدارة |
| `ADMIN_PASSWORD` | كلمة مرور قوية |
| `ENCRYPTION_KEY` | 64 محرفًا سداسيًا عشريًا، مثل ناتج `openssl rand -hex 32` |
| `SESSION_ENCRYPTION_KEY` | سر طويل عشوائي لتشفير جلسات Telegram |
| `CORS_ORIGINS` | اتركه فارغًا أولًا أو ضع رابط التطبيق بعد إنشائه |

بعد حفظ المتغيرات، أعد النشر. يجب أن يعرض السجل `Listening on port ...` ثم ينجح فحص `GET /health`. لا ترفع `backend/.env` ولا تضع أي أسرار في GitHub.

---

## 🔒 ملاحظات الأمان

- لا ترفع ملف `.env` على GitHub
- استخدم كلمة مرور قوية لحساب الإدارة

</div>
