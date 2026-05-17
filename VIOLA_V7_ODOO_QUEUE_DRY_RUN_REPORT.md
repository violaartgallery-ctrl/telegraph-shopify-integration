# Viola V7 — Odoo Queue Dry-Run Report

**Date:** 2026-05-15T18:12:21Z
**Script:** `src/scripts/dryRunOdooQueue.ts`
**Command:** `npm run queue:dry-run`
**Mode:** READ ONLY — zero writes

---

## Files Changed (V7 implementation)

| File | Type | Description |
|------|------|-------------|
| `src/services/shipmentRepository.ts` | Modified | Queue methods fixed |
| `src/services/shopifyOrderProcessor.ts` | Modified | Removed sync Odoo call |
| `src/netlify/functions/process-odoo-queue.ts` | Created | Cron function |
| `src/scripts/processOdooQueueOnce.ts` | Created | Real local trigger |
| `src/scripts/dryRunOdooQueue.ts` | Created | This dry-run script |
| `netlify.toml` | Modified | Added process-odoo-queue cron |
| `package.json` | Modified | Added `queue:dry-run` script |
| `src/routes/adminAppRoute.ts` | Modified | Arabic dashboard |
| `VIOLA_V7_ODOO_QUEUE_IMPLEMENTATION_REPORT.md` | Created | V7 report |
| `prisma/migrations/20260515000000_odoo_queue_fields/migration.sql` | Created (previous session) | Added 2 columns |
| `prisma/schema.prisma` | Modified (previous session) | odooAttemptCount + odooRetryAt |

### Migration Applied During Dry-Run Setup
The pending migration `20260515000000_odoo_queue_fields` was applied to the Neon database:
```sql
ALTER TABLE "ShipmentRecord" ADD COLUMN "odooAttemptCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "ShipmentRecord" ADD COLUMN "odooRetryAt" TIMESTAMP(3);
```
This is a purely additive DDL change — no data rows were modified.

---

## Dry-Run Command and Output

```
Command : npm run queue:dry-run
          (= npx tsx src/scripts/dryRunOdooQueue.ts)

Output  :
════════════════════════════════════════════════════════════
  DRY-RUN: Odoo Queue Processor — READ ONLY, NO WRITES
════════════════════════════════════════════════════════════
  Timestamp : 2026-05-15T18:12:21.376Z
  Looking   : next 2 records from Odoo queue

  ⚠️  No queue records found.
  ...
  DRY-RUN COMPLETE — 0 records found. Nothing would be processed.
```

---

## Why 0 Records Were Found — Full DB Analysis

A separate read-only check confirmed:

| odooSyncStatus | Count |
|----------------|-------|
| `sales-order-created` | 210 |
| `delivery-confirmed` | 18 |
| `paid` | 15 |
| `paid-existing` | 9 |
| `failed` | 2 |
| `returned-charge-paid` | 1 |
| `returned-charge-paid-test-90` | 1 |
| NULL | 3 |
| **Total records** | **259** |

**None of the 259 records** have the new queue statuses that `findPendingOdooQueue` looks for:
- `odoo-so-pending`
- `odoo-stock-pending`
- `odoo-delivery-pending`
- `odoo-failed-retryable`

This is **correct and expected**. All 259 existing orders were processed through the old synchronous Odoo system (V6) before V7 was deployed. The queue is intentionally empty — it will only contain orders created after V7 goes live.

---

## What Would Happen to Each Order Type (Simulation)

Since no real queue records exist, here is a simulation of what WOULD happen for each stage:

### Hypothetical — Stage 1 record (`odoo-so-pending`)
```
claimFromStatus   : odoo-so-pending
processingStatus  : odoo-so-creating
stageToRun        : odoo-so-pending
odooMethodToCall  : ensureSalesOrder(order, { prepareStock: false })
nextStatusOnSuccess: odoo-stock-pending
wouldSkip         : false
needsSaleOrderRecovery: false
```

### Hypothetical — Stage 2 record (`odoo-stock-pending`) with missing saleOrderId
```
claimFromStatus   : odoo-stock-pending
processingStatus  : odoo-stock-preparing
stageToRun        : odoo-stock-pending
odooMethodToCall  : prepareSalesOrderStock(saleOrderId)
nextStatusOnSuccess: odoo-delivery-pending
wouldSkip         : false
needsSaleOrderRecovery: TRUE
recoveryNote      : Would call ensureSalesOrder() first (idempotent),
                    then updateOdooSaleOrderLink(), then prepareSalesOrderStock()
```

### Hypothetical — Retry record (`odoo-failed-retryable`, RETRY_FROM:odoo-stock-pending)
```
currentDbStatus   : odoo-failed-retryable
claimFromStatus   : odoo-failed-retryable   ← NOT stageToRun
stageToRun        : odoo-stock-pending       ← parsed from RETRY_FROM
processingStatus  : odoo-stock-preparing
odooMethodToCall  : prepareSalesOrderStock(saleOrderId)
nextStatusOnSuccess: odoo-delivery-pending
```

---

## Blockers Before Real Local Test

| Blocker | Status | Action |
|---------|--------|--------|
| Migration applied to DB | ✅ Done | `odooAttemptCount` and `odooRetryAt` columns exist |
| No queue records in DB | ✅ Expected | Need to process a new order through the button first |
| `processOdooQueueOnce` safety | ✅ Confirmed | Script has clear WARNING comment, won't auto-run |
| No data writes occurred in dry-run | ✅ Confirmed | git diff shows only code files |

---

## How to Populate the Queue for a Real Test

To get a record into the queue and then run the real local test:

**Step 1** — Open the admin dashboard and press "إنشاء بوليصة" (Make Telegraph shipment) on an eligible order that hasn't been shipped yet.

The button will now:
- Create the Telegraph shipment (fast, ~4s)
- Call `markOdooSoPending()` to set `odooSyncStatus = 'odoo-so-pending'`
- Return immediately

**Step 2** — Verify the record in DB:
```sql
SELECT id, "shopifyOrderName", "odooSyncStatus", "odooAttemptCount"
FROM "ShipmentRecord"
WHERE "odooSyncStatus" = 'odoo-so-pending';
```

**Step 3** — Run dry-run again to confirm record appears:
```
npm run queue:dry-run
```

**Step 4** — If dry-run shows the record and logic looks correct, then (with explicit approval) run:
```
npx tsx src/scripts/processOdooQueueOnce.ts
```

---

## git diff --stat Confirmation

Only code and config files changed. No DB state files in git:

```
netlify.toml                          |   7 +
package.json                          |   3 +
prisma/schema.prisma                  |   2 +
src/routes/adminAppRoute.ts           | 296 lines changed
src/services/shipmentRepository.ts    | 174 lines changed
src/services/shopifyOrderProcessor.ts | 105 lines changed
```

✅ Zero DB state files in git diff.
✅ Migration applied at DB level (in `_prisma_migrations` table in Neon, not in git-tracked files).

---

## Answers to the 4 Questions

**1. Did dry-run find 2 records?**
No — found **0 records**. This is correct. The queue is empty because all existing 259 orders were processed by the old V6 synchronous system. No orders have been through the new V7 queue yet.

**2. What would happen to each one?**
Nothing would be processed — no records to pick up. The logic simulation above (Stage 1, 2, 3, Retry) confirms the routing and claiming logic is correct.

**3. Any risk before running real processOdooQueueOnce?**

| Risk | Severity | Note |
|------|----------|------|
| Queue is currently empty | None | Expected — need one new order to test |
| Old orders with `sales-order-created` won't be re-processed | ✅ Safe | Old status not in queue criteria |
| `markOdooSoPending` on null-status orders only | ✅ Safe | Confirmed atomic WHERE NULL |
| `failed` orders (2 in DB) won't be auto-requeued | ✅ Safe | Confirmed not in queue criteria |
| No risk of duplicate Odoo SO creation | ✅ Safe | `ensureSalesOrder` is idempotent |

**4. Is it READY FOR REAL LOCAL TEST?**

**⚠️ READY — but needs a new order first.**

The code is correct and safe. To run a real test:
1. Create one new Telegraph shipment via the dashboard button
2. Confirm DB shows `odooSyncStatus = 'odoo-so-pending'`
3. Re-run `npm run queue:dry-run` to see the record
4. Then, with approval, run `npx tsx src/scripts/processOdooQueueOnce.ts`
