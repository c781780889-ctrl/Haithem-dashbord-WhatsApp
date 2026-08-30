# تدقيق أولي — أتمتة الانضمام لروابط واتساب

## النطاق

تمت مراجعة المتطلبات المرفقة وتطبيقها على المسار القديم الخاص بواتساب مع الإبقاء على مساراته وعدم خلطه بمسارات Telegram v2.

| المجال | الحالة قبل التعديل | الملاحظة |
|---|---|---|
| Frontend | PASS جزئي | صفحة واتساب موجودة، لكنها كانت مستعادة باسم ومسار جديدين وتحتاج ربطًا واضحًا ببقية العقد. |
| API | PASS جزئي | المسارات القديمة تعمل، وبعض الاستجابات لا تستخدم Envelope موحدًا أو Idempotency موحدة. |
| Database | PASS جزئي | الجداول تحتوي Lease وHeartbeat وFK أساسية، لكن لا يوجد Outbox أو سجل Verification مستقل أو FK لحساب المستخدم. |
| Queue | PASS جزئي | Queue انضمام واكتشاف موجودتان، لكن Create Task يعتمد على جدولة مباشرة بعد الإنشاء. |
| Worker | PASS جزئي | Pipeline join/publish/leave موجود، والقفل الحالي Account-level فقط. |
| WhatsApp Runtime | PASS جزئي | GroupJoinerService ينفذ الانضمام ويتحقق من العضوية، لكن Recovery لا يعيد فحص العضوية قبل إعادة المحاولة. |
| Security | PASS جزئي | توجد ملكية على معظم الاستعلامات، وتحتاج عمليات Mutation إلى Idempotency/Audit موحدين. |
| Ownership Isolation | PASS | استعلامات الحسابات والمهام مرتبطة بـ user_id، مع حاجة لتقوية بعض مسارات الإدارة. |
| Role Isolation | N/A | واتساب لا يستخدم SEARCH_ROLE/JOIN_ROLE؛ الفصل هنا بين Discovery وJoin capabilities مع بقاء WhatsApp Manager مشتركًا. |
| Idempotency | FAIL جزئي | مفتاح العملية موجود، لكن Create Task وSearch وImport والتحكم لا تملك آلية Replay موحدة. |
| Recovery | PASS جزئي | يوجد watchdog للـ stale processing، لكنه يعيد Queue دون فحص عضوية واتساب. |
| Concurrency | FAIL جزئي | Redis Account Lock ينسق داخل المسار، لكنه ليس ضمانًا كافيًا وحده عبر replicas عند تعذر Redis. |
| Retry | PASS جزئي | Retry وتصنيف الأخطاء موجودان، ويحتاجان توحيدًا مع نتائج `already_joined` و`pending_approval`. |
| Live Events | PASS جزئي | الأحداث محفوظة وتبث عبر Socket، لكن Socket يجب أن يبقى قناة تحديث لا مصدر حقيقة. |
| Error Mapping | PASS جزئي | GroupJoinerService يعيد حالات منظمة، ويحتاج حفظ نتيجة العضوية ودليل التحقق. |
| UI State | PASS جزئي | الواجهة تعرض مراحل وHealth، وتحتاج عرض Verification وWorker/Heartbeat الحقيقيين بوضوح. |
| E2E | UNVERIFIED | لا توجد جلسات واتساب اختبارية حيّة متاحة داخل البيئة الحالية. |

## قرارات الإصلاح

سيتم تنفيذ Hardening داخل `LinkImportService` و`GroupJoinerService` و`LinkImportMigrations` وController والواجهة. لن يتم حذف Legacy paths، ولن يتم تغيير نموذج Telegram أو Queue الخاصة به. ستستخدم المهام Transaction + Outbox، وسيصبح Recovery غير أعمى، وسيُضاف قفل PostgreSQL للعملية مع استمرار Redis كتحسين أداء.


## نتيجة التطبيق — WhatsApp Hardening

تم تطبيق الإصلاحات التالية على قسم أتمتة الانضمام لروابط واتساب مع الحفاظ على مسارات Legacy القديمة:

| الطبقة | ما تم تطبيقه |
|---|---|
| Namespace | إضافة `/api/whatsapp/join-automation/*` و`/api/whatsapp/link-import/*` و`/api/whatsapp/links/export`، مع إبقاء `/api/telegram/*` القديمة للتوافق فقط. |
| Transaction | أصبح إنشاء المهمة والعمليات وتحديث حالة الروابط وكتابة Outbox داخل معاملة PostgreSQL واحدة. |
| Outbox | Queue durable باسم `wa-link-outbox` مع Claim ذري، Lease، Worker ID، Retry، واستعادة سجلات `PROCESSING` العالقة. |
| Idempotency | دعم `Idempotency-Key` للبحث وإنشاء المهمة والاستيراد، مع Replay لنفس النتيجة عند إعادة إرسال الطلب. |
| State Machine | منع الانتقالات غير المسموحة للمهمة، ومنع استئناف Task متوقفة نهائيًا. |
| Locking | Advisory Lock للعملية بالإضافة إلى Account Lock الحالي، مع إعادة جدولة عند تعارض النسخ. |
| Heartbeat | تحديث Heartbeat وLease كل 30 ثانية أثناء عمليات الانضمام الطويلة. |
| Verification | حفظ `membership_state` و`verification_evidence`، ومعاملة `already_joined` كـ `ALREADY_MEMBER` ناجحة idempotent. |
| Recovery | فحص عضوية WhatsApp قبل إعادة Join بعد Crash أو انتهاء Lease، وعدم إعادة الانضمام بشكل أعمى. |
| Import | دعم DOC/DOCX/TXT/CSV/JSON/XLSX بحد 10MB، مع تنظيف وتوحيد ومقارنة قبل الحفظ. |
| Audit | إضافة `link_import_audit_logs` وتنقية Session/Token/Secret/API Hash من الحالات المسجلة. |
| Live Events | إضافة `whatsapp:new_link` و`whatsapp:link_duplicate` مع إبقاء الأحداث القديمة لمنع Regression. |
| UI | تحويل صفحة واتساب إلى Namespace مستقل، وإظهار `ALREADY_MEMBER` و`Verification` ضمن جدول العمليات، مع Idempotency للبحث والمهمة والاستيراد. |

## التحقق بعد التطبيق

| الاختبار | النتيجة |
|---|---|
| Node syntax checks للملفات المعدلة | PASS |
| `git diff --check` | PASS |
| Backend suites | `14/14 PASS` |
| Backend tests | `48/48 PASS` |
| Frontend production build | PASS |
| Telegram regression suite | PASS ضمن الاختبارات الحالية |
| Redis/PostgreSQL live integration | UNVERIFIED داخل بيئة الاختبار |
| WhatsApp live join/recovery E2E | UNVERIFIED لعدم توفر جلسات اختبار حقيقية |

> لا يتم اعتبار Membership Verification أو Crash Recovery أو التزامن متعدد النسخ اختبارًا حيًا إلا بعد تشغيل بيئة اختبار تحتوي على PostgreSQL وRedis وحسابات WhatsApp مخصصة ومجموعات اختبارية غير حساسة.

## ملاحظة تشغيلية

يُطبق مخطط قاعدة البيانات تلقائيًا عند إقلاع الخادم عبر Migration Runner. يجب إعادة تشغيل Backend بعد النشر حتى تُنشأ الأعمدة والجداول والفهارس الجديدة. لا تُستخدم هذه الميزة للتحايل على قيود واتساب أو تنفيذ دفعات غير مصرح بها؛ الإعدادات المحافظة والإيقاف عند التقييد مقصودة لحماية الحسابات.

## الإصدار

`WhatsApp Join Automation — Production Hardening 1.0.0`

تاريخ التوثيق: 2026-08-25

الخلاصة: تم سد الفجوات البرمجية الأساسية في WhatsApp Join Automation مع الإبقاء على التوافق الخلفي. يبقى الاختبار الحي متعدد النسخ مسؤولية بيئة التشغيل الفعلية، وليس شيئًا يمكن إثباته من Unit Tests فقط.
