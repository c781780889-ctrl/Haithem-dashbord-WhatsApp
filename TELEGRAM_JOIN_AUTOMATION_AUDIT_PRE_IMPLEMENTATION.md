# Telegram Join Automation v2 — Pre-Implementation Audit

**Audit date:** 2026-08-25  
**Baseline commit:** `2bac0ca` (implementation commit `f972d1d`)  
**Scope:** Frontend, API, database migrations, QueueManager, Telegram runtime, security boundaries, recovery, concurrency, retries, events, and tests.

## Executive status

The current feature is functionally real but not yet production-ready for multi-worker failure recovery and large-scale operation. The core discovery and join path exists, but several requirements from the hardening brief are absent or only partially implemented. The highest-risk items are role transitions while a worker is alive, `ALREADY_MEMBER` result mapping, lack of explicit transaction/outbox, lack of lease/heartbeat recovery, and the absence of an independent search queue.

## Audit matrix

| Domain | Status | Evidence | Finding |
|---|---|---|---|
| Frontend | PASS with gaps | `JoinAutomationView.tsx` | Real API wiring, loading/error/empty states; no server-side links pagination, health panel, import/export, or full operation detail. |
| API | PASS with gaps | `routes.js`, `TelegramJoinAutomationController.js` | Authenticated v2 endpoints and ownership checks exist; error envelope is not fully standardized as `{code,message}`. |
| Database | PASS with gaps | `TelegramMigrations.js` | v2 tables, unique constraints, and indexes exist; no outbox, audit table, health table, leases, worker IDs, or FK on `job_id`. |
| Queue | PASS with gaps | `QueueManager.js` | Independent join queue exists with concurrency 1; enqueue is not transactionally coupled to DB writes. |
| Worker | PASS with gaps | `index.js`, `TelegramJoinAutomationService.js` | Real join handler exists; no persisted lease, heartbeat, worker identity, or watchdog. |
| Telegram Runtime | PASS with gaps | `TelegramService.js` | GramJS public/private join and SEARCH_ROLE listener exist; role changes do not safely restart runtime. |
| Security | PASS with gaps | controllers/services/middleware | JWT/CSRF and ownership patterns exist; centralized redaction and dedicated audit trail are absent. |
| Ownership Isolation | PASS | v2 scoped queries | Account, link, job and operation queries include user scope except explicitly authorized admin paths. |
| Role Isolation | PASS at request time / FAIL on live transition | service + runtime | API and worker guards exist, but in-memory listener state can lag after a role change. |
| Idempotency | PASS with gaps | unique operation key/constraint | Duplicate account×link operations are blocked; job creation is not an atomic transaction and can create an empty completed Job before returning an error. |
| Recovery | FAIL | service/migrations | No lease/heartbeat/watchdog for stale `PROCESSING` operations. |
| Concurrency | PARTIAL | atomic status claim + Queue concurrency 1 | No advisory/distributed lock; multi-replica race protection is incomplete. |
| Retry | PASS with gaps | `classifyError`, delayed re-enqueue | Temporary retry exists; Telegram `FLOOD_WAIT` duration is not parsed as an exact server-mandated delay. |
| Live Events | PASS with gaps | `SocketBridge`, event table | Events persist and broadcast; no reconnect replay contract beyond refetch. |
| Error Mapping | FAIL for one critical case | `classifyError`, `processOperation` | `ALREADY_MEMBER` is classified but final operation status becomes `FAILED` instead of idempotent `SUCCESS`. |
| UI State | PASS with gaps | `JoinAutomationView.tsx` | UI does not fake join success; Worker/DB system health is not displayed as required. |
| E2E | UNVERIFIED | local tests | No live Telegram test account, Redis integration test, PostgreSQL integration test, or full browser E2E was executed. |

## Critical findings ordered by severity

| Severity | Finding | Root cause | Required direction |
|---|---|---|---|
| Critical | Live role transition can leave DB and runtime inconsistent. | `setAccountRole` updates DB only. | Stop worker/listeners, update role, reload, restart correct worker, persist health, emit transition event. |
| Critical | `USER_ALREADY_PARTICIPANT` becomes failed. | Final status branch does not map `ALREADY_MEMBER` to `SUCCESS`. | Persist `SUCCESS`, `result_code=ALREADY_MEMBER`, membership state, link aggregate, account/job counters. |
| Critical | Stale `PROCESSING` operation can remain forever. | No lease, heartbeat, worker ID, or watchdog. | Add lease fields and recovery worker with safe final-result check. |
| High | DB and Redis writes are not one durable workflow. | Job/operations are written through independent queries before enqueue. | Add transaction plus outbox table/dispatcher. |
| High | Two workers can race after a process or replica failure. | Atomic claim exists but no lock around actual Telegram call. | Add PostgreSQL advisory lock or Redis distributed lock keyed by user/link/account. |
| High | Search endpoint performs historical scan in HTTP request. | Controller directly calls `scanHistory`. | Add discovery jobs table and independent `telegram-link-discovery` queue. |
| High | Distribution modes are mostly presentation. | Job creation uses round-robin ordering and does not calculate health/load. | Implement measurable least-loaded and smart selection, or remove unsupported labels. |
| Medium | Pagination and server-side filtering are missing. | Dashboard loads max 250 rows and filters in React. | Add `/links` query with indexed filters and page/cursor response. |
| Medium | Audit and persistent notifications are missing. | Operational event log used as only history. | Add dedicated audit and notifications tables if required by product. |
| Medium | API errors are not a stable structured contract. | Controllers return string `error` values. | Introduce central error codes and `{success,data}` / `{success:false,error:{code,message}}`. |
| Medium | Membership verification is not explicit. | A successful GramJS call is treated as enough. | Add safe verification where Telegram result is ambiguous; never display unsupported success. |

## Non-regression constraints

1. Do not remove legacy WhatsApp routes or tables used by existing sections.
2. Do not make React execute Telegram operations.
3. Do not move sessions or credentials to browser storage, Socket payloads, or event payloads.
4. Keep Telegram Keyword Center and Telegram Accounts compatible with shared `telegram_accounts` and `TelegramService`.
5. Run affected tests, full backend tests, frontend build, migration checks, and route/syntax checks after each hardening batch.

## Audit conclusion

Implementation should proceed in this order: critical state/result correctness, runtime role transition, persisted leases and recovery, locking, transaction/outbox, independent discovery queue, health/observability, server-side links API, UI completion, and finally live integration verification. The codebase already contains recovery and claim patterns in WhatsApp Link Import and Keyword Monitoring that can be adapted without copying the legacy domain model into Telegram v2.
