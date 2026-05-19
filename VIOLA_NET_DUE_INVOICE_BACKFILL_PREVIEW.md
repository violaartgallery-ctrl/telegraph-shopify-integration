# VIOLA — Net-Due Invoice Backfill PREVIEW (Phase 1, read-only)

Generated: 2026-05-17T15:56:25.150Z

## Summary

- DB candidates (collected + invoice + payment + status=paid): **96**
- Candidates inspected (invoice exists, posted, not fully paid, has financials): **0**
- **SAFE_AUTO_FIX:** 0
- **NEEDS_MANUAL_REVIEW:** 0
- Skipped:
  - no invoice found in Odoo: 0
  - already fully paid: 96
  - not posted (draft/cancel): 0
  - missing collectedAmount/deliveryFees: 0

## Rule applied

netMerchantDue = collectedAmount - deliveryFees

SAFE_AUTO_FIX requires ALL of:
- collected + paid + invoice posted + not fully paid
- invoice total > netMerchantDue
- residual ≈ invoice total - netMerchantDue (tolerance 0.02)
- lines count between 1 and 3
- no taxes on lines
- no credit-note (out_refund) reversing the invoice

## SAFE_AUTO_FIX (0)

_None_

## NEEDS_MANUAL_REVIEW (0)

_None_

## Next step

No writes performed. Awaiting explicit approval before Phase 2.
Phase 2 (if approved) will, for SAFE_AUTO_FIX only:
1. reset the invoice to draft (button_draft)
2. adjust line(s) so invoice total equals netMerchantDue
3. post the invoice (action_post)
4. confirm reconciliation with existing payment
5. verify amount_residual == 0 and payment_state == paid

Each fixed invoice will be verified individually; any failure aborts and is reported.