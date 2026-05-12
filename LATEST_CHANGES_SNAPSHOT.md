# LATEST_CHANGES_SNAPSHOT.md
> Generated: 2026-05-12  
> Branch: `codex/viola-v5-sync-fixes`  
> Latest commit: `ffc0be3` — "Apply pre-deploy security and correctness fixes"  
> Previous commit: `48b9f91` — "Implement Viola v5 sync fixes" (baseline)  
> Uncommitted changes: **NONE** — working tree is clean

---

## Changed Files

| # | File | Type | Lines Changed |
|---|------|------|--------------|
| 1 | `src/shopify/verifyWebhook.ts` | Modified | +7 / -1 |
| 2 | `src/config/env.ts` | Modified | +13 / -0 |
| 3 | `src/middleware/adminAuth.ts` | **New file** | +54 |
| 4 | `src/app.ts` | Modified | +8 / -2 |
| 5 | `src/routes/accurateWebhookRoute.ts` | Modified | +24 / -1 |
| 6 | `src/odoo/odooSyncService.ts` | Modified | +28 / -4 |
| 7 | `src/services/shipmentStatusSyncService.ts` | Modified | +24 / -4 |
| 8 | `.env.example` | Modified | +19 / -0 |
| 9 | `FIX_IMPLEMENTATION_REPORT.md` | New doc file | +325 |
| 10 | `TEST_RESULTS_BEFORE_NEW_FIXES.md` | New doc file | +420 |
| 11 | `UPDATE_FLOW_DEEP_AUDIT.md` | New doc file | +535 |

---

## File-by-File Change Summary

---

### 1. `src/shopify/verifyWebhook.ts`
**What changed:** Added a buffer-length comparison before calling `crypto.timingSafeEqual()`.

**Before:**
```typescript
return crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(signatureHeader));
```

**After:**
```typescript
const digestBuf = Buffer.from(digest);
const sigBuf = Buffer.from(signatureHeader);
if (digestBuf.length !== sigBuf.length) return false;
return crypto.timingSafeEqual(digestBuf, sigBuf);
```

**Why:** `crypto.timingSafeEqual()` throws `RangeError` when buffers differ in byte length, causing an unhandled crash (500) instead of a safe rejection (401) for malformed `X-Shopify-Hmac-Sha256` headers.

**Flows affected:** Shopify `orders/create` webhook ingestion.

**Risk level:** 🟢 LOW — purely defensive fix, no business logic change. Normal path unaffected.

---

### 2. `src/config/env.ts`
**What changed:** Added 4 new environment variable readers using a new `optionalString()` helper.

New values:
- `syncTimeBudgetMs` ← `SYNC_TIME_BUDGET_MS` (default: `20_000`)
- `adminSecretToken` ← `ADMIN_SECRET_TOKEN` (default: `''`)
- `accurate.webhookSecret` ← `ACCURATE_WEBHOOK_SECRET` (default: `''`)
- `odoo.returnChargeAccountId` ← `ODOO_RETURN_CHARGE_ACCOUNT_ID` (via `optionalInt`)

**Why:** Each downstream fix requires its own configurable env var. `optionalString` returns `''` (empty string) instead of `undefined` so middleware can use falsy check.

**Flows affected:** All — env.ts is loaded at startup.

**Risk level:** 🟢 LOW — all new vars are optional with safe defaults. No required() calls added.

---

### 3. `src/middleware/adminAuth.ts` *(new file)*
**What changed:** New Express middleware that validates `ADMIN_SECRET_TOKEN`.

- Accepts token via `x-admin-secret` header OR `?adminToken=` query param.
- If token is not configured: passes request through + logs one-time warning.
- If token configured and wrong/missing: returns 401.
- Uses module-level `warnedOnce` flag to suppress repeated warnings.

**Why:** Admin routes were completely open. Anyone who discovered the URL could trigger Telegraph shipment creation, Odoo SO creation, bulk actions.

**Flows affected:** All admin routes under `/orders/*` and `/api/*`.

**Risk level:** 🔴 HIGH — see `BUG-NEW-1` in deep review; the embedded admin UI does not pass the token forward, so enabling this token breaks all admin UI buttons and forms.

---

### 4. `src/app.ts`
**What changed:**
1. Imported `adminAuth` from `./middleware/adminAuth.js`
2. Added `x-admin-secret` to `Access-Control-Allow-Headers`
3. Added two middleware registrations before the admin router:
```typescript
app.use('/orders', adminAuth);
app.use('/api', adminAuth);
```

**Why:** Apply admin protection at the Express app level so it catches all admin routes regardless of how the router registers them.

**Flows affected:** All requests to paths starting with `/orders` or `/api`. Webhooks (`/webhooks/*`) and `/health` are unaffected.

**Risk level:** 🔴 HIGH — same as above (BUG-NEW-1). When token is configured, the admin HTML pages' internal fetch calls and form POSTs will fail with 401.

---

### 5. `src/routes/accurateWebhookRoute.ts`
**What changed:** Added Accurate webhook secret validation block at the top of the request handler.

- Reads `env.accurate.webhookSecret`
- If set: validates `x-accurate-webhook-secret` header OR `?webhookSecret=` query param
- Mismatch → 401
- Not set → allows request + logs one-time warning (backward compat)
- Uses module-level `accurateSecretWarnedOnce` flag

**Why:** `/webhooks/accurate/shipment-status` was completely open — anyone could POST fake status updates.

**Flows affected:** Accurate/Telegraph → server webhook status updates.

**Risk level:** 🟡 MEDIUM — backward compat (env var not set = open). When configured, works correctly. Small security risk from query param logging (see deep review).

---

### 6. `src/odoo/odooSyncService.ts`

**BUG-1 fix** — `syncCollectedShipment()` (~line 387):

Before:
```typescript
const collectedAmount = Number(...);
const amount = Math.min(residual, Number.isFinite(collectedAmount) && collectedAmount > 0 ? collectedAmount : residual);
```

After:
```typescript
const collectedAmount = Number(...);
const deliveryFees = Number(record.deliveryFees ?? 0);
const netMerchantDue = Number.isFinite(collectedAmount) && collectedAmount > 0
  ? Math.max(0, collectedAmount - deliveryFees)
  : 0;
const amount = Math.min(residual, netMerchantDue > 0 ? netMerchantDue : residual);
```

Logger updated to emit `collectedAmount`, `deliveryFees`, `netMerchantDue`, `registeredAmount`.

**BUG-4 fix** — `createReturnShippingBill()` (~line 758):

Before: `account_id: 101` (hardcoded)

After:
```typescript
const accountId = env.odoo.returnChargeAccountId;
if (!accountId) throw new Error('ODOO_RETURN_CHARGE_ACCOUNT_ID is not configured...');
// ...
account_id: accountId
```

**Why:** BUG-1 — collected amount included delivery fees not owed to merchant; BUG-4 — hardcoded Odoo account ID not portable.

**Flows affected:** `collected` status sync → Odoo invoice payment registration; `returned` status sync → Odoo vendor bill creation.

**Risk level:** 🔴 HIGH for BUG-1 (critical money calculation fix); 🟡 MEDIUM for BUG-4; see also `BUG-NEW-2` edge case in deep review.

---

### 7. `src/services/shipmentStatusSyncService.ts`
**What changed:** `syncOpenShipments()` method gets a time-budget guard.

- Added `startTime = Date.now()` and `budgetMs = env.syncTimeBudgetMs` at start
- At top of each loop iteration: checks `Date.now() - startTime >= budgetMs`
- If budget exhausted: logs warning, sets `skipped = remaining`, breaks
- Return type extended from `{ processed; failed }` to `{ processed; failed; skipped }`
- Final `logger.info('syncOpenShipments complete', ...)` added

**Why:** Without a budget, a large batch could exceed Netlify's 26 s function timeout, killing the run mid-loop with no clear signal.

**Flows affected:** Scheduled `sync-open-shipments` Netlify function (runs hourly).

**Risk level:** 🟢 LOW — additive change, no regressions. Skipped records remain in open state and retry next run.

---

### 8. `.env.example`
**What changed:** Added documentation blocks for 4 new env vars:
- `SYNC_TIME_BUDGET_MS=20000`
- `ODOO_RETURN_CHARGE_ACCOUNT_ID=`
- `ADMIN_SECRET_TOKEN=` (under security section)
- `ACCURATE_WEBHOOK_SECRET=`

**Risk level:** 🟢 NONE — documentation only.

---

## Affected Flows Summary

| Flow | Files Changed | Impact |
|------|--------------|--------|
| Shopify webhook verification | `verifyWebhook.ts` | Security hardening (crash → 401) |
| Admin UI (all buttons + forms) | `adminAuth.ts`, `app.ts` | Protected by token — **broken if token is set** |
| Accurate status webhook | `accurateWebhookRoute.ts` | Secret validation added |
| Collected shipment → Odoo payment | `odooSyncService.ts` | Payment amount fixed (net, not gross) |
| Returned shipment → Odoo bill | `odooSyncService.ts` | account_id env-configurable |
| Scheduled status sync | `shipmentStatusSyncService.ts` | Time budget guard added |
| Config / env loading | `env.ts` | 4 new optional vars |

---

## Build Verification Results

| Command | Result |
|---------|--------|
| `npx prisma generate` | ✅ PASS — Prisma Client generated, 0 errors |
| `npx tsc --noEmit` | ✅ PASS — Exit code 0, 0 TypeScript errors |
| `npm run build` | ✅ PASS — Exit code 0, compiled to `dist/` |
