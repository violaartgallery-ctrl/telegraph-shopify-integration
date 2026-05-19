# VIOLA — Remaining V7 Orphans Audit

**Generated:** 2026-05-17T14:23:09.461Z

## Summary

| Group | Count |
|---|---:|
| Inspected (after DB filter) | 49 |
| ✅ SAFE_RECOVERY | 8 |
| ⚠️ MANUAL_REVIEW | 41 |

## Filter applied

```
DB filter:
  odooSyncStatus = sales-order-created
  accurateShipmentId NOT NULL
  accurateShipmentCode NOT NULL
  odooSaleOrderId NOT NULL
  odooInvoiceId IS NULL
  odooPaymentId IS NULL
  odooSalePaymentId IS NULL

Hard exclusions:
  - already-recovered 10 orders
  - explicit exclude: #1880, #1920, #1942
  - collectionStatus in (collected, returned, returned-settled, payment-review)
  - accurateIsTerminal=true
  - customerDue < 0

SAFE_RECOVERY also requires (verified live in Odoo):
  - sale.order state = "sale"
  - no invoices on the SO
  - partner + lines present
  - at least one MO/picking still incomplete (work left for the queue)
```

## SAFE_RECOVERY (8)

| Order | Telegraph | SO | State | MO done | Internal done | Customer done | Age (h) | Notes |
|---|---|---|---|---|---|---|---:|---|
| #1955 | VI0000394 | S14584 | sale | 1/1 | 0/1 | 0/1 | 72.5 | _queue will run stages 2→3_ |
| #1966 | VI0000393 | S14583 | sale | 1/2 | 0/1 | 0/1 | 72.5 | _queue will run stages 2→3_ |
| #1952 | VI0000388 | S14578 | sale | 1/1 | 0/1 | 0/1 | 72.6 | _queue will run stages 2→3_ |
| #1897 | VI0000371 | S14562 | sale | 2/2 | 1/1 | 0/1 | 96.7 | _queue will run stages 2→3_ |
| #1933 | VI0000364 | S14555 | sale | 0/1 | 0/1 | 0/1 | 98.6 | _queue will run stages 2→3_ |
| #1912 | VI0000348 | S14536 | sale | 1/1 | 0/1 | 0/1 | 124.9 | _queue will run stages 2→3_ |
| #1905 | VI0000338 | S14526 | sale | 2/2 | 0/1 | 0/1 | 125 | _queue will run stages 2→3_ |
| #1841 | VI0000289 | S14312 | sale | 1/1 | 0/1 | 0/1 | 173.1 | _queue will run stages 2→3_ |

## MANUAL_REVIEW (41)

| Order | Telegraph | SO | State | MO done | Internal done | Customer done | Age (h) | Notes |
|---|---|---|---|---|---|---|---:|---|
| #1938 | VI0000379 | S14570 | sale | 1/1 | 1/1 | 1/1 | 95.7 | nothing-to-do |
| #1942 | VI0000378 | S14569 | - | 0/0 | 0/0 | 0/0 | 95.8 | explicit-exclude; telegraph-terminal |
| #1945 | VI0000374 | S14565 | sale | 2/2 | 1/1 | 1/1 | 96 | nothing-to-do |
| #1920 | VI0000372 | S14563 | - | 0/0 | 0/0 | 0/0 | 96.5 | explicit-exclude; telegraph-terminal |
| #1943 | VI0000370 | S14561 | sale | 0/0 | 1/1 | 1/1 | 96.7 | nothing-to-do |
| #1940 | VI0000369 | S14560 | sale | 2/2 | 1/1 | 1/1 | 98.5 | nothing-to-do |
| #1917 | VI0000365 | S14556 | sale | 2/2 | 1/1 | 1/1 | 98.6 | nothing-to-do |
| #1937 | VI0000367 | S14558 | sale | 1/1 | 1/1 | 1/1 | 98.6 | nothing-to-do |
| #1935 | VI0000363 | S14554 | sale | 2/2 | 1/1 | 1/1 | 98.7 | nothing-to-do |
| #1936 | VI0000362 | S14553 | sale | 2/2 | 1/1 | 1/1 | 98.7 | nothing-to-do |
| #1903 | VI0000360 | S14551 | sale | 0/0 | 1/1 | 1/1 | 98.8 | nothing-to-do |
| #1931 | VI0000359 | S14550 | sale | 1/1 | 1/1 | 1/1 | 98.8 | nothing-to-do |
| #1918 | VI0000358 | S14549 | sale | 1/1 | 1/1 | 1/1 | 98.8 | nothing-to-do |
| #1922 | VI0000355 | S14543 | sale | 0/0 | 1/1 | 1/1 | 124.7 | nothing-to-do |
| #1916 | VI0000351 | S14539 | sale | 2/2 | 1/1 | 1/1 | 124.8 | nothing-to-do |
| #1925 | VI0000350 | S14538 | - | 0/0 | 0/0 | 0/0 | 124.8 | collectionStatus=returned; telegraph-terminal |
| #1896 | VI0000341 | S14529 | sale | 1/1 | 1/1 | 1/1 | 124.9 | nothing-to-do |
| #1907 | VI0000345 | S14533 | - | 0/0 | 0/0 | 0/0 | 124.9 | collectionStatus=returned; telegraph-terminal |
| #1902 | VI0000337 | S14405 | - | 0/0 | 0/0 | 0/0 | 148.2 | collectionStatus=returned; telegraph-terminal |
| #1900 | VI0000335 | S14403 | sale | 1/1 | 1/1 | 1/1 | 148.2 | has-invoice-in-odoo |
| #1892 | VI0000334 | S14402 | sale | 3/3 | 1/1 | 1/1 | 148.2 | has-invoice-in-odoo |
| #1893 | VI0000333 | S14398 | sale | 1/1 | 1/1 | 1/1 | 148.3 | has-invoice-in-odoo |
| #1888 | VI0000329 | S14394 | sale | 0/0 | 1/1 | 1/1 | 148.4 | has-invoice-in-odoo |
| #1887 | VI0000328 | S14393 | sale | 1/1 | 1/1 | 1/1 | 148.4 | has-invoice-in-odoo |
| #1882 | VI0000327 | S14392 | sale | 5/5 | 1/1 | 1/1 | 148.5 | has-invoice-in-odoo |
| #1879 | VI0000325 | S14390 | sale | 0/0 | 1/1 | 1/1 | 148.5 | has-invoice-in-odoo |
| #1880 | VI0000326 | S14391 | - | 0/0 | 0/0 | 0/0 | 148.5 | explicit-exclude; collectionStatus=payment-review; telegraph-terminal; negative-customerDue |
| #1883 | VI0000323 | S14388 | - | 0/0 | 0/0 | 0/0 | 148.6 | collectionStatus=returned; telegraph-terminal |
| #1875 | VI0000317 | S14340 | sale | 1/1 | 1/1 | 1/1 | 171.8 | nothing-to-do |
| #1876 | VI0000319 | S14342 | - | 0/0 | 0/0 | 0/0 | 171.8 | collectionStatus=returned; telegraph-terminal |
| #1848 | VI0000310 | S14333 | - | 0/0 | 0/0 | 0/0 | 171.9 | negative-customerDue |
| #1872 | VI0000311 | S14334 | sale | 1/1 | 1/1 | 1/1 | 171.9 | nothing-to-do |
| #1860 | VI0000300 | S14323 | sale | 1/1 | 1/1 | 1/1 | 172 | nothing-to-do |
| #1851 | VI0000291 | S14314 | sale | 1/1 | 1/1 | 1/1 | 172.9 | nothing-to-do |
| #1829 | VI0000282 | S14305 | sale | 1/1 | 1/1 | 1/1 | 174.5 | nothing-to-do |
| #1784 | VI0000279 | S14302 | sale | 0/0 | 1/1 | 1/1 | 174.5 | nothing-to-do |
| #1786 | VI0000258 | S14281 | - | 0/0 | 0/0 | 0/0 | 175.6 | collectionStatus=returned; telegraph-terminal |
| #1810 | VI0000260 | S14283 | - | 0/0 | 0/0 | 0/0 | 195.7 | collectionStatus=returned; telegraph-terminal |
| #1801 | VI0000295 | S14318 | sale | 1/1 | 1/1 | 1/1 | 195.8 | nothing-to-do |
| #1789 | VI0000222 | S14515 | - | 0/0 | 0/0 | 0/0 | 265.6 | collectionStatus=returned-settled; telegraph-terminal |
| #1765 | VI0000212 | S14504 | sale | 1/1 | 1/1 | 1/1 | 265.7 | has-invoice-in-odoo |

## Proposed action for SAFE_RECOVERY

```
UPDATE shipment_records
SET odooSyncStatus = "odoo-stock-pending",
    odooLastError = NULL,
    odooRetryAt = NULL,
    odooAttemptCount = 0,
    odooSyncedAt = NOW()
WHERE id = <recordId>
  AND odooSyncStatus = "sales-order-created"
  AND accurateShipmentId IS NOT NULL
  AND odooSaleOrderId IS NOT NULL
  AND odooInvoiceId IS NULL
  AND odooPaymentId IS NULL
  AND odooSalePaymentId IS NULL;
```

No writes to Odoo, Shopify, or Telegraph.
The V7 queue picks them up on the next `process-odoo-queue` tick (every minute).