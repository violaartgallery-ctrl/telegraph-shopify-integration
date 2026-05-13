# Viola V6 Audit, Fix, and Local Test Report

## 1. Current Branch

- Branch: `codex/viola-v5-sync-fixes`
- Status at start: branch was ahead of `origin/codex/viola-v5-sync-fixes` by 2 commits.
- Working tree at start: clean.
- Working tree after V6 fixes: modified files listed below; no commit, no push, no deploy.

## 2. Latest Commits Reviewed

- `783c8c0` - `Add code snapshot and deep review audit for ffc0be3 fixes`
- `ffc0be3` - `Apply pre-deploy security and correctness fixes`
- Also reviewed context from `48b9f91` because it contains the V5 sync changes these fixes depend on.

## 3. Every Changed File

From `ffc0be3`:
- `.env.example`
- `FIX_IMPLEMENTATION_REPORT.md`
- `TEST_RESULTS_BEFORE_NEW_FIXES.md`
- `UPDATE_FLOW_DEEP_AUDIT.md`
- `src/app.ts`
- `src/config/env.ts`
- `src/middleware/adminAuth.ts`
- `src/odoo/odooSyncService.ts`
- `src/routes/accurateWebhookRoute.ts`
- `src/services/shipmentStatusSyncService.ts`
- `src/shopify/verifyWebhook.ts`

From `783c8c0`:
- `LATEST_CHANGES_SNAPSHOT.md`
- `LATEST_FIXES_DEEP_REVIEW.md`

V6 local fixes in this review:
- `src/routes/adminAppRoute.ts`
- `src/odoo/odooSyncService.ts`
- `src/scripts/testTelegraphScenarioMatrix.ts`
- `VIOLA_V6_AUDIT_FIX_AND_TEST_REPORT.md`

## 4. What Claude Changed

- Added `ADMIN_SECRET_TOKEN` support and `adminAuth` middleware for `/orders/*` and `/api/*`.
- Added Accurate/Telegraph webhook shared-secret validation through `ACCURATE_WEBHOOK_SECRET`.
- Added Shopify webhook HMAC length check before `timingSafeEqual`.
- Added sync batch size and time budget settings.
- Added per-record failure capture for shipment sync.
- Added documentation/audit files.
- Changed collected-payment handling toward net merchant due, but left a residual fallback bug.

## 5. Flows Affected

- `Make Telegraph shipment`: `/orders/make-telegraph`
- `Make Telegraph shipments bulk`: `/orders/make-telegraph/bulk`
- `Make Odoo Sales Order`: `/orders/create-odoo-sales-order`
- `Make Odoo Sales Orders bulk`: `/orders/create-odoo-sales-order/bulk`
- Dashboard/internal API: `/api/orders`, `/api/orders/create-shipment`, `/api/orders/create-odoo-sales-order`, `/api/accurate/locations`
- Shopify webhook: `/webhooks/shopify/orders-create`
- Telegraph webhook: `/webhooks/accurate/shipment-status`
- Scheduled polling: `src/netlify/functions/sync-open-shipments.ts`

## 6. Bugs Found

- `BUG-NEW-1`: admin UI pages called protected `/api/*` routes without `x-admin-secret`, and POST forms did not preserve `adminToken`.
- `BUG-NEW-2`: payment amount still fell back to full invoice residual when `netMerchantDue <= 0`.
- Confirmed local edge: JavaScript `Number(null) === 0`, so missing `deliveryFees` could still overpay unless null/undefined is checked before conversion.
- Shopify paid status: current code updates tags/metafields only; it does not mark Shopify orders paid. This is not changed in V6 because it needs explicit Shopify API contract validation and should be deployed as a separate controlled change.

## 7. Bugs Fixed

- Fixed admin token propagation:
  - rendered pages keep `adminToken`;
  - page `fetch()` calls send `x-admin-secret`;
  - internal fetch URLs preserve `adminToken`;
  - bulk forms preserve `adminToken` in action URL;
  - forms include hidden `adminToken`.
- Fixed payment formula:
  - payment is calculated from `customerDue` when positive, otherwise `collectedAmount - deliveryFees`;
  - never falls back to full residual when net due is zero/negative;
  - missing `collectedAmount` or missing `deliveryFees` results in no payment instead of an unsafe overpayment;
  - invoice residual still caps payment.
- Added local scenario tests for the payment formula.

## 8. Bugs Not Fixed and Why

- Shopify `Mark as paid`: not implemented in this pass. The current client has tag/metafield sync only. Adding `orderMarkAsPaid` changes money-state behavior and needs a focused API-permission test with a safe sample order before production.
- Shopify Admin action entry URLs: if `ADMIN_SECRET_TOKEN` is set, Shopify action URLs must enter with `?adminToken=...` or the route will correctly reject them. This report does not change production app configuration.

## 9. Security Review

- `src/middleware/adminAuth.ts`: protects `/orders/*` and `/api/*` when `ADMIN_SECRET_TOKEN` exists.
- `src/app.ts`: webhook routes are not behind admin auth, which is correct.
- `src/shopify/verifyWebhook.ts`: malformed HMAC length no longer crashes timing-safe comparison.
- `src/routes/accurateWebhookRoute.ts`: Accurate webhook validates its own shared secret if configured.
- No secrets were printed or written in this report.
- Risk: CORS is still `*`; acceptable only because admin routes require a secret when configured. If `ADMIN_SECRET_TOKEN` is empty, admin routes remain open by design/backward compatibility.

## 10. Timeout Review

- `SYNC_OPEN_SHIPMENTS_BATCH_SIZE` default: `10`.
- `SYNC_TIME_BUDGET_MS` default: `20000`.
- `syncOpenShipments()` stops when budget is exhausted and does not mark unprocessed records failed.
- One failed shipment is saved in `FailedPayload` and does not stop the rest of the batch.

## 11. Duplicate / Race Condition Review

- Existing shipment record is checked before creating a new Telegraph shipment.
- If saved shipment no longer exists in Telegraph, local record is cleared and shipment can be recreated.
- Duplicate shipment code errors retry with a fresh reserved code.
- Odoo Sales Order creation checks existing record/name before creating another one.
- Payment sync checks existing sale payment id and paid invoice state before registering payment.
- Remaining risk: concurrent double-click before DB write can still race unless the repository/database has a unique constraint on `shopifyOrderId`.

## 12. Odoo Regression Review

- Odoo Sales Order logic was not rewritten.
- MO, delivery/picking, invoice, and payment workflow functions were preserved.
- `Make Telegraph shipment` still calls Odoo sales order sync and delivery confirmation where it already did.
- `Make Odoo Sales Order` still creates SO only and uses `prepareStock: false`.
- Payment calculation was narrowed to safe merchant due only.
- Delivery company delivery fees are not recorded as Odoo expenses in collected-order sync.
- Return bill behavior remains as existing V5 behavior.

## 13. Shopify Regression Review

- Admin action route definitions exist in `extensions/make-telegraph-shipment/shopify.extension.toml`.
- Fulfillment creation still prevents duplicate fulfillment when order is already fulfilled.
- Tracking attachment still uses Telegraph shipment code and dashboard URL.
- Status sync still updates tags and metafields.
- Shopify paid-state mutation is not present.

## 14. Telegraph / Accurate Regression Review

- Shipment creation path preserved.
- Existing deleted-shipment recovery path preserved.
- Status mapper covers delivered, collected, payment-review, returned, out-for-delivery, exception, redelivery, cancelled, and unknown.
- Webhook and polling both call the same `syncRecord()` path.
- Valid webhook does not require admin token; it requires `ACCURATE_WEBHOOK_SECRET` when configured.

## 15. Local Tests Run

- `npx prisma generate` - PASS
- `npx tsc --noEmit -p tsconfig.json` - PASS
- `npm run test:telegraph-scenarios` - PASS after fixing the `deliveryFees=null` overpay edge
- `npm run build` - PASS

No Netlify deploy was run. No Git push was run. No production env values were changed.

## 16. Scenario Matrix

### Admin Auth

| Scenario | Expected | Local status |
|---|---|---|
| no token | 401 if `ADMIN_SECRET_TOKEN` is set | Static verified |
| wrong token | 401 | Static verified |
| correct header token | allowed | Static verified |
| correct query token | allowed | Static verified |
| internal fetch after page load | sends `x-admin-secret` | Fixed/static verified |
| form submit after page load | preserves token in action URL and hidden input | Fixed/static verified |
| bulk action with token | preserved | Fixed/static verified |
| location selection with token | preserved | Fixed/static verified |

### Payment

| Scenario | Expected | Local status |
|---|---|---|
| collected=1270, deliveryFees=71 | pay 1199 | PASS |
| collected=50, deliveryFees=71 | pay 0 | PASS |
| deliveryFees=0 | pay collected capped by residual | PASS |
| deliveryFees missing | pay 0 | PASS |
| collectedAmount missing | pay 0 | PASS |
| already paid invoice | no new payment | Static verified |
| residual smaller than net due | pay residual only | PASS |

### Shopify

| Scenario | Expected | Local status |
|---|---|---|
| order already fulfilled | skip duplicate fulfillment | Static verified |
| order already paid | no paid-state mutation currently | Known gap |
| fulfillment exists but tracking missing | current behavior skips if fulfilled | Known limitation |
| mark paid fails | not applicable; mark paid not implemented | Known gap |
| duplicate button click | existing shipment path used; DB race still possible | Static verified/risk noted |

### Odoo

| Scenario | Expected | Local status |
|---|---|---|
| SO already exists | no duplicate SO | Static verified |
| invoice already exists | reuse/post/pay safely | Static verified |
| payment already exists | no duplicate payment | Static verified |
| MO already done | existing logic preserved | Static verified |
| delivery already validated | existing logic preserved | Static verified |
| product mapping missing | preview/not-ready path blocks bulk | Static verified |
| Odoo API fails mid-flow | failed payload/log path preserved | Static verified |

### Telegraph

| Scenario | Expected | Local status |
|---|---|---|
| webhook update valid | sync record | Static verified |
| webhook missing secret | 401 if secret configured | Static verified |
| webhook wrong secret | 401 | Static verified |
| polling same shipment while webhook arrives | same sync path; idempotency depends on repository/Odoo checks | Static verified/risk noted |
| delivered and collected | Shopify tags/metafields + Odoo collected sync | Scenario test PASS |
| returned | returned sync path | Scenario test PASS |
| cancelled | terminal cancelled tag | Scenario test PASS |

## Required Netlify Environment Variables

Required:
- `DATABASE_URL`
- `SHOPIFY_SHOP_DOMAIN`
- `SHOPIFY_CLIENT_ID`
- `SHOPIFY_CLIENT_SECRET`
- `ACCURATE_GRAPHQL_ENDPOINT`
- `ACCURATE_USERNAME`
- `ACCURATE_PASSWORD`
- `ACCURATE_DEFAULT_SHIPMENT_TYPE`
- `ACCURATE_DEFAULT_PAYMENT_TYPE`

Strongly recommended / production:
- `ADMIN_SECRET_TOKEN`
- `ACCURATE_WEBHOOK_SECRET`
- `SHOPIFY_WEBHOOK_SECRET`
- `ODOO_SYNC_ENABLED`
- `ODOO_URL`
- `ODOO_DB`
- `ODOO_USERNAME`
- `ODOO_PASSWORD`
- `ODOO_PAYMENT_JOURNAL_ID`
- `SYNC_OPEN_SHIPMENTS_BATCH_SIZE`
- `SYNC_TIME_BUDGET_MS`
- `ORDER_REFERENCE_PREFIX`
- `SHIPMENT_CODE_PREFIX`
- `SHIPMENT_CODE_START`

## Final Deploy Readiness Verdict

Verdict: `READY` for a controlled staging deploy after confirming the Shopify Admin action entry URL strategy for `ADMIN_SECRET_TOKEN`.

Production note: do not deploy directly to production until a safe sample verifies Shopify paid-state expectations. Current code still marks status with tags/metafields, not Shopify financial paid status.
