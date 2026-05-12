# UPDATE_FLOW_DEEP_AUDIT.md
## Deep Audit — Viola Telegraph Integration (Production)

> Branch: `codex/viola-v5-sync-fixes` · Commit: `48b9f91`  
> Audited: 2026-05-12  
> Status: **NOT READY FOR DEPLOY** — 3 confirmed bugs, 2 timeout risks

---

## 1. Shopify Admin Extension — Confirmed Buttons

**File:** `extensions/make-telegraph-shipment/shopify.extension.toml`

| Button label | Type | Target | URL |
|---|---|---|---|
| Make Telegraph shipment (name from locale) | `admin_link` (single order) | `admin.order-details.action.link` | `/orders/make-telegraph` |
| Make Odoo Sales Order | `admin_link` (single order) | `admin.order-details.action.link` | `/orders/create-odoo-sales-order` |
| Make Telegraph shipments | `admin_link` (bulk, order index) | `admin.order-index.selection-action.link` | `/orders/make-telegraph/bulk` |
| Make Odoo Sales Orders | `admin_link` (bulk, order index) | `admin.order-index.selection-action.link` | `/orders/create-odoo-sales-order/bulk` |

All four are confirmed wired to live routes in `src/routes/adminAppRoute.ts`.

---

## 2. Real Flow — Make Telegraph Shipment (Single)

**Route:** `GET /orders/make-telegraph`  
**Handler:** `src/routes/adminAppRoute.ts` line 869  
**Core service:** `src/services/shopifyOrderProcessor.ts` → `ShopifyOrderProcessor.process()`

### Step-by-step

```
1. Fetch order from Shopify (by GID or legacy ID)
2. Check for existing ShipmentRecord (findSummaryByShopifyOrderId)
   ├── If exists AND Telegraph shipment present:
   │   a. Verify shipment still exists on Telegraph (getShipment)
   │   b. If deleted → clearDeletedShipment, fall through to create new
   │   c. If exists → fulfillShopifyOrder() [tracking/fulfillment]
   │               → syncOdooSalesOrder()   [Odoo SO + delivery]
   │               → return (skipped: duplicate)
   └── If no existing shipment → continue
3. Check eligibility (skipped for admin actions)
4. shipmentRepository.createPending(order)
5. shipmentCodeService.reserveForOrder(orderId) → get VI-xxx code
6. accurateMapper.mapOrderToShipment(order, { requireTelegraphLocation: true })
7. accurateClient.saveShipment(input) with retry on duplicate code (up to 5 attempts)
8. shipmentRepository.markCreated(orderId, { id, code, status })
9. shopifyFulfillmentClient.fulfillOrder({ trackingNumber, trackingUrl })
   → Shopify order marked as FULFILLED with Telegraph dashboard URL as tracking
10. odooSyncService.ensureSalesOrder(order, { shipmentCode, trackingUrl }, { prepareStock: true })
    a. Check shipmentRecord for odooSaleOrderId (idempotency)
    b. findExistingSaleOrder by client_order_ref or origin
    c. claimOdooSalesOrderCreation (atomic DB lock against parallel creation)
    d. findOrCreatePartner (by phone/email)
    e. buildSaleOrderLines → find Odoo product per Shopify SKU
    f. odooClient.create('sale.order', { partner_id, client_order_ref, order_line })
    g. odooClient.call('sale.order', 'action_confirm')
    h. prepareSalesOrderStock(saleOrderId):
       - completeManufacturingForSaleOrder → confirm + mark done all MOs (recursive tree)
       - validatePickingsForSaleOrder('internal') → validate WH/IN→STOCK pickings
11. odooSyncService.confirmSalesOrderDelivery(saleOrderId)
    - validatePickingsForSaleOrder('customer') → validate STOCK→Customers picking
12. Return result to UI
```

### What this button does NOT do
- Does NOT mark Shopify as PAID
- Does NOT create an Odoo invoice
- Does NOT register Odoo payment

---

## 3. Real Flow — Make Odoo Sales Order (Single)

**Route:** `GET /orders/create-odoo-sales-order`  
**Handler:** `src/routes/adminAppRoute.ts` line 1146

```
1. Fetch order from Shopify
2. findSummaryByShopifyOrderId → check for existing record
3. odooSyncService.ensureSalesOrder(order, record, { prepareStock: false })
   ← NOTE: prepareStock=false → does NOT do MOs or stock pickings
4. Returns SO id and name to UI
```

**Difference from Make Telegraph Shipment:**  
This button creates the SO but skips MO and picking validation. It is intended for use after a Telegraph shipment was already created by another means and stock is already prepared. It also does NOT call `confirmSalesOrderDelivery`.

---

## 4. Real Flow — Make Telegraph Shipments (Bulk)

**Routes:** `GET /orders/make-telegraph/bulk` (preview) + `POST /orders/make-telegraph/bulk` (execute)

- `GET`: fetches each order, checks for existing shipment and Telegraph location. Shows a review table.
- `POST`: for each "ready" order, calls `shopifyOrderProcessor.process(order, { source: 'shopify-admin-bulk-link', skipEligibility: true, requireTelegraphLocation: true })`

**Key difference from single:** Does NOT call `syncOdooSalesOrder` separately. Odoo sync happens inside `process()` the same way as single.

**Timeout risk:** ⚠️ Each order in the bulk loop does: Shopify fetch + Accurate API + Shopify fulfillment + Odoo SO + Odoo MO + Odoo pickings → can be 10–30 seconds per order. With 5+ orders and a 26-second Netlify limit, bulk will time out.

---

## 5. Real Flow — Make Odoo Sales Orders (Bulk)

**Routes:** `GET /orders/create-odoo-sales-order/bulk` (preview) + `POST /orders/create-odoo-sales-order/bulk` (execute)

- `GET`: calls `odooSyncService.previewOrder(order)` per order to check SKU mapping readiness.
- `POST`: for each ready order, calls `odooSyncService.ensureSalesOrder(order, record, { prepareStock: false })`.

**Timeout risk:** ⚠️ Each order: Shopify fetch + Odoo partner lookup + Odoo product SKU lookup + Odoo SO create + confirm → several Odoo RPC calls. 10+ orders will likely timeout.

---

## 6. Real Flow — Shopify Webhook `orders/create`

**Route:** `POST /webhooks/orders/create` → `createShopifyWebhookHandler(processor)`  
**Handler:** `src/routes/shopifyWebhookRoute.ts`

```
1. Verify HMAC signature (timingSafeEqual)
2. Parse body as ShopifyOrder
3. processor.process(payload, headers)
   → Same flow as Make Telegraph Shipment but without requireTelegraphLocation
   → If order is not eligible (not COD, already shipped, etc.) → skipped
   → If no Telegraph location in order attributes → skipped (NOT auto-picked)
```

---

## 7. Real Flow — Status Sync (Scheduled every 10 minutes)

**Function:** `src/netlify/functions/sync-open-shipments.ts`  
**Service:** `src/services/shipmentStatusSyncService.ts` → `syncOpenShipments()`

```
1. shipmentRepository.findOpenShipments(batchSize)
   WHERE accurateIsTerminal IS NULL OR accurateIsTerminal = false
   ORDER BY updatedAt ASC
   LIMIT batchSize (default: env.syncOpenShipmentsBatchSize)
2. For each record → syncRecord(record):
   a. accurateClient.getShipment({ id, code })
   b. projectAccurateStatusToShopify({statusCode, returnStatusCode, collected, paidToCustomer, cancelled, customerDue})
   c. shipmentRepository.updateAccurateSnapshot() → store all fields including deliveryFees, returningDueFees, customerDue
   d. shopifyStatusSyncClient.syncShipmentState() → update Shopify metafields + tags
   e. If collectionStatus === 'payment-review' → save to failedPayload, STOP (no Odoo)
   f. If collectionStatus === 'collected' → odooSyncService.syncCollectedShipment(record.id)
   g. If collectionStatus === 'returned' or 'returned-settled' → odooSyncService.syncReturnedShipmentCharge(record.id)
```

### Status → collectionStatus mapping

| Accurate status | customerDue | collected | paidToCustomer | collectionStatus |
|---|---|---|---|---|
| DTR (Delivered) | < 0 | any | any | `payment-review` ⚠️ |
| DTR | ≥ 0 | true | any | `collected` → triggers Odoo payment |
| DTR | ≥ 0 | false | any | `delivered-not-collected` |
| RTRN/RTS/RJCT | any | any | true | `returned-settled` → triggers return bill |
| RTRN/RTS/RJCT | any | any | false | `returned` → triggers return bill |
| cancelled | any | any | any | `cancelled` |

---

## 8. Real Flow — Odoo Payment Sync (On Collection)

**Function:** `OdooSyncService.syncCollectedShipment(recordId)`  
**File:** `src/odoo/odooSyncService.ts` line 356

```
1. Load shipmentRecord (includes rawOrderJson, collectedAmount, odooSalePaymentId)
2. If odooSalePaymentId already set → return (idempotent)
3. Parse rawOrderJson → ShopifyOrder
4. ensureSalesOrder(order, record) → create or find existing Odoo SO
   (prepareStock=true → completes MOs + internal pickings if not done)
5. findOrCreatePostedSaleInvoice(orderId, saleOrderId)
   → look for existing invoices by invoice_ids or invoice_origin
   → if none: create via sale.advance.payment.inv wizard
   → if draft: post it (action_post)
6. Check residual and payment_state
7. collectedAmount = record.collectedAmount ?? order.current_total_price  ← THE BUG
8. amount = Math.min(residual, collectedAmount)
9. registerPayment(invoice.id, amount, journalId, reference)
10. updateOdooPayment(orderId, { paymentId, status: 'paid' })
```

---

## 9. Real Flow — Odoo Return Charge Sync (On Return)

**Function:** `OdooSyncService.syncReturnedShipmentCharge(recordId)`  
**File:** `src/odoo/odooSyncService.ts` line 411

```
1. Load record
2. calculateTelegraphReturnCharge(record):
   - If customerDue > 0 → return 0 (merchant owes nothing)
   - If customerDue < 0 → return abs(customerDue)  ← primary source
   - Else if returningDueFees > 0 → return returningDueFees
   - Else if returnFees > 0 → return returnFees
   - Else if returnedValue < 0 → return abs(returnedValue)
   - Else → 0
3. If returnCharge ≤ 0 → no bill needed
4. Find or create vendor bill (account.move, move_type='in_invoice') for "Telegraph Shipping" partner
5. Post the bill
6. Register payment for returnCharge against the bill
7. updateOdooReturnCharge(orderId, { billId, paymentId, status: 'returned-charge-paid' })
```

---

## 10. Confirmed Telegraph/Accurate API Fields

From `src/accurate/queries.ts` `GET_SHIPMENT_QUERY` and `src/accurate/accurateClient.ts`:

| Field | Type | Stored in DB | Purpose |
|---|---|---|---|
| `collectedAmount` | number | ✅ `ShipmentRecord.collectedAmount` | Total cash collected from customer by Telegraph |
| `deliveryFees` | number | ✅ `ShipmentRecord.deliveryFees` | Telegraph's delivery fee (what they deduct) |
| `returnFees` | number | ✅ `ShipmentRecord.returnFees` | Return shipping fee |
| `returningDueFees` | number | ✅ `ShipmentRecord.returningDueFees` | Fees due when returning |
| `customerDue` | number | ✅ `ShipmentRecord.customerDue` | Net amount owed to/from customer |
| `returnedValue` | number | ✅ `ShipmentRecord.returnedValue` | Value of returned goods |
| `pendingCollectionAmount` | number | ✅ `ShipmentRecord.pendingCollectionAmount` | Not yet collected |

**The field name for shipping/delivery fee is: `deliveryFees`** — not `shippingFee`, not `fee`.

**Net merchant due formula:**
```
netMerchantDue = collectedAmount - deliveryFees
```

For order #1787: `1270 - 71 = 1199 EGP`

---

## 11. Scenario Matrix

| Scenario | Telegraph creates | Shopify fulfills | Shopify marks paid | Odoo SO | Odoo MO | Odoo delivery | Odoo invoice | Odoo payment |
|---|---|---|---|---|---|---|---|---|
| Make Telegraph shipment (admin) | ✅ | ✅ | ❌ | ✅ (prepareStock=true) | ✅ | ✅ | ❌ | ❌ |
| Make Odoo Sales Order (admin) | ❌ | ❌ | ❌ | ✅ (prepareStock=false) | ❌ | ❌ | ❌ | ❌ |
| Webhook orders/create | ✅ | ✅ | ❌ | ✅ (prepareStock=true) | ✅ | ✅ | ❌ | ❌ |
| Status sync → collected | ❌ | ❌ | ❌ | ✅ (if missing) | ✅ (if missing) | ❌ | ✅ | ✅ (**BUG: wrong amount**) |
| Status sync → returned | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | Vendor bill | Vendor payment |
| Status sync → payment-review | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |

**GAP: Shopify is never marked as PAID by any path in the current code.**

---

## 12. Exact Bugs Found

### BUG-1 (CRITICAL): Wrong payment amount in Odoo — uses collectedAmount instead of netMerchantDue

**File:** `src/odoo/odooSyncService.ts` lines 387–388

```ts
// CURRENT (WRONG):
const collectedAmount = Number(record.collectedAmount ?? Number.parseFloat(order.current_total_price ?? order.total_price));
const amount = Math.min(residual, Number.isFinite(collectedAmount) && collectedAmount > 0 ? collectedAmount : residual);

// CORRECT:
const collectedAmount = Number(record.collectedAmount ?? 0);
const deliveryFees = Number(record.deliveryFees ?? 0);
const netMerchantDue = collectedAmount > 0 && deliveryFees >= 0
  ? collectedAmount - deliveryFees
  : collectedAmount;
const amount = Math.min(residual, Number.isFinite(netMerchantDue) && netMerchantDue > 0 ? netMerchantDue : residual);
```

**Impact on order #1787:**

| | Shopify | Telegraph | Odoo (current buggy) | Odoo (correct) |
|---|---|---|---|---|
| Product price | — | — | 1200 EGP (from SO line) | 1200 EGP |
| Invoice total | — | — | 1200 EGP | 1200 EGP |
| Collected from customer | — | 1270 EGP | stored | stored |
| deliveryFees | — | 71 EGP | stored | stored |
| **Payment registered** | — | — | **min(1200, 1270) = 1200** | **min(1200, 1199) = 1199** |
| Invoice residual after payment | — | — | 0 EGP (fully "paid") | 1 EGP (correctly under-paid) |
| Books accuracy | — | — | ❌ Over-states by 1 EGP | ✅ Reflects actual receipt |

---

### BUG-2 (HIGH): Shopify order never marked as PAID

No code path calls `orderMarkAsPaid` on Shopify after Telegraph confirms collection. Only Shopify metafields and tags are updated. The Shopify financial status stays as `pending` or whatever it was at order creation — even after the merchant has received money.

**Fix:** In `syncCollectedShipment()`, after registering the Odoo payment, call `orderMarkAsPaid` via Shopify Admin GraphQL for the Shopify order. This requires the `write_payment_terms` scope.

---

### BUG-3 (MEDIUM): Return charge bill creates a "Telegraph Shipping" expense — user says do NOT do this

**File:** `src/odoo/odooSyncService.ts` line 746 — `createReturnShippingBill()`

When a shipment is returned, `syncReturnedShipmentCharge()` creates a vendor bill (`in_invoice`) against a "Telegraph Shipping" partner and registers a payment. The user specification says: **"Do NOT create shipping company fee expenses."**

The return charge bill creation should be disabled or replaced with a simpler journal entry. Awaiting business decision on what accounting entry (if any) should replace it.

---

### BUG-4 (LOW): `account_id: 101` is hardcoded in return bill creation

**File:** `src/odoo/odooSyncService.ts` line 759

```ts
invoice_line_ids: [[0, 0, {
  name: reference,
  quantity: 1,
  price_unit: amount,
  account_id: 101   // ← hardcoded Odoo account ID
}]]
```

Account ID `101` may not exist or may be wrong in production. This should be configurable via env var (`ODOO_RETURN_EXPENSE_ACCOUNT_ID`).

---

## 13. Timeout Risks

### T-1 (HIGH): `syncOpenShipments` has no time-budget guard

**File:** `src/services/shipmentStatusSyncService.ts` lines 177–200

The production code loops through all open shipments with no wall-clock check. If `batchSize=20` and each `syncRecord` call takes 2s (Accurate + Shopify + Odoo), total = 40s → exceeds Netlify's 26-second limit. The function is killed mid-loop, leaving the DB in a partially-updated state.

**Fix:** Add a time-budget check before each iteration:
```ts
const startedAt = Date.now();
for (const record of openShipments) {
  if (Date.now() - startedAt > env.workerMaxRuntimeMs) break;
  await this.syncRecord(record);
}
```

### T-2 (HIGH): Bulk Telegraph/Odoo loops have no timeout protection

**File:** `src/routes/adminAppRoute.ts` — bulk POST routes

Each order in the bulk loop does multiple synchronous Odoo RPC calls, Shopify API calls, and Accurate API calls. For 5+ orders, this will exceed the 26-second Netlify limit.

**Fix (minimal):** Add a per-order time check and stop processing after `maxRuntimeMs`. Return partial results to the user with a "timed out" notice.

---

## 14. Duplicate / Race Condition Risks

### R-1 (MITIGATED): Parallel Odoo SO creation

`claimOdooSalesOrderCreation()` uses `updateMany` with a WHERE filter for `odooSaleOrderId IS NULL AND status != 'sales-order-creating'`. This is atomic in PostgreSQL and effectively prevents parallel creation of the same SO. ✅ Well handled.

### R-2 (RISK): Webhook replay creates duplicate shipments

If Shopify retries a webhook (network failure, 5xx response) and the first invocation succeeded, the second call will hit `findByShopifyOrderId` → find existing record → fulfill again (skipped) → sync Odoo again (idempotent check saves it). The duplicate shipment itself is prevented by the `findSummaryByShopifyOrderId` check. However, if the first invocation dies *after* creating the shipment but *before* writing to DB, a duplicate Accurate shipment could be created.

**Mitigation already in code:** `saveShipmentWithFreshCodeRetry` retries on duplicate code errors. But no webhook idempotency table exists in production. A `ProcessedWebhook` table (as added in the worktree branch) would make this fully safe.

### R-3 (RISK): `waitForParallelSaleOrderCreation` busy-loops with `sleep(1000)`

**File:** `src/odoo/odooSyncService.ts` lines 317–341

If two requests create an SO concurrently and one claims the lock, the other does a `while (attempt < 12) { sleep(1000); ... }` loop — 12 seconds of sleeping. In a serverless function, this keeps the function alive for 12 extra seconds without doing useful work. With multiple concurrent requests, this compounds.

---

## 15. Payment / Accounting — Order #1787 Full Analysis

**Order data:**
- Shopify order total = 1270 EGP (what customer was charged)
- Shopify product price = 1200 EGP (line item price)
- Telegraph `collectedAmount` = 1270 EGP
- Telegraph `deliveryFees` = 71 EGP
- Net merchant due = 1270 - 71 = **1199 EGP**

**Current (buggy) Odoo flow:**
1. SO created: 1200 EGP (from Shopify line item price)
2. Invoice: 1200 EGP (from SO lines)
3. Payment: `min(1200, 1270) = 1200 EGP`
4. Odoo shows invoice fully paid — but merchant received 1199 EGP, not 1200 EGP

**Correct Odoo flow (after fix):**
1. SO created: 1200 EGP (from Shopify line item price) — **unchanged**
2. Invoice: 1200 EGP (from SO lines) — **unchanged**
3. Payment: `min(1200, collectedAmount - deliveryFees) = min(1200, 1199) = 1199 EGP`
4. Odoo shows invoice 1199/1200 paid, residual = 1 EGP
5. The 1 EGP gap correctly reflects that Telegraph retained 71 EGP but product was priced at 1200

**Does NOT create a shipping fee expense** — the `deliveryFees` is only used to reduce the payment amount. No expense line item.

**Shopify paid status:** After fix, `orderMarkAsPaid` should be called so Shopify financial status shows "Paid".

---

## 16. Exact Fix Plan

### Fix 1 — Odoo payment amount (BUG-1)

**File:** `src/odoo/odooSyncService.ts`

In `syncCollectedShipment()`, replace lines 387–388:

```ts
// BEFORE:
const collectedAmount = Number(record.collectedAmount ?? Number.parseFloat(order.current_total_price ?? order.total_price));
const amount = Math.min(residual, Number.isFinite(collectedAmount) && collectedAmount > 0 ? collectedAmount : residual);

// AFTER:
const collectedAmount = Number(record.collectedAmount ?? 0);
const deliveryFees = Number((record as { deliveryFees?: number | null }).deliveryFees ?? 0);
const netMerchantDue = collectedAmount > 0 ? Math.max(0, collectedAmount - deliveryFees) : 0;
const effectiveAmount = netMerchantDue > 0 ? netMerchantDue : (collectedAmount > 0 ? collectedAmount : residual);
const amount = Math.min(residual, effectiveAmount);
```

> Note: `record.deliveryFees` must exist as a DB column. Confirm in Prisma schema that `ShipmentRecord` has a `deliveryFees Float?` column. If not, add it in the next migration.

### Fix 2 — Mark Shopify as paid (BUG-2)

**File:** `src/odoo/odooSyncService.ts` or a new `src/shopify/shopifyPaymentClient.ts`

After `registerPayment()` succeeds in `syncCollectedShipment()`, call:
```ts
await requestShopifyAdmin(ORDER_MARK_AS_PAID_MUTATION, { input: { id: `gid://shopify/Order/${order.id}` } });
```

Wrap in try/catch — if Shopify rejects (e.g. no `write_payment_terms` scope), log warning and continue. Do not throw.

### Fix 3 — Disable return charge vendor bill (BUG-3)

**File:** `src/odoo/odooSyncService.ts`

In `syncReturnedShipmentCharge()`, either:
- Return early with a log message (if user confirms no accounting for returns)
- Or replace with a simple credit note instead of vendor bill (needs business decision)

### Fix 4 — Hardcoded account ID (BUG-4)

Add `ODOO_RETURN_EXPENSE_ACCOUNT_ID` to env, use it instead of `101`.

### Fix 5 — Timeout guard for status sync (T-1)

Add to `shipmentStatusSyncService.ts` `syncOpenShipments()`:
```ts
const startedAt = Date.now();
const maxMs = env.workerMaxRuntimeMs ?? 20000;
for (const record of openShipments) {
  if (Date.now() - startedAt >= maxMs) {
    logger.warn('syncOpenShipments: stopping early to avoid timeout', { synced: processed });
    break;
  }
  // ... existing try/catch
}
```

### Fix 6 — Confirm `deliveryFees` column in ShipmentRecord schema

Check `prisma/schema.prisma` — confirm `deliveryFees Float?` column exists. The production `shipmentRepository.ts` calls `prisma.shipmentRecord.update({ data: { deliveryFees: ... } })`. If the column is missing from the schema, this will be a runtime error.

---

## 17. Environment Variables Required

From `src/config/env.ts` (production branch):

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `DATABASE_URL` | ✅ | — | Neon PostgreSQL |
| `SHOPIFY_WEBHOOK_SECRET` | ✅ | — | HMAC webhook verification |
| `SHOPIFY_SHOP_DOMAIN` | ✅ | — | `violaleather.myshopify.com` |
| `SHOPIFY_CLIENT_ID` | ✅ | — | OAuth |
| `SHOPIFY_CLIENT_SECRET` | ✅ | — | OAuth |
| `ACCURATE_USERNAME` | ✅ | — | Telegraph/Accurate login |
| `ACCURATE_PASSWORD` | ✅ | — | Telegraph/Accurate login |
| `ACCURATE_DEFAULT_SERVICE_ID` | ✅ | — | Shipment service ID |
| `ODOO_SYNC_ENABLED` | ✅ | `false` | Must be `true` for Odoo sync |
| `ODOO_URL` | if Odoo enabled | — | e.g. `https://odoo.violaleather.com` |
| `ODOO_DB` | if Odoo enabled | — | Odoo database name |
| `ODOO_USERNAME` | if Odoo enabled | — | Odoo login user |
| `ODOO_PASSWORD` | if Odoo enabled | — | Odoo login password |
| `ODOO_PAYMENT_JOURNAL_ID` | if Odoo enabled | — | Journal ID for payment registration |

---

## 18. Pre-Deploy Checklist

| Item | Status |
|---|---|
| Fix BUG-1: payment amount uses `collectedAmount - deliveryFees` | ❌ Not fixed |
| Fix BUG-2: Shopify marked as paid after collection | ❌ Not fixed |
| Fix BUG-3: return charge vendor bill disabled/replaced | ❌ Needs business decision |
| Fix BUG-4: hardcoded `account_id: 101` | ❌ Not fixed |
| Fix T-1: timeout guard in syncOpenShipments | ❌ Not fixed |
| Confirm `deliveryFees` column in Prisma schema | ❓ Needs verification |
| `npx tsc --noEmit` passes | ❓ Not run on this branch |
| `npx prisma migrate deploy` ready | ❓ Check migration history |
| All required env vars set in Netlify | ❓ Not confirmed |

---

## 19. Deploy Readiness Verdict

**NOT READY** for deploy.

**Minimum fixes before deploy:**
1. BUG-1 (payment amount) — 5 lines of code change
2. BUG-3 determination — needs business decision: keep, remove, or replace return bill
3. T-1 (timeout guard) — 3 lines of code change
4. Confirm Prisma schema has `deliveryFees` column (otherwise runtime crash on every status sync)

**BUG-2** (Shopify mark as paid) can be deferred if the `write_payment_terms` scope hasn't been approved by Shopify.

**BUG-4** (hardcoded account) can be deferred as it only affects returns.

---

## 20. Files Involved — Summary

| File | Role |
|---|---|
| `extensions/make-telegraph-shipment/shopify.extension.toml` | Declares all 4 Shopify admin extension buttons |
| `src/routes/adminAppRoute.ts` | All 4 button routes + bulk routes + admin API routes |
| `src/services/shopifyOrderProcessor.ts` | Core: Telegraph creation + Shopify fulfillment + Odoo SO |
| `src/odoo/odooClient.ts` | Low-level Odoo JSON-RPC client |
| `src/odoo/odooSyncService.ts` | SO, MO, pickings, invoice, payment, return bill logic |
| `src/services/shipmentStatusSyncService.ts` | Status polling + Odoo payment trigger on collection |
| `src/services/shipmentRepository.ts` | All DB read/write for ShipmentRecord including Odoo fields |
| `src/services/accurateStatusMapper.ts` | Maps Accurate codes to collection statuses |
| `src/accurate/accurateClient.ts` | Telegraph/Accurate GraphQL client |
| `src/accurate/queries.ts` | All GQL queries — **deliveryFees is confirmed field name** |
| `src/shopify/shopifyFulfillmentClient.ts` | Shopify fulfillment creation |
| `src/shopify/shopifyStatusSyncClient.ts` | Shopify metafield/tag updates |
| `src/shopify/verifyWebhook.ts` | HMAC webhook verification |
| `src/netlify/functions/sync-open-shipments.ts` | Scheduled 10-min status sync function |
