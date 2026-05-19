# VIOLA — Deep Analysis Report

Generated: 2026-05-19T12:56:20.744Z

## Queue snapshot

- `delivery-confirmed`: 136
- `paid`: 134
- `sales-order-created`: 92
- `paid-existing`: 10
- `failed`: 1
- `odoo-stock-pending`: 1

## Stuck at sales-order-created (V7 orphans)

Total: 1 (0 recent < 24h)

Recent table:

| Order | Telegraph | SO | Accurate | Collection | Age (h) |
|---|---|---|---|---|---:|

## Failed orders

| Order | Telegraph | SO | Attempts | Error |
|---|---|---|---:|---|
| #2104 | VI0000532 | - | 0 | fetch failed |

## Partial invoices (net-due fix gap)

Total partial: 10

| Order | Invoice | Total | Net Due | Residual | Tax | Last Sync |
|---|---|---:|---:|---:|---|---|
| #2021 | INV/2026/03943 | 850.00 | 844.00 | 6.00 | N | 2026-05-19T12:45 |
| #1949 | INV/2026/03942 | 1120.00 | 1119.00 | 1.00 | N | 2026-05-19T12:06 |
| #1872 | INV/2026/03940 | 960.00 | 959.00 | 1.00 | N | 2026-05-19T11:48 |
| #1936 | INV/2026/03941 | 600.00 | 599.00 | 1.00 | N | 2026-05-19T11:48 |
| #1840 | INV/2026/03936 | 999.00 | 998.00 | 1.00 | N | 2026-05-19T11:32 |
| #1977 | INV/2026/03937 | 1998.00 | 1927.00 | 71.00 | N | 2026-05-19T11:32 |
| #1892 | INV/2026/03938 | 1200.00 | 1124.00 | 76.00 | N | 2026-05-19T11:32 |
| #2008 | INV/2026/03934 | 1120.00 | 1114.00 | 6.00 | N | 2026-05-19T11:17 |
| #1984 | INV/2026/03935 | 1450.00 | 1374.00 | 76.00 | N | 2026-05-19T11:17 |
| #1967 | INV/2026/03921 | 1100.00 | 1024.00 | 76.00 | N | 2026-05-19T09:02 |

## Root cause: timing of invoice posting

`findOrCreatePostedSaleInvoice` calls `createSaleInvoiceFromWizard`, which calls the Odoo wizard `sale.advance.payment.inv.create_invoices`. In Odoo 17 this wizard creates the invoice and *immediately posts it*. By the time `findOrCreatePostedSaleInvoice` reads the invoice back, `state` is `posted`, so the existing guard `if (invoice.state === "draft")` falls through and the line adjustment never runs. Payment registration then leaves a residual equal to `deliveryFees`, producing the Partially Paid state.

## Proposed plan

1. Code fix in `findOrCreatePostedSaleInvoice` / `createSaleInvoiceFromWizard`:
   - After the wizard returns, if invoice is already posted and `targetInvoiceTotal` is provided, reset it to draft via `button_draft`, then `adjustDraftInvoiceLinesToTotal`, then `action_post`.
   - If reset fails (linked payments, locked period, etc.), fall back to the current safe behaviour (warn + leave for manual review).
2. DB recovery for the 8 stuck `sales-order-created` orders and #2104 `failed`.
3. Backfill the partial invoices above using the same reset-to-draft → adjust → post path.