# Known Issues Before Next Deploy

Do not deploy each item separately. Batch these fixes and deploy once after local testing.

## Product and Odoo Readiness

- Complete Shopify SKU mapping against Odoo `product.product.default_code`.
- Recent orders with missing Shopify SKU include Magic Wallet, Mandela bag, Purse, and wallet bundles.
- Consider adding an admin readiness warning before creating a Telegraph shipment when Odoo product mapping is not ready.

## Odoo Customer and Address Matching

- Before creating an Odoo Sales Order, search existing customers by normalized mobile/phone and email.
- If an existing customer is found but the Shopify shipping address is different, do not overwrite the old main address blindly.
- Create or reuse a delivery address under the existing customer for the new Shopify address, then use it on the Sales Order.
- If the same phone exists on multiple Odoo customers, stop and flag for manual review instead of choosing randomly.
- Normalize Egyptian phone numbers before matching so `010...`, `+2010...`, and `2010...` match the same customer.
- Keep the Shopify order reference on the Sales Order so future searches by order number remain reliable.

## Deleted Telegraph Shipments

- Shopify Admin action can self-heal a deleted Telegraph shipment by checking Telegraph before treating the shipment as duplicate.
- The internal admin dashboard still disables the Make Telegraph shipment button when a local `shipmentCode` exists, even if the shipment was deleted on Telegraph.
- Add a force-recheck/recreate action or make the dashboard use the same self-heal path.
- Telegraph admin exposes actions such as `DeleteShipment`, `DeleteBulkShipments`, `CancelShipments`, and `DeleteLastShipmentAction`.
- Add self-heal for cancelled/deleted shipments and for reverted last action, not just hard 404 deletion.

## Shipment Reference Safety

- Before syncing any Telegraph shipment into Shopify or Odoo, verify that its reference belongs to Viola.
- The expected reference should start with the configured Viola prefix, for example `Viola-`.
- If a Telegraph shipment has another company reference, ignore it and do not sync it to Shopify or Odoo.
- This protects us if the same Telegraph account contains shipments for other stores or companies.

## Odoo Accounting Idempotency

- Split stored Odoo references instead of reusing `odooPaymentId` for multiple meanings:
  - `odooSalePaymentId`
  - `odooReturnBillId`
  - `odooReturnPaymentId`
- If Telegraph return charge changes later, create an adjustment for the delta or flag it for manual review.
- Add self-heal when Odoo Sales Order, Invoice, Bill, or Payment was manually cancelled/deleted after our DB stored the reference.
- Real Telegraph data shows return charges are not represented as negative `returnedValue`.
- Return charge detection should use Telegraph fields such as `customerDue`, `returningDueFees`, and/or `returnFees`.
- Extend `GET_SHIPMENT_QUERY` and the local DB snapshot to store `customerDue`, `deliveryFees`, `returnFees`, and `returningDueFees`.
- Do not treat Shopify shipping price as the accounting source of truth for shipping cost.
- Telegraph is the source of truth for collected amounts, delivery fees, return fees, and any shipping-company settlement impact.
- If Shopify total differs from Telegraph collected/settled values, flag the difference for reporting or manual review instead of forcing Shopify shipping into the Odoo Sales Order.
- If Telegraph marks an order as delivered but collected amount is zero or less than expected, do not auto-register customer payment and do not auto-create the Telegraph shipping bill.
- Mark the order as needing manual payment review in both Shopify and Odoo so accounting can find it from either system.
- In Shopify, add clear tags/metafields such as `payment-review` and `telegraph-delivered-not-collected`.
- In Odoo, mark the Sales Order/Invoice as needing manual payment review, preferably with a searchable field/filter or a clear note if no custom module is available.
- The exact keyword `payment-review` must be searchable in both Shopify and Odoo and return the same review-required orders.
- Accounting should confirm whether the customer paid directly through InstaPay, Vodafone Cash, cash, or did not pay.
- Only after accounting review should the system register the correct customer payment journal and create/pay the Telegraph shipping bill if applicable.

## Odoo Invoice Linkage

- Current direct invoice creation posts and pays the customer invoice, but may not link perfectly to the Sales Order invoice smart button.
- Later, prefer Odoo's sale invoice wizard if the business needs perfect Sales Order invoice linkage/reporting.

## Shopify Admin Bulk Actions

- Shopify order-details actions are prepared locally:
  - `Make Telegraph shipment`
  - `Make Odoo Sales Order`
- Shopify orders-list bulk actions are prepared locally:
  - `Make Telegraph shipments`
  - `Make Odoo Sales Orders`
- The bulk pages open a review screen first, then require confirmation before creating shipments or Odoo Sales Orders.
- Shopify CLI validated the local app configuration successfully, but these actions still need the next deploy/release before they appear in Shopify Admin.
- Before the next deploy, apply/verify the database migration for the new Telegraph status/accounting columns so runtime does not fail on missing columns.
- Until the next deploy, use the local dry-run script `npm.cmd run odoo:bulk-sales-orders -- --orders "#1816,#1817"` to check old orders safely before writing to Odoo.
- The bulk script must keep duplicate protection by searching Odoo `sale.order` using the Viola reference and Shopify order name before creating anything.

## Telegraph Status Semantics

- Confirm `DEX` / delivery exception semantics. It is currently mapped as cancelled and terminal.
- If `DEX` means a temporary delivery issue, remap it to a non-terminal exception state and keep polling.
- Real Telegraph history includes status codes not currently mapped cleanly: `BMT`, `RITS`, `HTR`.
- `HTR` means waiting for redelivery and should remain non-terminal.
- `DEX` appears as "لم يتم التسليم" with cancellation reasons such as customer asked to postpone or customer not answering; it should probably be a non-terminal delivery exception, not cancelled.
- `findOpenShipments` currently filters terminal statuses by English names, while stored `accurateStatus` is often Arabic. This can keep polling delivered/returned shipments forever.
- Store and filter by raw status code/return status code, or persist `isTerminal`.
