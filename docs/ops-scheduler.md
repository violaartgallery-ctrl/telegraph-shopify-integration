# Durable operations scheduler

Production uses the existing Vercel Queues service, not GitHub schedule delivery,
as the primary wake-up mechanism. Three isolated lanes keep runs under the
300-second function limit:

| Lane | Interval | Work |
| --- | --- | --- |
| status | 10 minutes | Meta delivered outbox and up to 100 open shipments |
| discovery | 15 minutes | Location cache, current + cursor collection/return reports |
| financial | 5 minutes | Checkpointed Odoo production, returns, Shopify exact-total payments, Odoo collections |

Each consumer durably publishes its next slot **before** performing work. Slot
idempotency keys prevent duplicate recurring chains. A PostgreSQL advisory lock
and expiring per-lane lease prevent overlapping slot execution. Completed slots
are not executed again. API failures do not remove the next scheduled wake.

`GET /ops/scheduler/ensure` reseeds the three chains. It requires the existing
OPS_SECRET header or the existing Vercel CRON_SECRET bearer token. No credentials
belong in URLs. GitHub's half-hour schedule is a watchdog: when all three lane
heartbeats are recent, the legacy mutation jobs are skipped. If bootstrap fails
or a heartbeat is stale, the old idempotent pipeline remains the fallback.
A single daily Vercel cron reseeds chains even if GitHub schedule delivery stalls
for a full day; this works on the existing Hobby plan.

`GET /ops/scheduler/health` requires OPS_SECRET or CRON_SECRET and reports actual successful
execution timestamps, not just message publication. Heartbeats and leases are
stored as `FailedPayload.source=ops_scheduler` (operational state, not errors).
Set OPS_SCHEDULER_ENABLED=false to stop recurrence; existing GitHub fallback
continues. Preview and local environments never start recurring work.

Customer discount/overpayment reviews and delivered-after-paid-return-charge
conflicts retain their existing safety guards. No worker auto-approves them.
The explicitly allowlisted `recoverDeliveredAfterReturn.ts` support command
requires fresh exact courier proof and an explicit --apply. It restores stock
via standard return-of-return pickings, reopens the existing SO without MTO
procurement, preserves the paid return expense, and verifies the paid net invoice.
It never un-cancels Shopify or creates another waybill.
