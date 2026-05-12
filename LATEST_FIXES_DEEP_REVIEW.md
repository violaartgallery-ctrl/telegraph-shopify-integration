# LATEST_FIXES_DEEP_REVIEW.md
> Generated: 2026-05-12  
> Branch: `codex/viola-v5-sync-fixes`  
> Commit reviewed: `ffc0be3` — "Apply pre-deploy security and correctness fixes"  
> Method: Static code review, scenario analysis, build verification  
> Rule: Read-only audit. No code changes. No deploy. No push.

---

## 1. Executive Summary

Six fixes were applied in commit `ffc0be3`. The build is clean (TypeScript + Prisma). However, two new bugs were discovered during this review that must be fixed before the admin auth and payment formula are considered safe to enable in production.

| | Finding | Severity |
|--|---------|----------|
| 🔴 | **BUG-NEW-1**: Admin auth breaks all embedded UI when token is set | CRITICAL |
| 🔴 | **BUG-NEW-2**: Payment formula edge case — fees > collected → wrong amount registered | MEDIUM |
| 🟡 | Security: `adminToken` and `webhookSecret` query params exposed in server access logs | MEDIUM |
| 🟡 | Security: Token comparisons not timing-safe (low practical risk) | LOW |
| 🟢 | Security: No secrets logged in log statements | PASS |
| 🟢 | BUG-1 payment formula: correct for normal case | PASS |
| 🟢 | BUG-SEC-1 HMAC fix: crash eliminated | PASS |
| 🟢 | T-1 timeout guard: logic correct | PASS |
| 🟢 | BUG-4 account_id: hardcode removed | PASS |
| 🟢 | All business flows (Make Shipment, Make Odoo SO, bulk): no regression | PASS |
| 🟢 | Webhook routes not blocked by admin auth | PASS |

**Deploy verdict: ⚠️ NOT READY** — Two new bugs (BUG-NEW-1 is critical) must be resolved. Details below.

---

## 2. Pass/Fail Table

| Fix | Status | Notes |
|-----|--------|-------|
| BUG-1: Net payment formula (happy path) | ✅ PASS | `collectedAmount - deliveryFees` is correct |
| BUG-1: Edge case `deliveryFees > collectedAmount` | ❌ FAIL | Registers `residual` instead of `0` — see BUG-NEW-2 |
| BUG-SEC-1: HMAC length guard | ✅ PASS | Length checked before `timingSafeEqual` |
| BUG-SEC-2: Accurate webhook secret | ✅ PASS | Validates when env var set, backward compat if unset |
| BUG-SEC-4: Admin auth applied to `/orders/*` `/api/*` | ✅ PASS | Middleware applied correctly |
| BUG-SEC-4: Admin auth not blocking webhooks | ✅ PASS | `/webhooks/*` paths unprotected |
| BUG-SEC-4: Admin UI HTML fetch calls pass token | ❌ FAIL | See BUG-NEW-1 — all internal fetch calls lack token |
| BUG-SEC-4: HTML form POSTs pass token | ❌ FAIL | Form hidden fields missing — see BUG-NEW-1 |
| BUG-SEC-4: Shopify App Extension compatibility | ❌ FAIL | Admin link can pass `?adminToken`, but embedded UI cannot |
| T-1: Time budget stops loop before timeout | ✅ PASS | Budget checked before each record |
| T-1: Skipped records not marked failed | ✅ PASS | `skipped` counter set; no `markFailed` on timeout |
| T-1: Works for 0 shipments | ✅ PASS | Loop does not execute |
| BUG-4: `account_id: 101` removed | ✅ PASS | Replaced with `env.odoo.returnChargeAccountId` |
| BUG-4: Fails clearly if env var missing | ✅ PASS | Throws descriptive error |
| Build clean | ✅ PASS | `tsc --noEmit` exit 0; `npm run build` exit 0 |
| No PII in logs | ✅ PASS | No customer data in new log statements |
| Secrets not logged | ✅ PASS | Token and secret values not emitted |
| Return bill logic intact | ✅ PASS | `syncReturnedShipmentCharge` unchanged |

---

## 3. Scenario Matrix

### 3A — BUG-1: Payment Formula

| Scenario | Expected | Current Behavior | Pass/Fail | File/Function | Risk | Recommendation |
|---|---|---|---|---|---|---|
| collected=1270, fees=71 | Register 1199 | 1270-71=1199 ✓ | ✅ PASS | `odooSyncService.ts:syncCollectedShipment` | — | — |
| fees=0 (null in DB) | Register collectedAmount | 0→0; netMerchantDue=collected; amount=min(residual,collected) ✓ | ✅ PASS | same | — | — |
| fees=null/undefined | Treat as 0; use collectedAmount | `Number(null ?? 0)=0` → same as fees=0 ✓ | ✅ PASS | same | — | — |
| collectedAmount=null, record not yet synced | Fallback to Shopify price | `Number.parseFloat(order.total_price)` used, fees=0 → full price ✓ | ✅ PASS | same | LOW | Acceptable fallback |
| collectedAmount=NaN / non-finite | Register residual | `Number.isFinite(NaN)=false` → netMerchantDue=0 → amount=residual | ⚠️ UNKNOWN | same | LOW | See BUG-NEW-2 — same edge path |
| fees (71) > collectedAmount (50) | Register 0, mark awaiting-payment | netMerchantDue=0 → amount=min(residual,residual)=residual → WRONG | ❌ FAIL | same | MEDIUM | Fix: `amount = netMerchantDue > 0 ? Math.min(residual, netMerchantDue) : 0` |
| residual ≤ 0 or invoice already paid | Skip payment, mark paid | `residual <= 0` check fires FIRST (line 377) → returns early ✓ | ✅ PASS | same | — | — |
| existingSalePaymentId set (duplicate sync) | Skip entire function | Early return at line 362-364 ✓ | ✅ PASS | same | — | — |
| Odoo payment created → DB update fails | Orphan payment in Odoo | No retry or rollback after `registerPayment` — pre-existing risk | ⚠️ UNKNOWN | same | MEDIUM | Pre-existing; not introduced by this fix |
| Already collected, re-synced via webhook | Skip (idempotent) | `existingSalePaymentId` check handles this ✓ | ✅ PASS | same | — | — |
| Returned shipment calls syncCollectedShipment | Should not happen | `syncReturnedShipmentCharge` is called instead; correct routing in syncRecord ✓ | ✅ PASS | `shipmentStatusSyncService.ts` | — | — |
| No delivery fee expense created | No expense entry | Code has no `account.move` of type `out_expense` for fees; only invoice payment ✓ | ✅ PASS | same | — | — |

---

### 3B — BUG-SEC-1: Shopify HMAC Verification

| Scenario | Expected | Current Behavior | Pass/Fail | File/Function | Risk | Recommendation |
|---|---|---|---|---|---|---|
| Valid signature (44-char base64) | 200, process order | `digestBuf.length == sigBuf.length (44)`, `timingSafeEqual` matches → true ✓ | ✅ PASS | `verifyWebhook.ts` | — | — |
| Invalid signature, same length | 401 | Length equal, `timingSafeEqual` does not match → false → 401 ✓ | ✅ PASS | same | — | — |
| Invalid signature, different length (e.g., 10 chars) | 401, no crash | `sigBuf.length=10 ≠ digestBuf.length=44` → false → 401 (no RangeError) ✓ | ✅ PASS | same | — | — |
| Missing header | 401 | `if (!signatureHeader) return false` fires first ✓ | ✅ PASS | same | — | — |
| Malformed base64 (e.g., "!!@@##") | 401 | Malformed chars are accepted by `Buffer.from(str)`; length likely differs → false ✓ | ✅ PASS | same | LOW | If attacker sends 44-char garbage → reaches timingSafeEqual → comparison fails cleanly |
| Empty body | Signature mismatch (legitimate body required) | HMAC of empty body computed; compared to header → false unless attacker knows secret | ✅ PASS | same | — | — |
| Secret is empty string | Always false | `SHOPIFY_WEBHOOK_SECRET` falls back to `SHOPIFY_CLIENT_SECRET` which is required | ✅ PASS | `env.ts` | — | — |

---

### 3C — BUG-SEC-4: Admin Auth Middleware

| Scenario | Expected | Current Behavior | Pass/Fail | File/Function | Risk | Recommendation |
|---|---|---|---|---|---|---|
| `ADMIN_SECRET_TOKEN` not set | Routes open + one-time warning | `!token` path → `next()` + logs warning ✓ | ✅ PASS | `adminAuth.ts` | MEDIUM | Set token in production |
| Token set, correct `x-admin-secret` header | 200, proceed | `provided == token` → `next()` ✓ | ✅ PASS | same | — | — |
| Token set, wrong `x-admin-secret` header | 401 | `provided !== token` → 401 ✓ | ✅ PASS | same | — | — |
| Token set, correct `?adminToken=` query param | 200, proceed | query param read, matches → `next()` ✓ | ✅ PASS | same | — | — |
| Token set, no token in request at all | 401 | `!provided` → 401 ✓ | ✅ PASS | same | — | — |
| Shopify webhook (`/webhooks/*`) with token set | Not blocked | `app.use('/orders', adminAuth)` and `app.use('/api', adminAuth)` don't match `/webhooks/*` ✓ | ✅ PASS | `app.ts` | — | — |
| `/health` with token set | Not blocked | `/health` registered before adminAuth middleware, BUT adminAuth uses path-prefix `app.use('/orders', ...)` which doesn't match `/health` ✓ | ✅ PASS | same | — | — |
| Admin page loads AND fetches `/api/orders` (token set) | Both should succeed | Page load (`GET /orders/make-telegraph`) → 401. JS fetch to `/api/orders` → 401. ALL FAIL. | ❌ FAIL BUG-NEW-1 | `adminAppRoute.ts` (embedded JS) | CRITICAL | See BUG-NEW-1 below |
| Bulk form submit (`POST /orders/make-telegraph/bulk`) with token set | Should succeed | Form POST has no hidden `adminToken` field → 401 | ❌ FAIL BUG-NEW-1 | `adminAppRoute.ts` (HTML forms) | CRITICAL | Same |
| Location selection form submit with token set | Should succeed | `POST /orders/make-telegraph/select` form has no token → 401 | ❌ FAIL BUG-NEW-1 | same | CRITICAL | Same |
| `GET /` (admin shell) with token set | Available | `GET /` is NOT under `/orders` or `/api` — NOT protected. Loads page but JS calls fail. | ⚠️ PARTIAL | `app.ts`, `adminAppRoute.ts` | MEDIUM | Inconsistency: root public but sub-routes protected |

---

### 3D — BUG-SEC-2: Accurate Webhook Secret

| Scenario | Expected | Current Behavior | Pass/Fail | File/Function | Risk | Recommendation |
|---|---|---|---|---|---|---|
| `ACCURATE_WEBHOOK_SECRET` not set | Open + one-time warning | `!webhookSecret` → allow + warn once ✓ | ✅ PASS | `accurateWebhookRoute.ts` | MEDIUM | Set in production |
| Secret set, correct `x-accurate-webhook-secret` header | 200 | Match → continues to business logic ✓ | ✅ PASS | same | — | — |
| Secret set, wrong header value | 401 | `provided !== webhookSecret` → 401 ✓ | ✅ PASS | same | — | — |
| Secret set, correct `?webhookSecret=` query param | 200 | Param read, matches → continues ✓ | ✅ PASS | same | — | — |
| Secret set, no credentials at all | 401 | `!provided` → 401 ✓ | ✅ PASS | same | — | — |
| Telegraph retries a rejected webhook | 401, retry fails | Telegraph may not retry on 401 (depends on its retry policy) | ⚠️ UNKNOWN | same | LOW | Verify Telegraph's retry policy; ensure secret matches |
| `?webhookSecret=` param appears in server logs | Secret visible in logs | Query param logged by access loggers | ❌ FAIL (security) | same | MEDIUM | Prefer header-only; doc strongly recommends header |
| Secret comparison is timing-safe | Immune to timing attacks | `provided !== webhookSecret` is plain equality, NOT timing-safe | ⚠️ LOW RISK | same | LOW | In practice webhook timing attacks impractical; acceptable |

---

### 3E — T-1: Timeout Guard

| Scenario | Expected | Current Behavior | Pass/Fail | File/Function | Risk | Recommendation |
|---|---|---|---|---|---|---|
| 0 open shipments | `{ processed:0, failed:0, skipped:0 }` | Loop doesn't execute; logs complete; returns zeros ✓ | ✅ PASS | `shipmentStatusSyncService.ts` | — | — |
| 1 open shipment, completes within budget | `{ processed:1, failed:0, skipped:0 }` | Budget checked (elapsed≈0), processed, final log ✓ | ✅ PASS | same | — | — |
| 5 shipments, budget exhausted after 2 | `{ processed:2, failed:0, skipped:3 }` | At iteration 3, elapsed≥budget → skipped=5-2-0=3, break ✓ | ✅ PASS | same | — | — |
| 1 shipment fails, then budget exhausted | `{ processed:n, failed:1, skipped:m }` | Failure increments `failed`, budget check before next continues ✓ | ✅ PASS | same | — | — |
| Remaining shipments NOT marked failed | Open state maintained | No `markFailed` called for budget-skipped records ✓ | ✅ PASS | same | — | — |
| Single `syncRecord` hangs > budget | Netlify may still kill run | Budget check is at LOOP START; cannot interrupt in-progress `syncRecord` | ⚠️ KNOWN LIMIT | same | LOW | Accepted limitation; much better than no guard |
| `SYNC_TIME_BUDGET_MS` not set | Default 20 000 ms applied | `optionalInt('SYNC_TIME_BUDGET_MS') ?? 20_000` ✓ | ✅ PASS | `env.ts` | — | — |
| Batch size = 10 (default) | Fetches 10 records max | `findOpenShipments(env.syncOpenShipmentsBatchSize)` default 10 ✓ | ✅ PASS | `shipmentRepository.ts` | — | — |
| `isTerminal` shipments excluded from open batch | Not re-fetched | `findOpenShipments` filters `accurateIsTerminal: null OR false` ✓ | ✅ PASS | `shipmentRepository.ts` | — | — |

---

### 3F — BUG-4: Return Charge Account ID

| Scenario | Expected | Current Behavior | Pass/Fail | File/Function | Risk | Recommendation |
|---|---|---|---|---|---|---|
| `ODOO_RETURN_CHARGE_ACCOUNT_ID` not set | Throw clear error | `!accountId` → throws descriptive message ✓ | ✅ PASS | `odooSyncService.ts:createReturnShippingBill` | — | — |
| `ODOO_RETURN_CHARGE_ACCOUNT_ID=123` | Creates bill with account 123 | `account_id: 123` in line creation ✓ | ✅ PASS | same | — | — |
| Env var is wrong account | Wrong account posting in Odoo | No validation beyond presence; Odoo will error or post incorrectly | ⚠️ UNKNOWN | same | MEDIUM | User must verify account ID manually |
| Return bill still created for return fee | Bill created (not deleted) | `syncReturnedShipmentCharge` unchanged; bill logic intact ✓ | ✅ PASS | same | — | — |
| Return bill not created for delivery fee | No expense for delivery fee | No `account.move` created for deliveryFees in collected flow ✓ | ✅ PASS | same | — | — |
| Return sync called when `ODOO_RETURN_CHARGE_ACCOUNT_ID` not set | Error saved to FailedSyncPayload | `createReturnShippingBill` throws → caught in `syncReturnedShipmentCharge` → saved to `failedPayloadService` ✓ | ✅ PASS | `shipmentStatusSyncService.ts` | — | — |

---

### 3G — Regression Check: Existing Flows

| Flow | Touched Files | Regression Risk | Verdict |
|------|--------------|----------------|---------|
| Make Telegraph Shipment (single, via Shopify Extension) | `app.ts` (path prefix) | 🔴 HIGH — `GET /orders/make-telegraph?id=xxx` will 401 if token set | ❌ BREAKS when token is set |
| Make Telegraph Shipment (via admin UI button) | `adminAppRoute.ts` embedded JS | `POST /api/orders/create-shipment` → 401 if token set | ❌ BREAKS when token is set |
| Make Telegraph Shipments (bulk, via Shopify Extension) | `app.ts` | `GET /orders/make-telegraph/bulk?selected=xxx` → 401 if token set | ❌ BREAKS when token is set |
| Make Odoo Sales Order (single) | `app.ts` | `GET /orders/create-odoo-sales-order?id=xxx` → 401 if token set | ❌ BREAKS when token is set |
| Make Odoo Sales Orders (bulk) | `app.ts` | `GET /orders/create-odoo-sales-order/bulk?selected=xxx` → 401 if token set | ❌ BREAKS when token is set |
| Shopify webhook (orders/create) | `verifyWebhook.ts` | `verifyShopifyWebhook` logic unchanged except crash fix; normal path ✓ | ✅ NO REGRESSION |
| Status sync: collected → Odoo payment | `odooSyncService.ts` | BUG-1 fix changes amount. Correct for normal case. Edge case (fees>collected) broken. | ⚠️ EDGE CASE |
| Status sync: returned → Odoo bill | `odooSyncService.ts` | BUG-4: bill fails if `ODOO_RETURN_CHARGE_ACCOUNT_ID` not set (previously used 101 silently) | ⚠️ BREAKING if env var not set |
| Status sync: Shopify metafield update | `shipmentStatusSyncService.ts` | Unchanged in sync logic; only timeout guard added | ✅ NO REGRESSION |
| Scheduled sync (Netlify function) | `shipmentStatusSyncService.ts` | Timeout guard is additive; `skipped` added to return value | ✅ NO REGRESSION |
| Accurate webhook status push | `accurateWebhookRoute.ts` | Backward compat (secret not set = open); business logic unchanged | ✅ NO REGRESSION |
| Odoo SO creation | `odooSyncService.ts` | `ensureSalesOrder()` unchanged | ✅ NO REGRESSION |
| Odoo MO creation / completion | `odooSyncService.ts` | `prepareSalesOrderStock()` unchanged | ✅ NO REGRESSION |
| Odoo delivery validation | `odooSyncService.ts` | `confirmSalesOrderDelivery()` unchanged | ✅ NO REGRESSION |
| Odoo invoice creation | `odooSyncService.ts` | `findOrCreatePostedSaleInvoice()` unchanged | ✅ NO REGRESSION |
| Odoo payment registration (collected, normal) | `odooSyncService.ts` | `registerPayment()` unchanged; amount computed differently (correct) | ✅ PASS |

---

## 4. Confirmed Bugs

### BUG-NEW-1 — Admin Auth Breaks Entire Admin UI When Token Is Set
**Severity:** 🔴 CRITICAL  
**File:** `src/routes/adminAppRoute.ts` (not changed), `src/app.ts`, `src/middleware/adminAuth.ts`  
**Status:** Not in latest commit. Introduced as a side effect of BUG-SEC-4.

**Root cause:** The admin HTML pages contain embedded JavaScript that makes bare `fetch()` calls to `/api/*` routes, and HTML forms that POST to `/orders/*` routes. None of these include the `x-admin-secret` header or `adminToken` query param.

Affected fetch calls (in `renderAppShell()` JS):
```javascript
fetch('/api/orders')                          // line 100
fetch('/api/orders/create-shipment', ...)     // line 119
fetch('/api/orders/create-odoo-sales-order', ...) // line 144
fetch('/api/accurate/locations')              // line 163
```

Affected form actions (in HTML templates):
```html
<form method="post" action="/orders/make-telegraph/select">         <!-- line 365 -->
<form method="post" action="/orders/make-telegraph/bulk">           <!-- line 562 -->
<form method="post" action="/orders/create-odoo-sales-order/bulk">  <!-- line 640 -->
```

Affected Shopify App Extension requests (open URL in browser):
- `GET /orders/make-telegraph?id=xxx`
- `GET /orders/make-telegraph/bulk?selected=xxx`
- `GET /orders/create-odoo-sales-order?id=xxx`
- `GET /orders/create-odoo-sales-order/bulk?selected=xxx`

**Impact:** When `ADMIN_SECRET_TOKEN` is set, **every single admin interaction returns 401**. The protection is self-defeating — it blocks the intended users (Shopify admin staff) along with attackers.

**Current state (safe):** Because `adminSecretToken` defaults to empty string (`''`), the `if (!token)` branch fires, and all routes remain open (same as before the fix). Do NOT set `ADMIN_SECRET_TOKEN` until BUG-NEW-1 is fixed.

**Fix required:** Either:
1. Inject the admin token into the rendered HTML and pass it via JS fetch headers + form hidden fields (template-based approach), OR
2. Use cookie-based session auth (set `HttpOnly` cookie on the initial page load, validate cookie in middleware) — more robust, no token leaking in logs, compatible with Shopify App Extension redirects.

---

### BUG-NEW-2 — Payment Formula: When deliveryFees > collectedAmount
**Severity:** 🟡 MEDIUM (edge case, unlikely in real COD flow)  
**File:** `src/odoo/odooSyncService.ts`, line 396  
**Status:** Not in latest commit. Flaw in the BUG-1 formula.

**Root cause:**
```typescript
const netMerchantDue = Number.isFinite(collectedAmount) && collectedAmount > 0
  ? Math.max(0, collectedAmount - deliveryFees)  // = 0 when fees > collected
  : 0;
const amount = Math.min(residual, netMerchantDue > 0 ? netMerchantDue : residual);
//                                ^^^^^^^^^^^^^^^^^^^
//  When netMerchantDue = 0 (because fees > collected):
//  amount = Math.min(residual, residual) = residual ← WRONG
```

When `deliveryFees > collectedAmount` (e.g., fees=71, collected=50), `netMerchantDue` correctly becomes 0, but the fallback `? netMerchantDue : residual` substitutes `residual`, causing the full invoice residual to be registered as payment.

**Expected behavior:** `amount = 0` → triggers `if (amount <= 0)` guard → saves as `'invoice-posted-awaiting-payment'`.

**Fix (one line):**
```typescript
// Replace:
const amount = Math.min(residual, netMerchantDue > 0 ? netMerchantDue : residual);
// With:
const amount = netMerchantDue > 0 ? Math.min(residual, netMerchantDue) : 0;
```

**Practical impact:** In a normal COD collected flow, `collectedAmount` will always be ≥ `deliveryFees` (Telegraph charges fee from collected cash). This edge case may never occur in production. However, it's a code correctness issue that should be fixed before production.

---

## 5. Possible Bugs / Unknowns

### POSSIBLE-1 — `collectedAmount` null + `deliveryFees` > Shopify price
**Severity:** LOW  
When `record.collectedAmount` is null (not yet synced from Telegraph), the code falls back to Shopify's `current_total_price` or `total_price`. If `deliveryFees` was synced separately and is non-zero, the deduction applies to the Shopify price — which may not equal the actual collected amount.

**Current state:** When `syncCollectedShipment` is called, the record should already have `collectedAmount` populated from the status sync that triggered the `collected` status. If `collectedAmount` is null at this point, it indicates a sync ordering problem, not introduced by this fix.

**Verdict:** Pre-existing edge case; acceptable risk.

---

### POSSIBLE-2 — `warnedOnce` Module Flag in Serverless
**Severity:** INFORMATIONAL  
`let warnedOnce = false` in `adminAuth.ts` and `let accurateSecretWarnedOnce = false` in `accurateWebhookRoute.ts` are module-level variables. In Express server mode, they persist across requests (correct). In Netlify Functions (serverless), each invocation is a cold start — the "once" suppression is meaningless and the warning logs on every Netlify invocation.

**Impact:** Log noise. Not a functional bug. The webhook route is separate from the Netlify scheduled function anyway.

---

### POSSIBLE-3 — `GET /` admin shell not protected by adminAuth
**Severity:** LOW  
`router.get('/')` in `adminAppRoute.ts` renders the full admin HTML shell with order management UI. This route is NOT under `/orders` or `/api`, so `adminAuth` does not apply. The shell page loads without a token. However, its embedded JavaScript then calls `/api/orders` (which IS protected), so no order data is exposed when the token is set — the page just loads with a 401 error in the fetch call.

**Impact:** Slight inconsistency in protection model. Not a data leak if token is set.

---

### POSSIBLE-4 — Telegraph Webhook Retry on 401
**Severity:** LOW  
When `ACCURATE_WEBHOOK_SECRET` is set and Telegraph sends a webhook with the wrong or missing secret, the endpoint returns 401. Telegraph's retry behavior on 401 is not documented in the codebase. If Telegraph does not retry on 401, a misconfigured secret would cause status updates to be permanently lost.

**Mitigation:** The polling-based `sync-open-shipments` function will catch up on missed status updates.

---

## 6. Regression Risks

| Risk | Scenario | Likelihood | Impact | Mitigation |
|------|----------|-----------|--------|------------|
| Admin UI completely breaks | `ADMIN_SECRET_TOKEN` is set | HIGH (obvious deploy action) | CRITICAL | Do NOT set token until BUG-NEW-1 is fixed |
| Return bill fails on deploy | `ODOO_RETURN_CHARGE_ACCOUNT_ID` not set | HIGH (new required var) | MEDIUM | Set env var before first return is synced |
| Status sync stops triggering bill | `ODOO_RETURN_CHARGE_ACCOUNT_ID` missing | HIGH | MEDIUM | Same as above |
| Payment overpaid (BUG-NEW-2) | fees > collected | VERY LOW | MEDIUM | Fix before production |

---

## 7. Security Risks

| Risk | Severity | Location | Detail |
|------|----------|----------|--------|
| `?adminToken=xxx` in URL | MEDIUM | `adminAuth.ts`, any server access log | Admin token visible in server access log, browser history, Nginx/Netlify logs. Prefer header-only auth. |
| `?webhookSecret=xxx` in URL | MEDIUM | `accurateWebhookRoute.ts` | Same — webhook secret visible in logs |
| Token comparison not timing-safe | LOW | `adminAuth.ts:45`, `accurateWebhookRoute.ts:22` | `!== ` is not `crypto.timingSafeEqual`. Theoretical timing attack possible. Very low practical risk for shared secret. |
| CORS `Access-Control-Allow-Origin: *` | MEDIUM | `app.ts:37` | Wildcard CORS still present. Partially mitigated by admin auth but not fixed. |
| Admin UI at `GET /` is public | LOW | `app.ts`, `adminAppRoute.ts` | Root URL renders the admin shell without auth. No data returned until JS calls succeed, but page HTML is public. |
| Secrets not logged | ✅ PASS | All files | No `adminSecretToken`, `webhookSecret` printed in log statements. |
| Customer PII in admin UI | ✅ PASS | Admin UI is protected (when enabled) | Customer name, phone, address only accessible to authenticated admin callers |

---

## 8. Timeout Risks

| Scenario | Risk | Detail |
|----------|------|--------|
| Single `syncRecord` hangs longer than budget | LOW | Budget check is at loop start; cannot interrupt an in-progress async call. If one Accurate API call takes 25+ seconds, Netlify may kill the function. |
| Budget too tight | LOW | Default 20 s; Netlify limit ~26 s. 6 s buffer may be tight if startup takes >2 s. Configurable via `SYNC_TIME_BUDGET_MS`. |
| `findOpenShipments` itself times out | LOW | DB query is not inside budget check; if Neon DB is slow, query time is not counted against the per-record budget. Acceptable. |
| Many shipments accumulate | LOW | Batch size 10 limits per-run processing. If open shipments grow to 1000, it would take 100 hourly runs to process all. Consider increasing batch size. |

---

## 9. Duplicate / Race Risks

| Scenario | Risk | Current Protection | Verdict |
|----------|------|---------------------|---------|
| Double-click on "Make Telegraph Shipment" | MEDIUM | `reserveForOrder` / `upsert` pattern in `createPending`; `saveShipmentWithFreshCodeRetry` | ✅ Protected (pre-existing) |
| Shopify webhook + manual admin button same time | MEDIUM | DB upsert + `claimOdooSalesOrderCreation` lock | ✅ Protected (pre-existing) |
| Duplicate Shopify webhook (Shopify retry) | HIGH | No `ProcessedWebhook` table; shipment creation may be idempotent via `upsert` but Odoo sync may double-trigger | ⚠️ KNOWN GAP (pre-existing, not introduced by this fix) |
| Webhook status push + polling status same time | LOW | Both call `updateAccurateSnapshot` — last writer wins; idempotent status update | ✅ Acceptable |
| Collected sync called twice (webhook + poll) | MEDIUM | `existingSalePaymentId` check at top of `syncCollectedShipment` — idempotent | ✅ Protected |
| Odoo payment created twice | MEDIUM | `odooSalePaymentId` check prevents second payment registration ✓ | ✅ Protected |
| Bulk + single action for same order simultaneously | LOW | `claimOdooSalesOrderCreation` DB lock serializes Odoo SO creation | ✅ Protected (pre-existing) |

---

## 10. Required Fixes Before Deploy

### REQUIRED (blockers):

**R-1 (BUG-NEW-1): Fix admin auth to pass token through the UI**  
The admin HTML pages must inject the token into fetch headers and HTML form hidden fields. Until this is done:
- `ADMIN_SECRET_TOKEN` MUST remain unset in production (backward compat mode — routes open)
- Setting the token will break all Shopify admin buttons and the admin web UI

Suggested fix approach:
- In `renderAppShell()` and other HTML renderers, accept a `token?: string` parameter
- Inject `data-admin-token` attribute on a root element
- Embedded JS reads it and includes `'x-admin-secret': token` in all `fetch()` headers
- Form POSTs include a `<input type="hidden" name="adminToken" value="...">` field
- Admin route handlers pass the request's token down to the rendered page

**R-2 (BUG-NEW-2): Fix payment formula edge case**  
One-line fix in `odooSyncService.ts`:
```typescript
// Current (broken when fees > collected):
const amount = Math.min(residual, netMerchantDue > 0 ? netMerchantDue : residual);

// Fixed:
const amount = netMerchantDue > 0 ? Math.min(residual, netMerchantDue) : 0;
```

### STRONGLY RECOMMENDED (before setting env vars):

**S-1: Set `ADMIN_SECRET_TOKEN` ONLY after R-1 is fixed**

**S-2: Set `ACCURATE_WEBHOOK_SECRET`** — safe to set now; backward compat works.

**S-3: Set `ODOO_RETURN_CHARGE_ACCOUNT_ID`** — required before a returned shipment is synced. Confirm account ID in Odoo Chart of Accounts.

**S-4: Prefer `x-accurate-webhook-secret` header over `?webhookSecret=` query param** — document in Telegraph webhook configuration to avoid secret leaking in logs.

**S-5: Prefer `x-admin-secret` header over `?adminToken=`** — same reason.

---

## 11. Deploy Readiness Verdict

```
STATUS: ⚠️ NOT READY
```

**Reason:** BUG-NEW-1 is a critical regression — the primary security fix (admin auth) is self-defeating when actually activated. It would break all Shopify admin buttons and the admin web UI for the team.

**What IS safe to deploy now:**
- ✅ BUG-SEC-1 (HMAC crash fix) — fully safe
- ✅ T-1 (timeout guard) — fully safe
- ✅ BUG-SEC-2 (Accurate webhook secret) — safe if `ACCURATE_WEBHOOK_SECRET` env var is set
- ✅ BUG-1 payment formula — safe for normal case (set `ODOO_RETURN_CHARGE_ACCOUNT_ID` first)
- ✅ BUG-4 account_id — safe if `ODOO_RETURN_CHARGE_ACCOUNT_ID` is set

**What must be fixed first:**
- 🔴 R-1: Fix admin auth HTML/JS to forward the token (BUG-NEW-1)
- 🟡 R-2: Fix payment formula edge case when fees > collected (BUG-NEW-2)

**Decision path:**
1. Fix BUG-NEW-1 + BUG-NEW-2
2. Run `npx tsc --noEmit` + `npm run build` again
3. Set `ACCURATE_WEBHOOK_SECRET` + `ODOO_RETURN_CHARGE_ACCOUNT_ID` in Netlify env vars
4. Set `ADMIN_SECRET_TOKEN` AFTER BUG-NEW-1 is fixed
5. Deploy
```
