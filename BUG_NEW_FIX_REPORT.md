# BUG_NEW_FIX_REPORT.md
> Applied: 2026-05-12  
> Branch: `codex/viola-v5-sync-fixes`  
> Fixes for: BUG-NEW-1 and BUG-NEW-2 discovered in `LATEST_FIXES_DEEP_REVIEW.md`  
> Rule: No deploy. No push. No business logic changes.

---

## Files Changed

| File | Change |
|------|--------|
| `src/routes/adminAppRoute.ts` | BUG-NEW-1: Admin token propagation through all HTML pages, forms, and fetch calls |
| `src/odoo/odooSyncService.ts` | BUG-NEW-2: Payment formula refactored into `calculateTelegraphMerchantPaymentAmount`; edge case fixed |
| `src/scripts/testTelegraphScenarioMatrix.ts` | 8 new test cases for `calculateTelegraphMerchantPaymentAmount` |

---

## Fix 1 — BUG-NEW-1: Admin Token Propagation

### Problem
When `ADMIN_SECRET_TOKEN` is set, the admin HTML pages made fetch calls and form submissions to protected routes (`/api/*`, `/orders/*`) without including the token. Every admin interaction returned 401, making the security fix self-defeating.

### Changes in `src/routes/adminAppRoute.ts`

**New helper functions added (module level):**

```typescript
// Reads adminToken from query string on page load
const extractAdminToken = (request: Request): string =>
  typeof request.query.adminToken === 'string' ? request.query.adminToken : '';

// Appends adminToken to any URL (used for form action attributes)
const adminPath = (path: string, adminToken?: string): string => {
  if (!adminToken) return path;
  return `${path}${path.includes('?') ? '&' : '?'}adminToken=${encodeURIComponent(adminToken)}`;
};

// Renders a hidden form field (empty string when no token — backward compat)
const adminHiddenInput = (adminToken?: string): string =>
  adminToken ? `<input type="hidden" name="adminToken" value="${escapeHtml(adminToken)}" />` : '';

// Injects JS variables into rendered pages so fetch calls can use token
const renderAdminScriptContext = (adminToken?: string): string => `
      const adminToken = ${JSON.stringify(adminToken ?? '')};
      const adminHeaders = adminToken ? { 'x-admin-secret': adminToken } : {};
      const adminUrl = (path) => adminToken
        ? path + (path.includes('?') ? '&' : '?') + 'adminToken=' + encodeURIComponent(adminToken)
        : path;
`;
```

**Backward compatibility:** When `adminToken` is an empty string (`''`):
- `adminHeaders` is `{}` (no header added)
- `adminUrl(path)` returns `path` unchanged
- `adminHiddenInput(undefined)` returns `''` (no field rendered)
- All fetch calls remain identical to the old unauthenticated form

**HTML pages and forms updated:**

| Page / Component | Change |
|---|---|
| `renderAppShell` | Accepts `adminToken`; injects `renderAdminScriptContext` into `<script>` |
| `renderLocationSelectionForm` | Accepts `adminToken`; form `action` uses `adminPath`; hidden `adminHiddenInput` added |
| `renderBulkShipmentReview` | Accepts `adminToken`; form `action` uses `adminPath`; hidden `adminHiddenInput` added |
| `renderBulkOdooReview` | Accepts `adminToken`; form `action` uses `adminPath`; hidden `adminHiddenInput` added |

**Fetch calls in `renderAppShell` JS fixed:**

| Call | Before | After |
|---|---|---|
| Load orders | `fetch('/api/orders')` | `fetch(adminUrl('/api/orders'), { headers: adminHeaders })` |
| Create shipment | `fetch('/api/orders/create-shipment', { headers: { 'Content-Type': ... } })` | `fetch(adminUrl('/api/orders/create-shipment'), { headers: { ...adminHeaders, 'Content-Type': ... } })` |
| Create Odoo SO | `fetch('/api/orders/create-odoo-sales-order', ...)` | `fetch(adminUrl('/api/orders/create-odoo-sales-order'), { headers: { ...adminHeaders, ... } })` |
| Load locations | `fetch('/api/accurate/locations')` | `fetch(adminUrl('/api/accurate/locations'), { headers: adminHeaders })` |

**Route handlers updated to extract and pass token:**

| Route | Token passed to |
|---|---|
| `GET /` | `renderAppShell(extractAdminToken(request))` |
| `GET /orders/make-telegraph/bulk` | `renderBulkShipmentReview({ ..., adminToken: extractAdminToken(request) })` |
| `POST /orders/make-telegraph/bulk` | `renderBulkShipmentReview({ ..., adminToken: extractAdminToken(request) })` |
| `GET /orders/make-telegraph` (location needed) | `renderLocationSelectionForm({ ..., adminToken: extractAdminToken(request) })` |
| `GET /orders/create-odoo-sales-order/bulk` | `renderBulkOdooReview({ ..., adminToken: extractAdminToken(request) })` |
| `POST /orders/create-odoo-sales-order/bulk` | `renderBulkOdooReview({ ..., adminToken: extractAdminToken(request) })` |

**Routes NOT changed (terminal result pages — no further form submission):**
- `POST /orders/make-telegraph/select` → renders `renderShipmentResult` (success/error only)
- `GET /orders/make-telegraph` (existing shipment) → renders `renderShipmentResult`
- `GET /orders/create-odoo-sales-order` → renders `renderShipmentResult`
- API JSON endpoints → return JSON, no UI token needed

### Admin Token Propagation Flow (full path)

```
Shopify Extension opens:
  GET /orders/make-telegraph?id=xxx&adminToken=<token>
      ↓ adminAuth validates token
      ↓ extractAdminToken(request) reads token
      ↓ renderLocationSelectionForm({ ..., adminToken: '<token>' })
  
  → Form action: POST /orders/make-telegraph/select?adminToken=<token>
      ↓ adminAuth validates token (from query)
      ↓ form body also has adminToken (from hidden input)
      ↓ shipment created, renders renderShipmentResult (done)

Shopify Extension opens:
  GET /orders/make-telegraph/bulk?selected=xxx&adminToken=<token>
      ↓ adminAuth validates token
      ↓ renderBulkShipmentReview({ ..., adminToken: '<token>' })
  
  → Form action: POST /orders/make-telegraph/bulk?adminToken=<token>
      ↓ adminAuth validates token (from query)
      ↓ form body also has adminToken (from hidden input)
      ↓ shipments created, renders result (done)

Admin shell at GET / loads:
  → JS: fetch(adminUrl('/api/orders'), { headers: adminHeaders })
      → if no token: fetch('/api/orders')                     [backward compat]
      → if token:    fetch('/api/orders?adminToken=<t>', { headers: { 'x-admin-secret': '<t>' } })
```

---

## Fix 2 — BUG-NEW-2: Payment Formula Edge Case

### Problem
The previous formula fell back to `residual` when `netMerchantDue <= 0`, causing the full invoice to be paid when `deliveryFees > collectedAmount`.

```typescript
// BEFORE (broken):
const amount = Math.min(residual, netMerchantDue > 0 ? netMerchantDue : residual);
// When netMerchantDue = 0: amount = residual → WRONG (pays full invoice)
```

### Fix
Extracted into an exported, testable function `calculateTelegraphMerchantPaymentAmount`:

```typescript
export const calculateTelegraphMerchantPaymentAmount = (params: {
  residual: number;
  collectedAmount?: number | null;
  deliveryFees?: number | null;
  customerDue?: number | null;
}): number => {
  const residual = Number(params.residual);
  if (!Number.isFinite(residual) || residual <= 0) return 0;

  // customerDue takes priority if positive (Telegraph's authoritative net amount)
  const customerDue = Number(params.customerDue);
  if (Number.isFinite(customerDue) && customerDue > 0) {
    return Math.min(residual, customerDue);
  }

  // Require both amounts to be present; null/undefined → return 0 (safe, no overpayment)
  if (params.collectedAmount === undefined || params.collectedAmount === null ||
      params.deliveryFees === undefined || params.deliveryFees === null) {
    return 0;
  }

  const collectedAmount = Number(params.collectedAmount);
  const deliveryFees = Number(params.deliveryFees);
  if (!Number.isFinite(collectedAmount) || collectedAmount <= 0 ||
      !Number.isFinite(deliveryFees) || deliveryFees < 0) {
    return 0;
  }

  const netMerchantDue = collectedAmount - deliveryFees;
  // BUG-NEW-2 FIX: when fees > collected, return 0 (not residual)
  return netMerchantDue > 0 ? Math.min(residual, netMerchantDue) : 0;
};
```

### Payment Formula Scenarios

| Scenario | collectedAmount | deliveryFees | residual | Expected | Result | Pass |
|---|---|---|---|---|---|---|
| Normal COD | 1270 | 71 | 1200 | 1199 | 1199 | ✅ |
| Fees exceed collected | 50 | 71 | 1200 | 0 | 0 | ✅ |
| Zero fees | 1200 | 0 | 1200 | 1200 | 1200 | ✅ |
| deliveryFees null | 1270 | null | 1200 | 0 (safe) | 0 | ✅ |
| collectedAmount null | null | 71 | 1200 | 0 (safe) | 0 | ✅ |
| Residual smaller than net | 1270 | 71 | 500 | 500 | 500 | ✅ |
| customerDue positive | 1270 | 71 | 1200 | 1199 | 1199 | ✅ |
| customerDue negative + null collected | null | 71 | 1200 | 0 | 0 | ✅ |

**Key safety principle:** When `collectedAmount` or `deliveryFees` is null, the function returns `0` — meaning the invoice is saved as `'invoice-posted-awaiting-payment'` rather than paying the full residual. This prevents any overpayment when data is missing.

**No delivery fee expense created.** No vendor bill for delivery fees. Telegraph retains fees from collected cash; only the net is registered in Odoo.

---

## Admin Token Propagation Paths Tested (Logic Trace)

| Path | Token mechanism | Protected by adminAuth | Status |
|---|---|---|---|
| Shopify extension opens `/orders/make-telegraph?adminToken=T` | query param read at page load | YES (app.use('/orders', adminAuth)) | ✅ |
| Location selection form POST | `action="...?adminToken=T"` + hidden input | YES | ✅ |
| Shell page `/` JS fetches `/api/orders` | `x-admin-secret` header + `?adminToken=T` | YES (app.use('/api', adminAuth)) | ✅ |
| Shell JS creates shipment POST | `x-admin-secret` header + `?adminToken=T` | YES | ✅ |
| Shell JS creates Odoo SO POST | `x-admin-secret` header + `?adminToken=T` | YES | ✅ |
| Shell JS loads locations | `x-admin-secret` header + `?adminToken=T` | YES | ✅ |
| Bulk shipment GET | query param read at page load | YES | ✅ |
| Bulk shipment POST form | `action="...?adminToken=T"` + hidden input | YES | ✅ |
| Bulk Odoo SO GET | query param read at page load | YES | ✅ |
| Bulk Odoo SO POST form | `action="...?adminToken=T"` + hidden input | YES | ✅ |
| Shopify webhook `/webhooks/shopify/orders-create` | NOT protected by adminAuth (uses HMAC) | NO — correct | ✅ |
| Accurate webhook `/webhooks/accurate/shipment-status` | NOT protected by adminAuth | NO — correct | ✅ |
| `/health` | NOT protected | NO — correct | ✅ |

**Token not set (backward compat):** `adminToken = ''` → `adminHeaders = {}` → no header sent → `adminAuth` middleware fires `if (!token) { next(); }` → request proceeds as before.

---

## Build and Test Results

| Command | Result |
|---|---|
| `npm run test:telegraph-scenarios` | ✅ PASS — 13 status, 5 return charge, 8 payment amount scenarios all passed |
| `npx prisma generate` | ✅ PASS |
| `npx tsc --noEmit` | ✅ PASS — exit code 0, 0 errors |
| `npm run build` | ✅ PASS — exit code 0 |

---

## Deploy Readiness Verdict

```
STATUS: ✅ READY TO DEPLOY
```

Both confirmed bugs are fixed:
- ✅ BUG-NEW-1: Admin UI works correctly when `ADMIN_SECRET_TOKEN` is set
- ✅ BUG-NEW-2: Payment formula returns 0 (not residual) when fees > collected

**Environment variables to set in Netlify before deploying:**

| Variable | Purpose | Required |
|---|---|---|
| `ADMIN_SECRET_TOKEN` | Protects `/orders/*` and `/api/*` admin routes | Strongly recommended |
| `ACCURATE_WEBHOOK_SECRET` | Protects `/webhooks/accurate/shipment-status` | Strongly recommended |
| `ODOO_RETURN_CHARGE_ACCOUNT_ID` | Odoo account for return-charge vendor bills | Required for returns |
| `SYNC_TIME_BUDGET_MS` | Time budget for sync function (default 20000) | Optional |

**How to use `ADMIN_SECRET_TOKEN` with Shopify App Extension:**

In `shopify.extension.toml`, append `?adminToken=<TOKEN>` to each target URL:
```toml
target = "admin.order-details.action.render"
url = "https://your-app.netlify.app/orders/make-telegraph?adminToken=YOUR_TOKEN_HERE"
```

Generate a secure token with: `openssl rand -hex 32`
