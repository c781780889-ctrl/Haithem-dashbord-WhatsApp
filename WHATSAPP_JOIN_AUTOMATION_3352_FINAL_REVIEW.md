# المراجعة النهائية لقسم أتمتة الانضمام لروابط WhatsApp

**المشروع:** `whatsapp-dashboard-new`  
**الغرض:** توثيق التحقق النهائي من تطبيق متطلبات `3352.md` على قسم `Dashboard → أتمتة الانضمام لروابط WhatsApp`.  
**نطاق المراجعة:** Backend، PostgreSQL، Redis/BullMQ، Worker، WhatsAppManager/Baileys، Recovery، Outbox، Dashboard، Metrics، الاختبارات، ومسارات الحظر وإعادة الاتصال.  
**تاريخ المراجعة:** 25 أغسطس 2026.  
**حالة الأتمتة الموصى بها:** متوقفة إلى أن يتم تنفيذ Canary محدود بحساب مصرح وغير محظور.

> هذا التقرير يميز بين ما تم إثباته من الكود والاختبارات، وما يحتاج تحققًا على Railway أو WhatsApp الحقيقي. لا توجد قيمة Delay أو Circuit Breaker يمكن اعتبارها ضمانًا لعدم حظر WhatsApp؛ الحماية هنا لحماية النظام من التكرار وسوء الجدولة، وليست وسيلة للتحايل على سياسات المنصة.

---

## 1. الخلاصة التنفيذية

تم تطبيق طبقات الحماية الأساسية المطلوبة في `3352.md`. أصبح مسار أتمتة الانضمام يعتمد على حالة الحساب قبل الجدولة وقبل Dispatch وقبل تنفيذ Worker. عند وصول إشارة `403/forbidden` يتم فتح **Hard Stop** دائم للحساب، وإيقاف عمليات الانضمام المستقبلية، وإلغاء Outbox والـJobs المنتظرة، ومنع Retry وRecovery وReconnect الآلي بغرض استئناف الانضمام. الحساب المحظور لا يتحول تلقائيًا إلى Active.

تم أيضًا إصلاح مصدر Queue churn الرئيسي الذي كان يسمح بتكرار Job أو اصطدام التأجيل بالـJob النشطة نفسها. أصبحت مسارات pacing وadvisory lock وretry وwait تستخدم Scheduling Coordinator واحدًا هو `requestReschedule`. يتم حفظ `next_run_at` وسبب التأجيل وعداد `reschedule_count`، ثم استخدام Outbox فريد وJob مستقبلية ذات معرف ثابت. عند تجاوز 100 إعادة جدولة لعملية واحدة، تُنقل العملية إلى `REVIEW` ويُفتح Circuit Breaker بسبب `QUEUE_CHURN`.

أضيفت طبقة Circuit Breaker دائمة لكل حساب، ومؤشرات Prometheus منفصلة للـJoin الحقيقي والـQueue، وحقول تدقيق موسعة للأحداث، وزرا **إيقاف طارئ كامل** و**إيقاف حساب واحد** في لوحة التحكم. كما تم إغلاق ثغرة Retry اليدوي التي كانت تسمح بتصفير عملية محمية قبل فحص حالة الحساب.

الاختبارات المحلية الحالية ناجحة: **16 مجموعة اختبار و60 اختبارًا**. بناء الواجهة Production ناجح. لم يتم تنفيذ اختبار E2E حي على حساب WhatsApp حقيقي، ولم يتم اعتبار Railway ناجحًا لمجرد أنه يعرض `healthy`؛ يجب التأكد بعد النشر من SHA وLogs وRedis وPostgreSQL وعدد Workers.

---

## 2. الأدلة التي بُنيت عليها المراجعة

اعتمد التحقيق على سجل الحظر السابق والصور المرفقة وتقارير المشروع وملف `3352.md`. الأدلة التشغيلية السابقة أثبتت ظهور `403/forbidden` وتصنيف الحساب `BANNED`، وظهور كثافة Jobs في `wa-link-imports`، وظهور `503 temporary disconnected` ثم Reconnect، ثم إلغاء عمليات وJobs بعد الحظر. كما ظهر خطأ برمجي لاحق هو:

```text
ReferenceError: isConfirmedBan is not defined
```

لا يثبت عدد Jobs المكتملة أن العدد نفسه من عمليات الانضمام حدث داخل WhatsApp. لذلك تم الفصل بين:

| المصطلح | ما يثبته فعليًا |
|---|---|
| `worker_completed` | انتهى Handler الخاص بالـWorker وأعاد نتيجة تشغيلية. |
| `join_started` | بدأ النظام استدعاء عملية الانضمام إلى WhatsApp. |
| `join_result_received` | وصلت نتيجة من طبقة تنفيذ WhatsApp. |
| `join_completed` | حفظ النظام نتيجة Join داخل العملية مع دليل النتيجة. |
| `JOINED` | نجاح فعلي أو نتيجة قبول موثقة بحسب سياسة GroupJoiner. |
| `PENDING_APPROVAL` | تم إرسال طلب انضمام يحتاج موافقة، ولا يعني موافقة المشرف. |

الاستنتاج المرجح من السجل السابق هو Queue churn وتداخل مسارات pacing وadvisory lock وrecovery وإعادة الجدولة. هذا استنتاج تشغيلي مرجح وليس إثباتًا بأن كل Job كانت Join فعلية أو أن سبب الحظر الوحيد هو Queue.

---

## 3. خريطة المسار بعد التحديث

أصبح المسار المنطقي للقسم كما يلي:

```text
Dashboard / API
    ↓
PostgreSQL: link_import_tasks + link_import_operations
    ↓
Scheduling Coordinator: requestReschedule
    ↓
PostgreSQL Outbox: link_import_outbox
    ↓
Outbox dispatch بعد فحص automation_enabled والحساب والعملية
    ↓
BullMQ: wa-link-imports
    ↓
Worker: process_link_import_operation أو advance_link_import_cycle
    ↓
Distributed account lock + operation lease
    ↓
فحص task / emergency stop / account guard / idempotency / pacing
    ↓
GroupJoinerService → WhatsApp/Baileys
    ↓
join_result_received ثم تصنيف النتيجة
    ↓
PostgreSQL: Join status + timestamps + cycle counters + evidence
    ↓
join_completed أو join_failed أو retry_scheduled أو account_protected
    ↓
requestReschedule للعملية التالية فقط عند أهلية الحساب
    ↓
Dashboard + Socket events + Prometheus metrics
```

المسارات الرئيسية التي تم تدقيقها هي:

| نوع المسار | الموضع الأساسي | القرار بعد التحديث |
|---|---|---|
| Producer العادي | `LinkImportService.scheduleNextOperation` و`scheduleAccountOperation` | لا ينشئ Job مباشرة خارج Outbox، ويفحص الحساب. |
| Producer التأجيل | `requestReschedule` | يحفظ الموعد والسبب والعداد ويستخدم Outbox واحدًا. |
| Producer pacing | `deferForAccountPacing` | يستدعي Coordinator ولا ينشئ Job منفصلة. |
| Producer lock | `processOperation` عند تعذر advisory lock | يستدعي Coordinator مع Job مستقبلية `-future`. |
| Producer retry | مسار نتيجة Join المؤقتة | يستدعي Coordinator مع backoff محدود. |
| Producer recovery | `recoverPendingOperations` | يفحص Guard وLease قبل الاستعادة، ويمنع الاستعادة للحساب المحمي. |
| Producer cycle wakeup | `enqueueLinkImportCycle` | Job ثابتة للدورة التالية. |
| Consumer | `QueueManager` و`backend/index.js` | يعالج Jobs ويعيد نتيجة Worker منظمة. |
| Outbox consumer | `dispatchOutbox` | يفحص حالة الأتمتة والعملية والحساب قبل إنشاء Job. |
| Reconnect | `WhatsAppManager` | 403 وlogout وbadSession لا تعيد الاتصال الآلي؛ 503 يخضع للقاطع. |

---

## 4. المشاكل التي تم اكتشافها وإصلاحها

### 4.1 الخلط بين Queue completed وWhatsApp joined

**المشكلة:** كانت رسالة `Job completed` في Railway قابلة للفهم الخاطئ كأنها نجاح Join. لكنها تعني فقط أن Handler انتهى دون Exception غير معالج.

**الإصلاح:** غُيّر سجل Worker في `QueueManager.js` إلى Structured JSON بالحدث `worker_completed` مع:

- `queue`.
- `jobId` و`jobName`.
- `operationId` و`accountId`.
- `outcome`.
- `joinStatus`.
- `reason`.
- الوقت.

أصبحت نتيجة Join منفصلة عبر أحداث `join_started` و`join_result_received` و`join_completed` و`join_failed`.

### 4.2 تكرار Jobs عند اصطدام القفل

**المشكلة:** كان قفل الحساب يمنع التنفيذ المتزامن لكنه لا يمنع إنشاء Jobs كثيرة. وكان التأجيل السريع قد يسبب السلسلة التالية:

```text
Lock unavailable → Job بعد عدة ثوانٍ → Lock unavailable → Job جديدة
```

**الإصلاح:** أصبح المسار:

```text
Lock unavailable
→ حساب next_run_at
→ حفظ سبب lock_deferred
→ Outbox واحد
→ Job مستقبلية واحدة
→ انتهاء Worker الحالي
```

وعند إعادة الجدولة من داخل Worker تستخدم العملية Job ID من نوع `link-import-op-{operationId}-future` حتى لا تتعارض مع Job النشطة الحالية.

### 4.3 استخدام Job النشطة نفسها كJob مستقبلية

**المشكلة التي اكتُشفت أثناء المراجعة الثانية:** كان `requestReschedule` يستخدم أحيانًا نفس `jobId` الخاص بالعملية النشطة. إذا كان BullMQ يرى Job في حالة `active`، فإن إضافة Job بالمعرف نفسه لا تنشئ Job مستقبلية حقيقية.

**الإصلاح:** تمت إضافة تمييز آلي لمسارات `lock_deferred` و`pacing_deferred` و`retry_scheduled` و`wait_scheduled`، وإضافة اللاحقة `-future` للـJob التي تُنشأ من داخل Worker.

### 4.4 ازدواجية Producer لنفس العملية

**المشكلة:** Normal scheduler وRetry وRecovery وpacing وOutbox كانت نقاطًا متعددة يمكنها محاولة إنشاء Job للعملية نفسها.

**الإصلاح:**

- مفتاح Outbox فريد على `(aggregate_type, aggregate_id, event_type)`.
- Job ID ثابت للعملية.
- معالجة `EJOBEXISTS` ورسائل التكرار داخل `QueueManager`.
- إعادة استخدام Job القائمة.
- استخدام `changeDelay` إذا كانت Job القائمة في `delayed` أو `waiting` أو `prioritized`.
- عدم إعادة تشغيل العملية إذا كانت في `success` أو `failed` أو `skipped` أو `review`.

### 4.5 Retry اليدوي كان يتجاوز الحماية

**المشكلة:** كان Endpoint إعادة المحاولة اليدوية يصفر العملية إلى `retry` ثم يجدولها قبل التحقق من حالة الحساب. هذا كان يسمح بتغيير حالة العملية حتى لو كان الحساب محميًا أو محظورًا.

**الإصلاح:** صار Endpoint:

- يتحقق من صلاحية التشغيل.
- يقرأ حالة الحساب و`health_status` و`task_status` وCircuit Breaker.
- يرفض الحساب المحظور أو المحمي أو المتوقف أو الأتمتة المعطلة.
- يسمح فقط بإعادة محاولة عملية في حالة نهائية مناسبة.
- يستخدم Job ID ثابتًا دون `Date.now()`.

### 4.6 Outbox كان يحتاج فحصًا نهائيًا قبل Dispatch

**المشكلة:** قد يكون Outbox موجودًا قبل الضغط على Emergency Stop، ثم يحاول Dispatch لاحقًا.

**الإصلاح:** قبل إنشاء أي BullMQ Job، يفحص `dispatchOutbox`:

- وجود العملية.
- عدم كونها نهائية.
- `automation_enabled` العامة.
- Circuit Breaker وحالة الحساب.
- ثم يلغي Outbox مع تسجيل `outbox_blocked` إذا لم تكن العملية مؤهلة.

### 4.7 خطأ `isConfirmedBan`

**المشكلة:** ظهر ReferenceError لاحق داخل مسار الحظر، ما كان يهدد بإيقاف تنفيذ جزء من المعالجة بعد وصول إشارة 403.

**الإصلاح:** تمت مراجعة مسار WhatsAppManager واستخدام سياسة `AccountProtectionPolicy` بأسماء معرفة وواضحة، مع التأكد من عدم وجود مرجع نصي لـ`isConfirmedBan` في Backend أو Frontend. كما أن تسجيل الحماية والتنظيف والإيقاف محمي بمسارات مستقلة و`catch` حتى لا يمنع خطأ ثانوي تطبيق حالة الحظر.

### 4.8 Reconnect بعد 503 و403

**المشكلة:** نجاح Reconnect لا يعني أن Join يجب أن يبدأ. كما أن إعادة الاتصال بعد 403 قد تعيد النشاط للحساب المحظور.

**الإصلاح:**

- `403`: لا Reconnect آلي، لا Retry، لا Recovery، لا Outbox، لا Join.
- `loggedOut` و`badSession`: لا Reconnect آلي ضمن مسار Join.
- `503`: يسجل كحالة مؤقتة، ويزيد عداد الحماية. عند 3 إشارات متتابعة خلال 10 دقائق يفتح Circuit Breaker.
- الاتصال اليدوي للحساب المحمي مسموح فقط لإعادة الفحص، وليس لاستئناف Join تلقائي.
- الحساب الذي وصل إلى `status='banned'` يرفض حتى مسار الاتصال اليدوي من Manager إلى أن تتم مراجعة WhatsApp الرسمية.

### 4.9 فقدان حالة الدورة أو مضاعفتها بعد Restart

**المشكلة:** Recovery غير المنضبط قد يعيد كل العمليات أو ينشئ Jobs جديدة لكل صف في قاعدة البيانات.

**الإصلاح:** تحفظ الدورة والعملية في PostgreSQL، ويقرأ Recovery الحساب وGuard وLease و`next_run_at` قبل أي استعادة. العملية المحمية تنتقل إلى `REVIEW`، والعملية المؤهلة تستخدم Job واحدة فقط. لا يتم إنشاء الدورة التالية إذا كانت الأتمتة العامة متوقفة أو الحساب غير مؤهل.

### 4.10 غياب Metrics تشغيلية كافية

**المشكلة:** كان من الصعب التمييز بين عدد Jobs وعدد الانضمامات الفعلية أو اكتشاف Queue churn من القياسات.

**الإصلاح:** أضيفت مؤشرات Prometheus في `MetricsMiddleware.js`، منها:

| المقياس | الدلالة |
|---|---|
| `wad_join_started_total` | محاولات Join التي بدأت فعليًا. |
| `wad_join_completed_total` | نتائج Join التشغيلية مع `join_status`. |
| `wad_join_failed_total` | نتائج الفشل مع السبب. |
| `wad_join_deferred_total` | عمليات التأجيل مع السبب. |
| `wad_queue_job_created_total` | Jobs أنشئت فعليًا بعد نجاح `queue.add`. |
| `wad_queue_job_duplicate_blocked_total` | محاولات التكرار التي تم منعها. |
| `wad_recovery_attempt_total` | محاولات Recovery. |
| `wad_retry_total` | Retries المجدولة. |
| `wad_account_protection_total` | أحداث حماية الحساب. |
| `wad_account_ban_signal_total` | إشارات 403 أو الحظر. |
| `wad_connection_503_total` | إشارات الانقطاع 503. |
| `wad_connection_403_total` | إشارات 403. |
| `wad_active_jobs_per_account` | عدد العمليات النشطة لكل حساب من Dashboard. |
| `wad_future_jobs_per_account` | عدد العمليات المفتوحة أو المستقبلية لكل حساب. |

---

## 5. حالة الحساب وCircuit Breaker

### 5.1 الحالات المستخدمة

يستخدم النظام مزيجًا من حالة الحساب الأساسية وحالة الحماية وحالة المهمة:

| الحقل | القيم المهمة | المعنى |
|---|---|---|
| `accounts.status` | `connected`, `disconnected`, `banned` | حالة الاتصال/الحظر الأساسية. |
| `accounts.health_status` | `unknown`, `protected`, `blocked` | سلامة الحساب وأهليته التشغيلية. |
| `accounts.task_status` | `idle`, `stopped` | السماح أو المنع من الأتمتة. |
| `link_import_account_guards.circuit_state` | `CLOSED`, `OPEN` | السماح أو المنع على مستوى الحماية. |
| `reason_code` | `ACCOUNT_BANNED`, `CONNECTION_503_STORM`, `QUEUE_CHURN`, `MANUAL_ACCOUNT_STOP` | سبب فتح الحماية. |

### 5.2 قواعد الانتقال

```text
ACTIVE → COOLDOWN/التأجيل عند انتهاء Join أو وجود pacing
ACTIVE → PAUSED عند إيقاف المهمة أو Emergency Stop
ACTIVE → PROTECTED عند Rate Limit أو restriction أو Queue churn
ANY → BANNED عند 403/forbidden
BANNED → BANNED تلقائيًا
BANNED → ACTIVE آليًا: ممنوع
PROTECTED → CLOSED: إعادة فحص يدوي فقط وبعد جاهزية مستقلة
```

### 5.3 403 Hard Stop

عند `403/forbidden` ينفذ `_handleAccountBanned` و`_excludeFromAllCampaigns`، ويكتب:

```text
accounts.status = banned
accounts.health_status = protected
accounts.task_status = stopped
link_import_account_guards.circuit_state = OPEN
link_import_account_guards.reason_code = ACCOUNT_BANNED
```

ثم يتم:

1. إلغاء Jobs الانتظارية والمؤجلة للحساب.
2. إلغاء Outbox المفتوح للحساب.
3. إيقاف عمليات Link Import للحساب.
4. استبعاد الحساب من الحملات والجداول المرتبطة.
5. إرسال حدث للوحة.
6. الاحتفاظ بالسجل وعدم حذف الحساب تلقائيًا.
7. منع Reconnect الآلي لغرض استئناف Join.

---

## 6. دورة العملية والـIdempotency

كل عملية Join مرتبطة بـ:

- `operation_id`.
- `task_id`.
- `account_id`.
- `link_id`.
- `cycle_id`.
- `idempotency_key`.
- `next_run_at`.
- `queue_job_id`.
- `join_started_at` و`join_completed_at`.

يوجد قيد فريد أساسي على علاقة `task_id × account_id × link_id`، ومؤشر فريد جزئي على `idempotency_key` عندما تكون قيمته موجودة. قبل التنفيذ يفحص النظام العملية، حالتها، الحساب، القاطع، المهمة، والنتيجة السابقة. العملية النهائية لا تُعاد تلقائيًا، والعملية `REVIEW` لا تدخل Retry آليًا.

تظل Idempotency التشغيلية منفصلة عن حقيقة أن WhatsApp قد يكون قبل الطلب ثم تأخر وصول metadata. لذلك يتم حفظ `verification_evidence` و`membership_state`، ولا يتم تحويل نتيجة قبول حقيقية إلى فشل زائف بسبب تأخر قراءة الأعضاء.

---

## 7. الفصل بين Queue Lifecycle وJoin Lifecycle

### Queue Lifecycle

```text
QUEUED
→ STARTED
→ DEFERRED أو RETRY_SCHEDULED
→ WORKER_COMPLETED أو CANCELLED
```

### Join Lifecycle

```text
NOT_STARTED
→ JOIN_STARTED
→ RESULT_RECEIVED
→ JOINED أو JOINED_UNVERIFIED
أو PENDING_APPROVAL
أو FAILED
أو REVIEW
أو ACCOUNT_PROTECTED
```

الواجهة لا تعتمد على `worker_completed` لعرض الانضمام. عرض النجاح يعتمد على حالة العملية ونتيجة WhatsApp والأحداث الفعلية.

---

## 8. Event Audit Trail

تم توسيع جدول `link_import_events` ليحفظ:

- `user_id`.
- `task_id`.
- `operation_id`.
- `account_id`.
- `link_id`.
- `event_type`.
- `payload` الآمن.
- `reason`.
- `next_run_at`.
- `job_id`.
- `worker_id`.
- `created_at`.

الأحداث الرئيسية التي يستخدمها المسار:

```text
job_received
job_started
account_selected
link_resolved
join_started
join_request_started
join_result_received
join_completed
join_request_sent
join_retry
retry_scheduled
pacing_deferred
lock_deferred
wait_scheduled
operation_paused
operation_completed
operation_failed
outbox_blocked
reschedule_blocked
recovery_blocked
account_protection_triggered
account_protected
emergency_stop
account_manual_stop
cycle_started
cycle_resting
```

لا يتم تخزين Session Credentials أو Authentication Keys أو QR Payloads أو Pairing Secrets أو Tokens في أحداث هذا المسار.

---

## 9. Recovery وRestart وRailway

Recovery لا يعني تشغيل كل عملية متوقفة فورًا. المسار الجديد يفحص:

1. حالة المهمة.
2. حالة الحساب.
3. Circuit Breaker.
4. Lease ووقت انتهائه.
5. `next_run_at`.
6. وجود Outbox.
7. وجود Job مستقبلية.
8. آخر نتيجة Join.
9. حالة العملية النهائية أو `REVIEW`.

إذا كان الحساب محميًا أو محظورًا، تنتقل العملية إلى `REVIEW` ويسجل `recovery_blocked`. إذا كانت العملية مؤهلة، تعاد Job واحدة فقط عبر Coordinator.

بعد Restart يجب مراقبة أن النظام لا ينشئ Job لكل صف من قاعدة البيانات. يجب مقارنة:

```text
عدد العمليات المفتوحة في PostgreSQL
عدد Outbox PENDING/PROCESSING
عدد Jobs waiting/delayed في BullMQ
عدد Jobs ذات operationId نفسه
```

---

## 10. Emergency Stop

تمت إضافة مسارين:

```text
POST /whatsapp/join-automation/emergency-stop
POST /whatsapp/join-automation/accounts/:accountId/stop
```

### الإيقاف العام

يؤدي إلى:

- `automation_enabled=false` للمستخدم.
- إلغاء Jobs الانتظارية والمؤجلة للمستخدم.
- تحويل العمليات المفتوحة إلى `paused` وإزالة `next_run_at`.
- إلغاء Outbox المفتوح.
- إيقاف المهام المعلقة.
- تسجيل `emergency_stop`.
- الاحتفاظ بكل التاريخ.

### إيقاف حساب واحد

يؤدي إلى:

- `task_status=stopped`.
- Circuit Breaker `OPEN` مع `MANUAL_ACCOUNT_STOP`.
- إيقاف عمليات الحساب.
- إلغاء الأعمال المستقبلية.
- تسجيل `account_manual_stop`.

Job النشطة التي بدأت Join قبل الضغط لا يمكن إلغاؤها بأثر رجعي، لكن فحص الأتمتة يمنعها من جدولة أي Join جديدة بعد انتهائها.

---

## 11. Dashboard بعد التحديث

تمت إضافة عرض الحالات التالية في `WhatsAppJoinAutomationView.tsx`:

- حالة الاتصال.
- حالة الحساب.
- Hard Stop وCircuit Breaker.
- سبب الحماية.
- عداد 503.
- عداد التأجيل.
- عداد تعارضات القفل.
- Active Jobs.
- Future Jobs.
- حالة الدورة `RUNNING` أو `RESTING`.
- `JOINED` و`REQUEST` و`FAILED`.
- العملية أو الدورة التالية.
- زر إيقاف الحساب.
- زر الإيقاف الطارئ العام.
- أحداث lock وpacing وretry وoutbox وrecovery والحماية.

لا تعرض اللوحة معدلًا يسمى "آمنًا" ولا تزعم أن Delay يمنع الحظر. تعرض بيانات تشغيلية فقط.

---

## 12. Migrations والفهارس

تم تحديث `LinkImportMigrations.js` عبر `CREATE TABLE IF NOT EXISTS` و`ALTER TABLE ... ADD COLUMN IF NOT EXISTS` و`CREATE INDEX IF NOT EXISTS`، دون حذف بيانات.

أهم الإضافات:

| الجدول | الإضافة |
|---|---|
| `link_import_operations` | `reschedule_count` وحقول timestamps والحالات السابقة. |
| `link_import_events` | `reason` و`next_run_at` و`job_id` و`worker_id`. |
| `link_import_account_guards` | Circuit State وسبب الحماية وعدادات 503 والتأجيل والقفل وRecovery. |
| `link_import_outbox` | Worker وLease وحالة Outbox الفريدة. |
| الفهارس | الحساب مع الحالة، الحساب مع `next_run_at`، الدورة، الأحداث، والـOutbox الجاهز. |
| Idempotency | فهرس فريد جزئي على `link_import_operations.idempotency_key`. |

يجب تشغيل Migration على Railway قبل Canary. لا ينبغي حذف أو إعادة إنشاء جداول الإنتاج يدويًا.

---

## 13. مصفوفة التحقق مقابل 3352.md

| البند | الحالة | الدليل أو الملاحظة |
|---|---|---|
| فحص Producers وConsumers | مطبق | تمت مراجعة LinkImportService وQueueManager وWhatsAppManager وController. |
| إصلاح `isConfirmedBan` | مطبق | لا توجد مراجع لـ`isConfirmedBan` في Backend/Frontend، واختبارات سياسة الحماية تمر. |
| Hard Stop عند 403 | مطبق | `_handleAccountBanned` وGuard ووقف العمليات وOutbox. |
| عدم Reconnect بعد 403 | مطبق في الكود | Policy تمنع القرار الآلي، ويجب التحقق حيًا بعد Deploy. |
| Circuit Breaker لكل حساب | مطبق | `link_import_account_guards`. |
| حماية 503 | مطبق | ثلاث إشارات متتابعة خلال عشر دقائق تفتح القاطع. |
| حماية Queue churn | مطبق | حد `reschedule_count > 100` ينقل العملية إلى REVIEW ويحمي الحساب. |
| One future job | مطبق | Outbox فريد وJob ID ثابت و`changeDelay` و`-future`. |
| توحيد الجدولة | مطبق للمسارات المدققة | مسارات pacing/lock/retry/wait تستخدم `requestReschedule`. |
| فصل Queue عن Join | مطبق | `worker_completed` منفصل عن Join events. |
| Event Audit Trail | مطبق | حقول تدقيق إضافية وأحداث مفصلة. |
| Recovery الآمن | مطبق | Guard/Lease/حالة العملية قبل الاستعادة. |
| Restart reconciliation | مطبق في مسار Recovery | يلزم اختبار حي مع Redis وPostgreSQL. |
| فهارس وIdempotency | مطبق | Migration والفهارس الموجودة. |
| Minimum cooldown | مطبق | يستخدم آخر Join وpacing، لكنه حد تشغيلي وليس ضمانًا من WhatsApp. |
| Backoff مؤقت | مطبق | retry backoff محدود حتى 3600 ثانية. |
| Emergency Stop عام | مطبق | API وزر وحفظ التاريخ. |
| إيقاف حساب منفرد | مطبق | API وزر وGuard. |
| Dashboard تشغيلي | مطبق جزئيًا/عمليًا | يعرض الحالات والحسابات والدورات والـJobs؛ يلزم تحقق بصري بعد Deploy. |
| Incident Timeline | مطبق عبر Events وExport | يجب تجربة التصدير على بيانات حية. |
| Structured Logs | مطبق | Worker JSON وEvents DB. |
| Metrics | مطبق | Prometheus counters/gauges مضافة. |
| اختبارات Connection | مطبق جزئيًا | Policy تغطي 403 و503 وlogout وbadSession؛ لا يوجد E2E Baileys حقيقي. |
| اختبارات Queue | مطبق جزئيًا | اختبار تكرار Job موجود؛ يلزم Integration Redis للـRestart/Worker crash. |
| اختبارات State | مطبق جزئيًا | Policy وGuard في المسارات؛ يلزم اختبار Controller تكاملي. |
| اختبار 100 Producer | غير مكتمل حيًا | الحماية الذرية موجودة، لكن يلزم Integration test بقاعدة وRedis حقيقيين. |
| اختبار 10 Workers | غير مكتمل حيًا | القفل موجود، ويجب قياسه تحت Redis/PostgreSQL فعليين. |
| Deployment ID | غير متحقق | Git SHA معروف، لكن Deployment ID من Railway يجب تسجيله بعد النشر. |
| Canary | لم ينفذ | يجب إبقاء الأتمتة OFF وتشغيل Reconciliation أولًا. |

---

## 14. نتائج الاختبارات المحلية

تم تنفيذ:

```text
cd backend
npm test -- --runInBand
```

والنتيجة:

```text
Test Suites: 16 passed, 16 total
Tests:       60 passed, 60 total
```

وتشمل الاختبارات الجديدة:

- تصنيف 403 كـBANNED.
- منع Reconnect بعد 403.
- تصنيف 503 كحالة مؤقتة.
- منع Reconnect بعد logout وbadSession.
- فتح القاطع بعد حد 503.
- منع الأتمتة للحساب المحظور أو المحمي أو المتوقف أو المفتوح القاطع.
- إعادة استخدام Job المستقبلية عند التكرار.

تم أيضًا تنفيذ:

```text
node --check على ملفات Backend وMigration
نَجاح git diff --check
pnpm exec vite build
```

وبناء الواجهة Production نجح.

### ملاحظة TypeScript

فحص `tsc --noEmit` الكامل في المشروع يحتوي أخطاء قديمة وغير مرتبطة بهذا التعديل في ملفات Frontend أخرى، منها `ConnectionMethodModal.tsx` و`DirectPublishSection.tsx` و`AccountsView.tsx` و`GroupsView.tsx` و`KeywordMonitoringView.tsx` و`LinkImportView.tsx` و`SubscriberMonitoringView.tsx` و`TelegramKeywordView.tsx`. بناء Vite نجح، ولم يظهر `WhatsAppJoinAutomationView.tsx` ضمن هذه الأخطاء. لم يتم تعديل الملفات غير المرتبطة حتى لا يتوسع نطاق التغيير.

---

## 15. SQL للتحقق بعد النشر

### حالة الحساب والقاطع

```sql
SELECT
  a.id,
  a.status,
  a.health_status,
  a.task_status,
  g.circuit_state,
  g.reason_code,
  g.reason,
  g.consecutive_503,
  g.deferred_count,
  g.lock_collision_count,
  g.recovery_count,
  g.updated_at
FROM accounts a
LEFT JOIN link_import_account_guards g ON g.account_id = a.id
WHERE a.id = $1;
```

### العمليات والفاصل الحقيقي

```sql
SELECT
  o.id,
  o.task_id,
  o.account_id,
  o.link_id,
  o.status,
  o.current_stage,
  o.join_status,
  o.membership_state,
  o.error_code,
  o.last_error,
  o.attempt_count,
  o.recovery_count,
  o.reschedule_count,
  o.join_started_at,
  o.join_completed_at,
  o.next_run_at,
  o.cycle_id,
  o.queue_job_id,
  o.created_at,
  o.updated_at
FROM link_import_operations o
WHERE o.account_id = $1
ORDER BY COALESCE(o.join_started_at, o.created_at) DESC;
```

### أحداث العملية

```sql
SELECT
  e.id,
  e.operation_id,
  e.account_id,
  e.link_id,
  e.event_type,
  e.reason,
  e.next_run_at,
  e.job_id,
  e.worker_id,
  e.payload,
  e.created_at
FROM link_import_events e
WHERE e.account_id = $1
ORDER BY e.created_at DESC;
```

### الحد الأدنى بين بدايات الانضمام

```sql
WITH ordered AS (
  SELECT
    account_id,
    id,
    join_started_at,
    LAG(join_started_at) OVER (
      PARTITION BY account_id
      ORDER BY join_started_at
    ) AS previous_join_started_at
  FROM link_import_operations
  WHERE account_id = $1
    AND join_started_at IS NOT NULL
)
SELECT
  id,
  account_id,
  join_started_at,
  previous_join_started_at,
  EXTRACT(EPOCH FROM (join_started_at - previous_join_started_at)) AS interval_seconds
FROM ordered
WHERE previous_join_started_at IS NOT NULL
ORDER BY join_started_at;
```

### كشف تكرار Job للعملية

```sql
SELECT
  operation_id,
  COUNT(*) AS event_count,
  COUNT(DISTINCT job_id) AS distinct_job_ids,
  ARRAY_AGG(DISTINCT job_id) AS job_ids
FROM link_import_events
WHERE account_id = $1
  AND event_type IN ('queue_enqueued','job_received','job_started')
GROUP BY operation_id
HAVING COUNT(DISTINCT job_id) > 1;
```

لا تستخدم عدد `BullMQ completed` وحده لحساب عدد الانضمامات.

---

## 16. خطة Canary بعد النشر

1. انشر Commit المطلوب مع إبقاء `automation_enabled=false`.
2. تأكد من تشغيل Migration دون أخطاء.
3. تأكد من أن Redis وPostgreSQL متصلان.
4. سجل Deployment ID وGit SHA وعدد Workers وQueue names وConcurrency.
5. نفذ Recovery reconciliation فقط.
6. افحص وجود Jobs مكررة أو Outbox مكرر.
7. افحص حالة الحسابات المحمية والمحظورة؛ يجب ألا تُنشأ لها Jobs.
8. افحص Structured Logs و`/metrics`.
9. استخدم حسابًا مصرحًا وغير محظور، وليس الحساب المحظور السابق.
10. نفذ اختبارًا محدودًا جدًا وتابع `join_started` و`join_result_received` و`join_completed`.
11. إذا ظهر 403 أو تكرر 503 أو Queue churn، اضغط Emergency Stop ولا تعاود Retry تلقائيًا.
12. لا توسع التشغيل إلا بعد وجود دليل من قاعدة البيانات وLogs، وليس من عدد `worker_completed`.

---

## 17. المخاطر المتبقية

### 17.1 لا يوجد ضمان من WhatsApp

حتى الجدولة المحافظة لا تضمن عدم الحظر. WhatsApp قد يعتمد على إشارات لا يراها التطبيق. التعديلات تمنع أخطاء النظام والتكرار وسوء Recovery، لكنها لا تعني أن سلوك الانضمام أصبح معتمدًا من WhatsApp.

### 17.2 اختبار E2E الحقيقي غير منفذ

لم يتم تنفيذ اختبار كامل على Baileys وRedis وPostgreSQL وWhatsApp الحقيقي في هذه البيئة. يلزم حساب تجريبي مصرح، روابط يملك المستخدم صلاحية الانضمام إليها، ومراقبة يدوية.

### 17.3 Deployment ID غير موجود في المستودع

تم رفع الكود إلى GitHub، لكن نجاح Railway الفعلي يتطلب التأكد من أن Deployment يستخدم SHA الصحيح. لا يكفي ظهور `Active` أو `Healthy`.

### 17.4 بعض أخطاء TypeScript خارج النطاق

يوجد Technical Debt سابق في ملفات Frontend أخرى. Vite build ينجح، لكن `tsc --noEmit` الكامل يحتاج معالجة منفصلة إذا كان مطلوبًا جعل TypeScript نظيفًا بالكامل.

### 17.5 إلغاء Job النشطة ليس إلغاءً بأثر رجعي

Emergency Stop يمنع الأعمال المستقبلية ويوقف الجدولة التالية. لا يستطيع Queue إلغاء طلب Join بدأ بالفعل داخل WhatsApp. لذلك يجب الضغط على الإيقاف فور ظهور مؤشر خطر وعدم انتظار اكتمال العملية الحالية باعتبارها قابلة للعكس.

---

## 18. الملفات المعدلة

| الملف | سبب التعديل |
|---|---|
| `backend/src/bot/WhatsAppManager.js` | Hard Stop، Circuit Breaker، سياسة Reconnect، 403/503، الاتصال اليدوي الآمن. |
| `backend/src/bot/AccountProtectionPolicy.js` | سياسة قابلة للاختبار لتصنيف الانقطاعات ومنع Reconnect والحماية. |
| `backend/src/bot/AccountProtectionPolicy.test.js` | اختبارات 403 و503 وlogout وbadSession والحالات المحمية. |
| `backend/src/api/services/LinkImportService.js` | Coordinator موحد، Outbox guard، Queue churn limit، Recovery guard، Join metrics، Emergency Stop integration، event metadata. |
| `backend/src/lib/QueueManager.js` | One Future Job، duplicate handling، changeDelay، structured worker logs، إلغاء Jobs لحساب أو مستخدم. |
| `backend/src/lib/QueueManager.test.js` | اختبار إعادة استخدام Job المستقبلية ومنع تكرارها. |
| `backend/src/database/LinkImportMigrations.js` | عدادات الحماية، حقول التدقيق، الفهارس، وreschedule_count دون حذف البيانات. |
| `backend/src/api/controllers/TelegramController.js` | Emergency Stop، إيقاف حساب، حماية Retry اليدوي، حالات Dashboard وMetrics. |
| `backend/src/api/routes.js` | مسارات الإيقاف الطارئ وإيقاف حساب واحد. |
| `backend/src/api/middleware/MetricsMiddleware.js` | Counters وGauges للـJoin والحماية والـQueue. |
| `frontend/src/views/WhatsAppJoinAutomationView.tsx` | عرض الحماية والـJobs وأحداثها وأزرار الإيقاف الطارئ والحساب الواحد. |

---

## 19. Commit المطلوب نشره

بعد آخر مراجعة يجب أن يكون Commit النشر النهائي هو الـCommit الذي يحتوي هذه التعديلات. يجب تسجيل SHA الناتج من `git log -1 --oneline` بعد Commit، ثم مقارنته مع SHA في Railway.

لا تعتبر المهمة مكتملة تشغيليًا قبل تحقق الشروط التالية:

```text
Railway SHA = Git SHA المقصود
Migration نجحت
Redis متصل
PostgreSQL متصل
عدد Workers معروف
Concurrency معروف
automation_enabled=false أثناء Canary الأول
لا Jobs مكررة
لا Join بعد 403
لا Recovery لحساب محمي
لا Retry لحساب محظور
لا Queue churn
الانضمام الحقيقي مثبت بأحداث Join لا برسالة Worker فقط
```

---

## 20. النتيجة النهائية

من ناحية الكود المحلي والاختبارات، تم تطبيق طبقات الحماية الأساسية في `3352.md`، وتم إغلاق الثغرات التي ظهرت أثناء المراجعة الثانية، خصوصًا Retry اليدوي، وسباق Outbox بعد Emergency Stop، وتعارض Job النشطة مع Job المستقبلية، وغياب Metrics التفصيلية.

من ناحية الإنتاج، تبقى الخطوة الضرورية هي Canary مراقب بعد نشر SHA الصحيح، مع إبقاء الأتمتة متوقفة في البداية وعدم استخدام الحساب المحظور السابق. أي 403 جديد يجب أن يؤدي إلى `HARD STOP`، وأي 503 متكرر أو Queue churn يجب أن يؤدي إلى `PROTECTED` وإيقاف التشغيل، لا إلى زيادة Retry أو Reconnect.

**قاعدة التشغيل النهائية:**

> إذا تعارضت السرعة مع سلامة الحساب أو سلامة Queue، فالسلامة أولًا. إذا ظهر 403، فالإجراء الوحيد الآلي هو HARD STOP.
