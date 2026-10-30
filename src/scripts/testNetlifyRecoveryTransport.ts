import assert from 'node:assert/strict';
import { scheduleProductionContinuation, verifyResumeRequest, setProductionQueuePublisherForTests } from '../services/productionContinuation.js';
const prior = { transport: process.env.PRODUCTION_CONTINUATION_TRANSPORT, url: process.env.RECOVERY_PUBLIC_URL, secret: process.env.PRODUCTION_RESUME_SECRET, fetch: globalThis.fetch };
try {
  setProductionQueuePublisherForTests(undefined);
  process.env.PRODUCTION_CONTINUATION_TRANSPORT = 'netlify';
  process.env.RECOVERY_PUBLIC_URL = 'https://recovery-test.netlify.app';
  process.env.PRODUCTION_RESUME_SECRET = 'unit-test-not-a-live-secret';
  let requests = 0;
  globalThis.fetch = (async (input, init) => {
    requests++;
    assert.equal(String(input), 'https://recovery-test.netlify.app/.netlify/functions/production-resume-background');
    assert.equal(init?.method, 'POST');
    const body = String(init?.body);
    assert.equal(verifyResumeRequest(init?.headers as Record<string,string>, body), true);
    assert.deepEqual(JSON.parse(body), { chatId: 123, batchId: 'safe-test', delayMs: 2000 });
    return new Response(null, { status: 202 });
  }) as typeof fetch;
  await scheduleProductionContinuation({ chatId: 123, batchId: 'safe-test', delayMs: 1500 });
  assert.equal(requests, 1);
  process.env.RECOVERY_PUBLIC_URL = 'http://recovery-test.netlify.app';
  await assert.rejects(scheduleProductionContinuation({chatId:123,batchId:'safe-test'}), /Invalid Netlify/);
  assert.equal(requests,1,'invalid origin must never dispatch');
  console.log(JSON.stringify({ok:true,transport:'netlify',signed:true,httpsRequired:true,externalCalls:0}));
} finally {
  globalThis.fetch=prior.fetch;
  for (const [key,value] of Object.entries({PRODUCTION_CONTINUATION_TRANSPORT:prior.transport,RECOVERY_PUBLIC_URL:prior.url,PRODUCTION_RESUME_SECRET:prior.secret})) {
    if(value===undefined)delete process.env[key];else process.env[key]=value;
  }
}
