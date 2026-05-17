# VIOLA — V7 Odoo Queue Orphan Audit & Recovery

**Generated:** 2026-05-17
**Branch:** codex/latest-updates

## Root cause

The V7 Odoo background queue was leaving records stuck at status `sales-order-created` when the Lambda function processing Stage 1 was killed (or the upstream call timed out) **after** `ensureSalesOrder` ran but **before** `markOdooStageSuccess` advanced the status to `odoo-stock-pending`.

`ensureSalesOrder` writes the legacy status `sales-order-created` to the DB as a side effect (via `updateOdooSalesOrder`). The wrapping V7 queue processor was expected to immediately overwrite that status. Any interruption between the two writes — including AWS Lambda's 26-second timeout (`Sandbox.Timedout`) — orphaned the record:

```
findPendingOdooQueue filter:
  ['odoo-so-pending', 'odoo-stock-pending', 'odoo-delivery-pending', 'odoo-failed-retryable']

`sales-order-created` is NOT in the filter → orphan never picked up again.
recoverStuckProcessingRecords only handles `*-creating/-preparing/-confirming` → does not help.
```

## Phase 1 — Audit results

| Classification | Count |
|---|---:|
| ❌ **V7 orphans (need recovery)** | **46** |
| ✅ V6 legitimate (already have invoice/payment) | 13 |
| ⚠️ Other (no shipment / unclear) | 70 |
| **Total `sales-order-created` rows** | 129 |

**Orphans by age:**

| Age | Count |
|---|---:|
| < 1 hour (the known 10 reported by user) | 10 |
| 3–7 days | 30 |
| > 7 days | 6 |

The bug has been silently orphaning orders since at least May 10.

## Known 10 orders — pre-recovery state

| Order | Telegraph | SO | Accurate Status | Collection | DB Status |
|---|---|---|---|---|---|
| #2036 | VI0000491 | S14672 | PENDING | null | sales-order-created |
| #2038 | VI0000489 | S14670 | PENDING | null | sales-order-created |
| #2040 | VI0000490 | S14671 | PENDING | null | sales-order-created |
| #2042 | VI0000492 | S14673 | PENDING | null | sales-order-created |
| #2043 | VI0000484 | S14665 | PENDING | null | sales-order-created |
| #2044 | VI0000485 | S14666 | PENDING | null | sales-order-created |
| #2047 | VI0000486 | S14667 | PENDING | null | sales-order-created |
| #2048 | VI0000487 | S14668 | PENDING | null | sales-order-created |
| #2049 | VI0000488 | S14669 | PENDING | null | sales-order-created |
| #2051 | VI0000483 | S14664 | PENDING | null | sales-order-created |

All confirmed in Odoo: `state=sale`, MO in `confirmed` state, internal pickings in `waiting/assigned`, customer pickings in `waiting`, no invoice.

## Phase 2 — Recovery (DB-only, the known 10)

**Pre-flight conditions (must all hold per row):**

- `odooSyncStatus = 'sales-order-created'`
- `accurateShipmentId IS NOT NULL`
- `odooSaleOrderId IS NOT NULL`
- `odooInvoiceId IS NULL`
- `odooPaymentId IS NULL` AND `odooSalePaymentId IS NULL`
- `collectionStatus NOT IN (collected, returned, returned-settled, delivered-not-collected)`

**DB transition:**

```
sales-order-created → odoo-stock-pending
+ odooLastError = null
+ odooRetryAt = null
+ odooAttemptCount = 0
+ odooSyncedAt = now()
```

No writes to Odoo, Shopify, or Telegraph. The V7 queue picks the recovered records up on the next `process-odoo-queue` tick (every minute) and runs Stage 2 → Stage 3 normally.

**Result:** 10/10 recovered.

## Phase 3 — Permanent fix

Add an opt-in flag to `ensureSalesOrder` so the V7 queue can suppress the legacy `sales-order-created` side effect. The V7 queue then owns its own state transitions via `markOdooStageSuccess`.

```typescript
// odooSyncService.ts
async ensureSalesOrder(
  order, record,
  options: { prepareStock?: boolean; skipDbStatusUpdate?: boolean } = {}
)

// process-odoo-queue.ts (Stage 1)
await odooSyncService.ensureSalesOrder(order, {...}, {
  prepareStock: false,
  skipDbStatusUpdate: true       // V7 manages status itself
});
```

Legacy V6 callers (e.g. `/api/orders/create-odoo-sales-order` endpoints) continue with the default behaviour — backwards compatible.

## Remaining items (NOT touched in this run)

- **36 additional orphans** (created 3+ days ago) — same recovery pattern would apply, but requires separate authorization. List included in the script `_auditV7Orphans.ts`.
- **1 record `#1880` payment-review** — excluded from automatic classification; manual review.
- **2 records `#1920` `#1942`** (Telegraph VI0000372/378) — legacy unauthorized account; might be terminal.
