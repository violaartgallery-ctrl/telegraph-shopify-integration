/**
 * READ-ONLY preview for the legacy shipping-company reconciliation.
 *
 * Input: _legacy_unique.json (rows from the 10 payment_entries xlsx files).
 * For every row with an extractable Shopify order number (1000-2000):
 *   - look up the Shopify order by name
 *   - verify the customer name matches
 *   - read current financial/fulfillment/cancel state
 *   - decide the would-be action (pay / cancel / skip / review)
 *
 * Outputs _legacy_preview.csv + console summary. NO writes anywhere.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { shopifyOrdersClient } from '../shopify/shopifyOrdersClient.js';

interface ExtObj { n: number | null; ambiguous?: boolean; outOfRange?: number; raw?: string }
interface Row {
  file: string; sender: string; name: string; amount: number; date: string; status: string;
  ext: number | ExtObj;
}

const rows: Row[] = JSON.parse(readFileSync('_legacy_unique.json', 'utf8'));

const orderNum = (ext: Row['ext']): number | null => {
  if (typeof ext === 'number') return ext;
  if (ext && typeof ext === 'object' && ext.ambiguous && ext.n) return ext.n;
  return null;
};

const ARABIC_DIACRITICS = /[ً-ْٰ]/g;
const normalize = (s: string): string =>
  String(s)
    .replace(/\d+\s*$/, '')
    .replace(ARABIC_DIACRITICS, '')
    .replace(/[إأآا]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .toLowerCase()
    .replace(/[^a-z0-9؀-ۿ]+/g, ' ')
    .trim();

const nameMatches = (excelName: string, shopName: string): boolean => {
  const a = normalize(excelName);
  const b = normalize(shopName);
  if (!a || !b) return false;
  if (a === b || a.includes(b) || b.includes(a)) return true;
  const ta = new Set(a.split(' ').filter((t) => t.length > 1));
  const tb = new Set(b.split(' ').filter((t) => t.length > 1));
  let shared = 0;
  for (const t of ta) if (tb.has(t)) shared++;
  const minTokens = Math.min(ta.size, tb.size);
  return shared > 0 && shared >= Math.min(2, minTokens);
};

const isDelivered = (status: string): boolean => status.includes('تم التسليم');
const isReturned = (status: string): boolean => /ارجاع|ارتجاع/.test(status);

interface Result extends Row {
  orderNum: number | null;
  shopifyName?: string;
  shopifyCustomer?: string;
  shopifyFinancial?: string | null;
  shopifyCancelled?: boolean;
  shopifyTotal?: number;
  nameMatch?: boolean;
  decision: string;
  detail: string;
}

const results: Result[] = [];
const withNum = rows.map((r) => ({ r, n: orderNum(r.ext) })).filter((x) => x.n != null) as { r: Row; n: number }[];
const noNum = rows.filter((r) => orderNum(r.ext) == null);

console.log('Rows with order number: ' + withNum.length);
console.log('Rows WITHOUT number (skip, strict): ' + noNum.length);

const fetched = new Map<number, { name: string; customer: string; financial: string | null; cancelled: boolean; total: number }>();
const uniqueNums = [...new Set(withNum.map((x) => x.n))];
console.log('Unique order numbers to look up: ' + uniqueNums.length);

const CHUNK = 20;
for (let i = 0; i < uniqueNums.length; i += CHUNK) {
  const chunk = uniqueNums.slice(i, i + CHUNK);
  const query = chunk.map((n) => 'name:' + n).join(' OR ');
  try {
    const orders = await shopifyOrdersClient.listRecentOrders(60, query);
    for (const o of orders) {
      const num = Number.parseInt(String(o.name).replace(/\D/g, ''), 10);
      if (!Number.isFinite(num)) continue;
      const cust = o.shipping_address?.name || o.billing_address?.name ||
        [o.customer?.first_name, o.customer?.last_name].filter(Boolean).join(' ') || o.email || '';
      fetched.set(num, {
        name: o.name,
        customer: cust,
        financial: o.financial_status ?? null,
        cancelled: Boolean((o as { cancelled_at?: string }).cancelled_at),
        total: Number(o.total_price ?? 0)
      });
    }
  } catch (e) {
    console.log('  lookup chunk ' + i + ' error: ' + (e instanceof Error ? e.message : String(e)));
  }
  process.stdout.write('.');
}
console.log('\nFetched ' + fetched.size + ' Shopify orders.');

for (const { r, n } of withNum) {
  const sh = fetched.get(n);
  const res: Result = { ...r, orderNum: n, decision: '', detail: '' };
  if (!sh) { res.decision = 'SKIP'; res.detail = 'no-shopify-order-with-this-number'; results.push(res); continue; }
  res.shopifyName = sh.name;
  res.shopifyCustomer = sh.customer;
  res.shopifyFinancial = sh.financial;
  res.shopifyCancelled = sh.cancelled;
  res.shopifyTotal = sh.total;
  res.nameMatch = nameMatches(r.name, sh.customer);

  if (sh.cancelled) { res.decision = 'SKIP'; res.detail = 'already-cancelled'; results.push(res); continue; }
  if (!res.nameMatch) {
    res.decision = 'REVIEW';
    res.detail = 'name-mismatch: "' + normalize(r.name) + '" vs "' + normalize(sh.customer) + '"';
    results.push(res); continue;
  }
  if (isReturned(r.status)) {
    res.decision = 'CANCEL'; res.detail = 'returned -> cancel+restock';
  } else if (isDelivered(r.status)) {
    if (sh.financial && /paid/i.test(sh.financial)) { res.decision = 'SKIP'; res.detail = 'already-paid'; }
    else { res.decision = 'PAY'; res.detail = 'delivered -> mark paid (' + sh.total + ')'; }
  } else {
    res.decision = 'REVIEW'; res.detail = 'unknown-status: ' + r.status;
  }
  results.push(res);
}
for (const r of noNum) {
  results.push({ ...r, orderNum: null, decision: 'SKIP', detail: 'no-order-number-in-name' });
}

const byDecision: Record<string, number> = {};
for (const r of results) byDecision[r.decision] = (byDecision[r.decision] || 0) + 1;

console.log('\n==============================================================');
console.log('  PREVIEW SUMMARY (no writes performed)');
console.log('==============================================================');
for (const [d, c] of Object.entries(byDecision).sort((a, b) => b[1] - a[1])) console.log('  ' + d.padEnd(8) + ': ' + c);

const payCount = results.filter((r) => r.decision === 'PAY').length;
const cancelCount = results.filter((r) => r.decision === 'CANCEL').length;
console.log('\n  ✅ Will PAY:    ' + payCount);
console.log('  ✅ Will CANCEL: ' + cancelCount);

const reviewList = results.filter((r) => r.decision === 'REVIEW');
console.log('\n  REVIEW (' + reviewList.length + ') samples:');
for (const r of reviewList.slice(0, 20)) console.log('    ' + (r.shopifyName || '#?').padEnd(7) + ' | ' + r.detail);

const esc = (v: unknown) => '"' + String(v ?? '').replace(/"/g, '""') + '"';
const header = ['excelName', 'orderNum', 'shopifyName', 'shopifyCustomer', 'nameMatch', 'amount', 'status', 'shopifyFinancial', 'shopifyCancelled', 'shopifyTotal', 'decision', 'detail', 'file'];
const csvLines = [header.join(',')];
for (const r of results) {
  csvLines.push([r.name, r.orderNum, r.shopifyName, r.shopifyCustomer, r.nameMatch, r.amount, r.status, r.shopifyFinancial, r.shopifyCancelled, r.shopifyTotal, r.decision, r.detail, r.file].map(esc).join(','));
}
writeFileSync('_legacy_preview.csv', '﻿' + csvLines.join('\n'));
console.log('\nSaved full preview to _legacy_preview.csv (' + results.length + ' rows)');
