import assert from 'node:assert/strict';
import { InProcessRecoveryQueue } from '../services/inProcessRecoveryQueue.js';
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const seen: number[] = [];
let active = 0;
let maxActive = 0;
const errors: unknown[] = [];
const queue = new InProcessRecoveryQueue<number>(async n => {
  active++; maxActive = Math.max(maxActive, active);
  try { if (n === 3) throw new Error('test'); await sleep(10); seen.push(n); }
  finally { active--; }
}, error => { errors.push(error); }, 5);
queue.enqueue('one', 1); queue.enqueue('one', 99); queue.enqueue('two', 2); queue.enqueue('three', 3); queue.enqueue('four', 4, 20);
assert.equal(queue.size, 4);
await sleep(120);
assert.deepEqual(seen, [1, 2, 4]);
assert.equal(maxActive, 1);
assert.equal(errors.length, 1);
assert.equal(queue.size, 0);
assert.throws(() => queue.enqueue('', 0), /Invalid/);
assert.throws(() => queue.enqueue('nan', 0, NaN), /Invalid/);
queue.enqueue('future', 5, 10000);
queue.close();
await sleep(10);
assert.equal(queue.size, 0);
assert.throws(() => queue.enqueue('closed', 6), /closed/);
console.log(JSON.stringify({ ok: true, checks: 10, externalCalls: 0 }));
