# Accountant desk (owner request, 25 Nov 2026)

Goal: the accountant spends about 10 minutes a day in the bot's own Shopify admin page.
The bot does the clear cases by itself; the page shows only the exceptions, grouped by category.
No assistant in the middle.

## What this branch adds

| Part | File | Switch |
|---|---|---|
| Accountant desk (bars, category icons, rule table) on top of the existing review list | `src/ui/accountantDeskUi.ts`, `src/routes/adminAppRoute.ts` | always on (display only) |
| Category per review case | `src/services/accountantCategories.ts`, `operationsDashboardService.ts` | display only |
| Review list filters by the clicked category | `src/ui/operationsReviewUi.ts` | display only |
| Money-only accounting source (rule 12): notes, tags, names, address, customization no longer block the Odoo SO stage or an accountant "accept" | `odooShipmentBinding.ts`, `process-odoo-queue-background.ts`, `operationsDecisionService.ts` | `OPS_ACCOUNTING_MONEY_ONLY_SOURCE=true` |
| Re-arm of zero-effect return reviews (rule 6) and note-only production reviews (rule 12) | `reviewRearmExtra.ts`, `reviewRearmExtraRuntime.ts`, `opsScheduler.ts` | `OPS_ACCOUNTANT_RULES_ENABLED=true` |
| Carrier re-arm (PR #51) batch 5 → 15 per financial cycle | `carrierReviewRearm.ts`, `opsScheduler.ts` | `OPS_CARRIER_REVIEW_REARM_ENABLED=true` |

Decisions still go through the existing signed flow (`/api/operations/review/prepare|decide`):
fresh Telegraph + Shopify + Odoo facts, order lock, CAS, durable `ops_owner_decision_v1` receipt,
then the native lanes execute. Nothing here creates an invoice, payment, SO, waybill or stock move by itself.

## Safety kept

- Re-arm only when the lane's own claim stopped **before any external request** with the exact review text.
- Holds, completion receipts, unfinished/uncertain claims, cancelled/test/prepaid orders, existing invoices or a linked SO all keep the row in review.
- Money binding still covers products (variant/SKU), quantities, prices, discounts, shipping, tax, currency, financial status and cancellation. A colour change still stops.
- Strict shipping / Preview-Run bindings are unchanged.

## Not in this branch (next)

Rules 3 (auto discount ≤ 150), 5 (overpay), 7 (return with shipping fee, no income), 8 (partial-delivery matching), 13 (same-price product swap).
Until then the accountant decides these from the desk with the existing options (discount / extra / returned).

## Release notes

Build from the live source (`dpl_4T4nm`, manifest `595d360e`) + this diff, include PR #52 schema lines, no migration needed.
Turn the three switches on in the bot project only after the owner approves, between Previews, with the usual drain/fence/parity protocol.
