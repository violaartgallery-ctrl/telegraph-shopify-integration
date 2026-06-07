/**
 * LEGACY SHIPPING RECONCILIATION — apply phase.
 *
 * Re-derives the same matching as _legacyShopifyPreview (live fetch from Shopify)
 * then applies, using the EXACT deployed client methods:
 *   - delivered + name match  → recordCustomerPayment(amount = Shopify total) + tag
 *   - returned  + name match  → cancelOrder(restock) + tag
 *   - no number / name mismatch / already done → skip
 *
 * Idempotent (fetchOrderPaymentState short-circuits paid/cancelled).
 * DRY by default; DRY=0 to write. NO Odoo / Telegraph writes.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { shopifyOrdersClient } from '../shopify/shopifyOrdersClient.js';
import { shopifyStatusSyncClient } from '../shopify/shopifyStatusSyncClient.js';

const DRY = process.env.DRY !== '0';
const LEGACY_TAG = 'legacy-viola-shipping';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface ExtObj { n: number | null; ambiguous?: boolean; outOfRange?: number; raw?: string }
interface Row { file: string; sender: string; name: string; amount: number; date: string; status: string; ext: number | ExtObj }

const rows: Row[] = JSON.parse(readFileSync('_legacy_unique.json', 'utf8'));

const orderNum = (ext: Row['ext']): number | null => {
  if (typeof ext === 'number') return ext;
  if (ext && typeof ext === 'object' && ext.ambiguous && ext.n) return ext.n;
  return null;
};

const ARABIC_DIACRITICS = /[ً-ْٰ]/g;
const normalize = (s: string): string =>
  String(s).replace(/\d+\s*$/, '').replace(ARABIC_DIACRITICS, '')
    .replace(/[إأآا]/g, 'ا').replace(/ى/g, 'ي').replace(/ة/g, 'ه')
    .toLowerCase().replace(/[^a-z0-9؀-ۿ]+/g, ' ').trim();

const nameMatches = (excelName: string, shopName: string): boolean => {
  const a = normalize(excelName); const b = normalize(shopName);
  if (!a || !b) return false;
  if (a === b || a.includes(b) || b.includes(a)) return true;
  const ta = new Set(a.split(' ').filter((t) => t.length > 1));
  const tb = new Set(b.split(' ').filter((t) => t.length > 1));
  let shared = 0; for (const t of ta) if (tb.has(t)) shared++;
  return shared > 0 && shared >= Math.min(2, Math.min(ta.size, tb.size));
};

const isDelivered = (s: string): boolean => s.includes('تم التسليم');
const isReturned = (s: string): boolean => /ارجاع|ارتجاع/.test(s);

// --- Build Shopify lookup map (same as preview) ---
const withNum = rows.map((r) => ({ r, n: orderNum(r.ext) })).filter((x) => x.n != null) as { r: Row; n: number }[];
const uniqueNums = [...new Set(withNum.map((x) => x.n))];
const fetched = new Map<number, { id: number; name: string; customer: string; financial: string | null; cancelled: boolean; total: number }>();

console.log('Mode: ' + (DRY ? 'DRY RUN' : 'WRITE'));
console.log('Looking up ' + uniqueNums.length + ' Shopify orders...');
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
        id: Number(o.id), name: o.name, customer: cust, financial: o.financial_status ?? null,
        cancelled: Boolean((o as { cancelled_at?: string }).cancelled_at), total: Number(o.total_price ?? 0)
      });
    }
  } catch (e) { console.log('  lookup err @' + i + ': ' + (e instanceof Error ? e.message : String(e))); }
  process.stdout.write('.');
}
console.log('\nFetched ' + fetched.size + ' orders.\n');

// --- Decide + apply ---
interface Out { order: string; action: string; result: string; detail: string }
const out: Out[] = [];
const counters = { paid: 0, cancelled: 0, skipped: 0, failed: 0, reviewSkip: 0 };
const MAX_ACTIONS = Number(process.env.MAX_ACTIONS ?? Infinity);
let actionsDone = 0;

// Dedupe: one action per Shopify order number (a number can appear in both a delivered
// and a returned row across reports — returned wins as the terminal state).
const byNum = new Map<number, { r: Row; n: number }[]>();
for (const x of withNum) {
  if (!byNum.has(x.n)) byNum.set(x.n, []);
  byNum.get(x.n)!.push(x);
}

for (const [n, group] of byNum) {
  const sh = fetched.get(n);
  if (!sh) { counters.skipped++; out.push({ order: '#' + n, action: 'skip', result: 'skip', detail: 'no-shopify-order' }); continue; }

  // Determine terminal intent: if ANY row for this order is returned → cancel; else if delivered → pay.
  const returnedRow = group.find((g) => isReturned(g.r.status));
  const deliveredRow = group.find((g) => isDelivered(g.r.status));
  const chosen = returnedRow ?? deliveredRow ?? group[0];
  const intent = returnedRow ? 'cancel' : (deliveredRow ? 'pay' : 'review');

  // Name match guard (use the chosen row's excel name).
  if (!nameMatches(chosen.r.name, sh.customer)) {
    counters.reviewSkip++;
    out.push({ order: sh.name, action: intent, result: 'skip', detail: 'name-mismatch: "' + normalize(chosen.r.name) + '" vs "' + normalize(sh.customer) + '"' });
    continue;
  }

  if (sh.cancelled) { counters.skipped++; out.push({ order: sh.name, action: intent, result: 'skip', detail: 'already-cancelled' }); continue; }

  if (!DRY && actionsDone >= MAX_ACTIONS) { counters.skipped++; out.push({ order: sh.name, action: intent, result: 'skip', detail: 'max-actions-cap' }); continue; }

  if (intent === 'cancel') {
    if (DRY) { counters.cancelled++; out.push({ order: sh.name, action: 'cancel', result: 'dry', detail: 'would cancel+restock' }); continue; }
    try {
      const res = await shopifyStatusSyncClient.cancelOrder({
        orderId: sh.id, reason: 'OTHER', refund: false, restock: true, notifyCustomer: false,
        staffNote: 'Legacy Viola shipping — returned'
      });
      if (res.skipped) { counters.skipped++; out.push({ order: sh.name, action: 'cancel', result: 'skip', detail: res.reason ?? '' }); }
      else {
        await shopifyStatusSyncClient.addOrderTags(sh.id, [LEGACY_TAG]);
        counters.cancelled++; actionsDone++; out.push({ order: sh.name, action: 'cancel', result: 'done', detail: 'cancelled+restock+tag' });
        console.log('  ✅ ' + sh.name + ' cancelled');
      }
    } catch (e) { counters.failed++; out.push({ order: sh.name, action: 'cancel', result: 'fail', detail: e instanceof Error ? e.message : String(e) }); console.log('  ❌ ' + sh.name + ' cancel: ' + (e instanceof Error ? e.message : e)); }
  } else if (intent === 'pay') {
    if (sh.financial && /paid/i.test(sh.financial)) { counters.skipped++; out.push({ order: sh.name, action: 'pay', result: 'skip', detail: 'already-paid' }); continue; }
    if (DRY) { counters.paid++; out.push({ order: sh.name, action: 'pay', result: 'dry', detail: 'would pay ' + sh.total }); continue; }
    try {
      const res = await shopifyStatusSyncClient.recordCustomerPayment({ orderId: sh.id, amount: sh.total });
      if (res.skipped && res.reason !== 'needs-discount') {
        counters.skipped++; out.push({ order: sh.name, action: 'pay', result: 'skip', detail: res.reason ?? '' });
      } else {
        await shopifyStatusSyncClient.addOrderTags(sh.id, [LEGACY_TAG]);
        counters.paid++; actionsDone++; out.push({ order: sh.name, action: 'pay', result: 'done', detail: 'paid ' + sh.total + '+tag' });
        console.log('  ✅ ' + sh.name + ' paid ' + sh.total);
      }
    } catch (e) { counters.failed++; out.push({ order: sh.name, action: 'pay', result: 'fail', detail: e instanceof Error ? e.message : String(e) }); console.log('  ❌ ' + sh.name + ' pay: ' + (e instanceof Error ? e.message : e)); }
  } else {
    counters.reviewSkip++; out.push({ order: sh.name, action: 'review', result: 'skip', detail: 'unknown-status' });
  }

  if (!DRY) await sleep(250); // gentle throttle
}

console.log('\n==============================================================');
console.log('  ' + (DRY ? 'DRY RUN' : 'APPLY') + ' SUMMARY');
console.log('==============================================================');
console.log('  ✅ Paid:        ' + counters.paid);
console.log('  ✅ Cancelled:   ' + counters.cancelled);
console.log('  ⏭️  Skipped:     ' + counters.skipped);
console.log('  ⚠️  Review-skip: ' + counters.reviewSkip);
console.log('  ❌ Failed:      ' + counters.failed);

const esc = (v: unknown) => '"' + String(v ?? '').replace(/"/g, '""') + '"';
writeFileSync('_legacy_apply_result.csv', '﻿order,action,result,detail\n' +
  out.map((o) => [o.order, o.action, o.result, o.detail].map(esc).join(',')).join('\n'));
console.log('\nSaved result to _legacy_apply_result.csv (' + out.length + ' rows)');
