/**
 * Unit-style sanity check for calculateNetMerchantDue (no real APIs).
 */
import { calculateNetMerchantDue } from '../odoo/odooSyncService.js';

interface Case {
  name: string;
  input: { collectedAmount?: number | null; deliveryFees?: number | null };
  expected: number | null;
}

const cases: Case[] = [
  { name: 'happy path 670 - 71 = 599',         input: { collectedAmount: 670, deliveryFees: 71 }, expected: 599 },
  { name: 'happy path 1270 - 71 = 1199',       input: { collectedAmount: 1270, deliveryFees: 71 }, expected: 1199 },
  { name: 'zero fees keeps gross',             input: { collectedAmount: 800, deliveryFees: 0 }, expected: 800 },
  { name: 'null collected → defer',            input: { collectedAmount: null, deliveryFees: 71 }, expected: null },
  { name: 'undefined collected → defer',       input: { deliveryFees: 71 }, expected: null },
  { name: 'null deliveryFees → defer',         input: { collectedAmount: 670, deliveryFees: null }, expected: null },
  { name: 'undefined deliveryFees → defer',    input: { collectedAmount: 670 }, expected: null },
  { name: 'negative net → defer',              input: { collectedAmount: 50, deliveryFees: 71 }, expected: null },
  { name: 'zero collected → defer',            input: { collectedAmount: 0, deliveryFees: 0 }, expected: null },
  { name: 'rounding 670.001 - 71 = 599.00',    input: { collectedAmount: 670.001, deliveryFees: 71 }, expected: 599 }
];

let pass = 0;
let fail = 0;
for (const c of cases) {
  const got = calculateNetMerchantDue(c.input);
  const ok = got === c.expected;
  if (ok) pass++; else fail++;
  console.log(`  ${ok ? '✅' : '❌'} ${c.name} → got=${got} expected=${c.expected}`);
}
console.log(`\nResult: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
