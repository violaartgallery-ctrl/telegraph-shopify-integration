# VIOLA — Net-Due Invoice Backfill PREVIEW (Phase 1, read-only)

Generated: 2026-05-17T10:33:35.499Z

## Summary

- DB candidates (collected + invoice + payment + status=paid): **91**
- Candidates inspected (invoice exists, posted, not fully paid, has financials): **73**
- **SAFE_AUTO_FIX:** 72
- **NEEDS_MANUAL_REVIEW:** 1
- Skipped:
  - no invoice found in Odoo: 0
  - already fully paid: 18
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

## SAFE_AUTO_FIX (72)

| Order | Invoice | Invoice Total | Net Merchant Due | Residual | Lines | Tax | Credit Note | Reasons / Action |
|---|---|---:|---:|---:|---:|---|---|---|
| #1788 | INV/2026/03820 | 2500.00 | 2424.00 | 76.00 | 2 | no | no | reset draft → set total = 2424 (was 2500.00) → post → reconcile existing payment |
| #1830 | INV/2026/03839 | 1400.00 | 1394.00 | 6.00 | 1 | no | no | reset draft → set total = 1394 (was 1400.00) → post → reconcile existing payment |
| #1853 | INV/2026/03799 | 600.00 | 599.00 | 1.00 | 1 | no | no | reset draft → set total = 599 (was 600.00) → post → reconcile existing payment |
| #1833 | INV/2026/03841 | 2080.00 | 1579.00 | 501.00 | 2 | no | no | reset draft → set total = 1579 (was 2080.00) → post → reconcile existing payment |
| #1858 | INV/2026/03801 | 999.00 | 998.00 | 1.00 | 1 | no | no | reset draft → set total = 998 (was 999.00) → post → reconcile existing payment |
| #1927 | INV/2026/03870 | 960.00 | 959.00 | 1.00 | 1 | no | no | reset draft → set total = 959 (was 960.00) → post → reconcile existing payment |
| #1844 | INV/2026/03802 | 999.00 | 993.00 | 6.00 | 1 | no | no | reset draft → set total = 993 (was 999.00) → post → reconcile existing payment |
| #1864 | INV/2026/03803 | 999.00 | 998.00 | 1.00 | 1 | no | no | reset draft → set total = 998 (was 999.00) → post → reconcile existing payment |
| #1919 | INV/2026/03838 | 999.00 | 993.00 | 6.00 | 1 | no | no | reset draft → set total = 993 (was 999.00) → post → reconcile existing payment |
| #1847 | INV/2026/03866 | 1120.00 | 1119.00 | 1.00 | 1 | no | no | reset draft → set total = 1119 (was 1120.00) → post → reconcile existing payment |
| #1868 | INV/2026/03804 | 1200.00 | 1194.00 | 6.00 | 1 | no | no | reset draft → set total = 1194 (was 1200.00) → post → reconcile existing payment |
| #1817 | INV/2026/03828 | 1400.00 | 1399.00 | 1.00 | 1 | no | no | reset draft → set total = 1399 (was 1400.00) → post → reconcile existing payment |
| #1859 | INV/2026/03863 | 960.00 | 954.00 | 6.00 | 1 | no | no | reset draft → set total = 954 (was 960.00) → post → reconcile existing payment |
| #1854 | INV/2026/03800 | 1400.00 | 1399.00 | 1.00 | 1 | no | no | reset draft → set total = 1399 (was 1400.00) → post → reconcile existing payment |
| #1766 | INV/2026/03796 | 2600.00 | 1379.00 | 1221.00 | 2 | no | no | reset draft → set total = 1379 (was 2600.00) → post → reconcile existing payment |
| #1862 | INV/2026/03805 | 600.00 | 599.00 | 1.00 | 1 | no | no | reset draft → set total = 599 (was 600.00) → post → reconcile existing payment |
| #1791 | INV/2026/03843 | 600.00 | 599.00 | 1.00 | 1 | no | no | reset draft → set total = 599 (was 600.00) → post → reconcile existing payment |
| #1869 | INV/2026/03806 | 1120.00 | 1114.00 | 6.00 | 1 | no | no | reset draft → set total = 1114 (was 1120.00) → post → reconcile existing payment |
| #1823 | INV/2026/03856 | 2400.00 | 1919.00 | 481.00 | 2 | no | no | reset draft → set total = 1919 (was 2400.00) → post → reconcile existing payment |
| #1806 | INV/2026/03852 | 1400.00 | 1114.00 | 286.00 | 1 | no | no | reset draft → set total = 1114 (was 1400.00) → post → reconcile existing payment |
| #1825 | INV/2026/03832 | 960.00 | 959.00 | 1.00 | 1 | no | no | reset draft → set total = 959 (was 960.00) → post → reconcile existing payment |
| #1850 | INV/2026/03809 | 600.00 | 599.00 | 1.00 | 1 | no | no | reset draft → set total = 599 (was 600.00) → post → reconcile existing payment |
| #1782 | INV/2026/03846 | 1400.00 | 1399.00 | 1.00 | 1 | no | no | reset draft → set total = 1399 (was 1400.00) → post → reconcile existing payment |
| #1799 | INV/2026/03844 | 999.00 | 993.00 | 6.00 | 1 | no | no | reset draft → set total = 993 (was 999.00) → post → reconcile existing payment |
| #1804 | INV/2026/03848 | 1400.00 | 1114.00 | 286.00 | 1 | no | no | reset draft → set total = 1114 (was 1400.00) → post → reconcile existing payment |
| #1865 | INV/2026/03810 | 600.00 | 599.00 | 1.00 | 1 | no | no | reset draft → set total = 599 (was 600.00) → post → reconcile existing payment |
| #1909 | INV/2026/03867 | 1400.00 | 1119.00 | 281.00 | 1 | no | no | reset draft → set total = 1119 (was 1400.00) → post → reconcile existing payment |
| #1835 | INV/2026/03831 | 999.00 | 993.00 | 6.00 | 1 | no | no | reset draft → set total = 993 (was 999.00) → post → reconcile existing payment |
| #1870 | INV/2026/03807 | 1120.00 | 1119.00 | 1.00 | 1 | no | no | reset draft → set total = 1119 (was 1120.00) → post → reconcile existing payment |
| #1827 | INV/2026/03834 | 1120.00 | 1114.00 | 6.00 | 1 | no | no | reset draft → set total = 1114 (was 1120.00) → post → reconcile existing payment |
| #1867 | INV/2026/03811 | 650.00 | 644.00 | 6.00 | 1 | no | no | reset draft → set total = 644 (was 650.00) → post → reconcile existing payment |
| #1842 | INV/2026/03797 | 960.00 | 954.00 | 6.00 | 1 | no | no | reset draft → set total = 954 (was 960.00) → post → reconcile existing payment |
| #1930 | INV/2026/03869 | 1699.00 | 1628.00 | 71.00 | 2 | no | no | reset draft → set total = 1628 (was 1699.00) → post → reconcile existing payment |
| #1774 | INV/2026/03858 | 960.00 | 954.00 | 6.00 | 1 | no | no | reset draft → set total = 954 (was 960.00) → post → reconcile existing payment |
| #1878 | INV/2026/03814 | 999.00 | 993.00 | 6.00 | 1 | no | no | reset draft → set total = 993 (was 999.00) → post → reconcile existing payment |
| #1881 | INV/2026/03815 | 960.00 | 954.00 | 6.00 | 1 | no | no | reset draft → set total = 954 (was 960.00) → post → reconcile existing payment |
| #1873 | INV/2026/03813 | 1120.00 | 1119.00 | 1.00 | 1 | no | no | reset draft → set total = 1119 (was 1120.00) → post → reconcile existing payment |
| #1890 | INV/2026/03816 | 960.00 | 959.00 | 1.00 | 1 | no | no | reset draft → set total = 959 (was 960.00) → post → reconcile existing payment |
| #1924 | INV/2026/03871 | 1120.00 | 1119.00 | 1.00 | 1 | no | no | reset draft → set total = 1119 (was 1120.00) → post → reconcile existing payment |
| #1790 | INV/2026/03821 | 1120.00 | 1114.00 | 6.00 | 1 | no | no | reset draft → set total = 1114 (was 1120.00) → post → reconcile existing payment |
| #1843 | INV/2026/03798 | 1998.00 | 1922.00 | 76.00 | 2 | no | no | reset draft → set total = 1922 (was 1998.00) → post → reconcile existing payment |
| #1836 | INV/2026/03862 | 2800.00 | 2724.00 | 76.00 | 2 | no | no | reset draft → set total = 2724 (was 2800.00) → post → reconcile existing payment |
| #1769 | INV/2026/03818 | 960.00 | 954.00 | 6.00 | 1 | no | no | reset draft → set total = 954 (was 960.00) → post → reconcile existing payment |
| #1780 | INV/2026/03819 | 2080.00 | 2074.00 | 6.00 | 2 | no | no | reset draft → set total = 2074 (was 2080.00) → post → reconcile existing payment |
| #1815 | INV/2026/03845 | 1200.00 | 1129.00 | 71.00 | 1 | no | no | reset draft → set total = 1129 (was 1200.00) → post → reconcile existing payment |
| #1846 | INV/2026/03808 | 999.00 | 998.00 | 1.00 | 1 | no | no | reset draft → set total = 998 (was 999.00) → post → reconcile existing payment |
| #1783 | INV/2026/03822 | 960.00 | 959.00 | 1.00 | 1 | no | no | reset draft → set total = 959 (was 960.00) → post → reconcile existing payment |
| #1910 | INV/2026/03837 | 1120.00 | 1114.00 | 6.00 | 1 | no | no | reset draft → set total = 1114 (was 1120.00) → post → reconcile existing payment |
| #1800 | INV/2026/03823 | 999.00 | 993.00 | 6.00 | 1 | no | no | reset draft → set total = 993 (was 999.00) → post → reconcile existing payment |
| #1807 | INV/2026/03854 | 1400.00 | 1399.00 | 1.00 | 1 | no | no | reset draft → set total = 1399 (was 1400.00) → post → reconcile existing payment |
| #1795 | INV/2026/03824 | 999.00 | 993.00 | 6.00 | 1 | no | no | reset draft → set total = 993 (was 999.00) → post → reconcile existing payment |
| #1855 | INV/2026/03864 | 960.00 | 954.00 | 6.00 | 1 | no | no | reset draft → set total = 954 (was 960.00) → post → reconcile existing payment |
| #1812 | INV/2026/03826 | 1120.00 | 1114.00 | 6.00 | 1 | no | no | reset draft → set total = 1114 (was 1120.00) → post → reconcile existing payment |
| #1803 | INV/2026/03825 | 960.00 | 959.00 | 1.00 | 1 | no | no | reset draft → set total = 959 (was 960.00) → post → reconcile existing payment |
| #1792 | INV/2026/03847 | 4200.00 | 2449.00 | 1751.00 | 3 | no | no | reset draft → set total = 2449 (was 4200.00) → post → reconcile existing payment |
| #1818 | INV/2026/03829 | 600.00 | 599.00 | 1.00 | 1 | no | no | reset draft → set total = 599 (was 600.00) → post → reconcile existing payment |
| #1821 | INV/2026/03830 | 999.00 | 993.00 | 6.00 | 1 | no | no | reset draft → set total = 993 (was 999.00) → post → reconcile existing payment |
| #1808 | INV/2026/03849 | 1200.00 | 1194.00 | 6.00 | 1 | no | no | reset draft → set total = 1194 (was 1200.00) → post → reconcile existing payment |
| #1805 | INV/2026/03851 | 700.00 | 559.00 | 141.00 | 1 | no | no | reset draft → set total = 559 (was 700.00) → post → reconcile existing payment |
| #1802 | INV/2026/03850 | 1400.00 | 1394.00 | 6.00 | 1 | no | no | reset draft → set total = 1394 (was 1400.00) → post → reconcile existing payment |
| #1826 | INV/2026/03833 | 960.00 | 959.00 | 1.00 | 1 | no | no | reset draft → set total = 959 (was 960.00) → post → reconcile existing payment |
| #1837 | INV/2026/03855 | 600.00 | 599.00 | 1.00 | 1 | no | no | reset draft → set total = 599 (was 600.00) → post → reconcile existing payment |
| #1906 | INV/2026/03835 | 999.00 | 993.00 | 6.00 | 1 | no | no | reset draft → set total = 993 (was 999.00) → post → reconcile existing payment |
| #1913 | INV/2026/03836 | 1998.00 | 1927.00 | 71.00 | 2 | no | no | reset draft → set total = 1927 (was 1998.00) → post → reconcile existing payment |
| #1763 | INV/2026/03853 | 750.00 | 744.00 | 6.00 | 1 | no | no | reset draft → set total = 744 (was 750.00) → post → reconcile existing payment |
| #1828 | INV/2026/03840 | 960.00 | 954.00 | 6.00 | 1 | no | no | reset draft → set total = 954 (was 960.00) → post → reconcile existing payment |
| #1891 | INV/2026/03859 | 999.00 | 998.00 | 1.00 | 1 | no | no | reset draft → set total = 998 (was 999.00) → post → reconcile existing payment |
| #1852 | INV/2026/03865 | 1120.00 | 1119.00 | 1.00 | 1 | no | no | reset draft → set total = 1119 (was 1120.00) → post → reconcile existing payment |
| #1911 | INV/2026/03868 | 1200.00 | 959.00 | 241.00 | 1 | no | no | reset draft → set total = 959 (was 1200.00) → post → reconcile existing payment |
| #1921 | INV/2026/03861 | 1120.00 | 1114.00 | 6.00 | 1 | no | no | reset draft → set total = 1114 (was 1120.00) → post → reconcile existing payment |
| #1874 | INV/2026/03857 | 1400.00 | 1114.00 | 286.00 | 1 | no | no | reset draft → set total = 1114 (was 1400.00) → post → reconcile existing payment |
| #1944 | INV/2026/03872 | 960.00 | 959.00 | 1.00 | 1 | no | no | reset draft → set total = 959 (was 960.00) → post → reconcile existing payment |

## NEEDS_MANUAL_REVIEW (1)

| Order | Invoice | Invoice Total | Net Merchant Due | Residual | Lines | Tax | Credit Note | Reasons / Action |
|---|---|---:|---:|---:|---:|---|---|---|
| #1877 | INV/2026/03812 | 3600.00 | 1524.00 | 2076.00 | 4 | no | no | many-lines (4) |

## Next step

No writes performed. Awaiting explicit approval before Phase 2.
Phase 2 (if approved) will, for SAFE_AUTO_FIX only:
1. reset the invoice to draft (button_draft)
2. adjust line(s) so invoice total equals netMerchantDue
3. post the invoice (action_post)
4. confirm reconciliation with existing payment
5. verify amount_residual == 0 and payment_state == paid

Each fixed invoice will be verified individually; any failure aborts and is reported.