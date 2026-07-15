import assert from 'node:assert/strict';
import {
  MetaCapiClient,
  MetaCapiConfigError,
  type MetaCapiEvent
} from './metaCapiClient.js';

const event: MetaCapiEvent = {
  event_name: 'Delivered',
  event_time: 1_720_000_000,
  event_id: 'viola:delivered:123',
  action_source: 'website',
  user_data: { ph: ['hashed-phone'] },
  custom_data: { currency: 'EGP', value: 100 }
};

const jsonResponse = (status: number, body: unknown, headers?: Record<string, string>): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers }
  });

const createClient = (fetchImpl: typeof fetch, overrides: Record<string, unknown> = {}): MetaCapiClient =>
  new MetaCapiClient(
    {
      pixelId: '1612387453338865',
      accessToken: 'secret-test-token',
      apiVersion: 'v25.0',
      mode: 'test',
      testEventCode: 'TEST123',
      graphBaseUrl: 'https://graph.example.test',
      ...(overrides as object)
    },
    { fetchImpl }
  );

const main = async (): Promise<void> => {
  let capturedUrl = '';
  let capturedInit: RequestInit | undefined;
  const successFetch: typeof fetch = async (input, init) => {
    capturedUrl = String(input);
    capturedInit = init;
    return jsonResponse(200, { events_received: 1, fbtrace_id: 'trace-success' });
  };

  const success = await createClient(successFetch).sendEvent(event);
  assert.deepEqual(success, {
    ok: true,
    classification: 'success',
    httpStatus: 200,
    eventsReceived: 1,
    fbtraceId: 'trace-success'
  });
  assert.equal(capturedUrl, 'https://graph.example.test/v25.0/1612387453338865/events');
  assert.equal(new URL(capturedUrl).search, '', 'access token must not be sent in the URL');
  assert.equal((capturedInit?.headers as Record<string, string>).Authorization, 'Bearer secret-test-token');
  const testBody = JSON.parse(String(capturedInit?.body)) as Record<string, unknown>;
  assert.equal(testBody.test_event_code, 'TEST123');
  assert.deepEqual(testBody.data, [event]);

  let liveBody: Record<string, unknown> | undefined;
  const liveFetch: typeof fetch = async (_input, init) => {
    liveBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return jsonResponse(200, { events_received: 1 });
  };
  const liveClient = createClient(liveFetch, { mode: 'live', testEventCode: undefined });
  assert.equal((await liveClient.sendEvent(event)).ok, true);
  assert.equal('test_event_code' in (liveBody ?? {}), false, 'live calls must never include test_event_code');

  const invalidSuccess = await createClient(async () => jsonResponse(200, { events_received: 0 })).sendEvent(event);
  assert.equal(invalidSuccess.ok, false);
  if (!invalidSuccess.ok) {
    assert.equal(invalidSuccess.classification, 'invalid_response');
    assert.equal(invalidSuccess.retryable, true);
  }

  const authFailure = await createClient(async () =>
    jsonResponse(401, {
      error: { code: 190, error_subcode: 463, type: 'OAuthException', fbtrace_id: 'trace-auth' }
    })
  ).sendEvent(event);
  assert.equal(authFailure.ok, false);
  if (!authFailure.ok) {
    assert.equal(authFailure.classification, 'auth');
    assert.equal(authFailure.errorCode, 190);
    assert.equal(authFailure.errorSubcode, 463);
    assert.equal(authFailure.fbtraceId, 'trace-auth');
  }

  const oauthInHttp400 = await createClient(async () =>
    jsonResponse(400, { error: { code: 190, type: 'OAuthException' } })
  ).sendEvent(event);
  assert.equal(oauthInHttp400.ok, false);
  if (!oauthInHttp400.ok) assert.equal(oauthInHttp400.classification, 'auth');

  const throttleInHttp400 = await createClient(async () =>
    jsonResponse(400, { error: { code: 4, is_transient: true } })
  ).sendEvent(event);
  assert.equal(throttleInHttp400.ok, false);
  if (!throttleInHttp400.ok) assert.equal(throttleInHttp400.classification, 'retriable');

  const rateLimited = await createClient(async () =>
    jsonResponse(429, { error: { code: 4 } }, { 'retry-after': '17' })
  ).sendEvent(event);
  assert.equal(rateLimited.ok, false);
  if (!rateLimited.ok) {
    assert.equal(rateLimited.classification, 'retriable');
    assert.equal(rateLimited.retryAfterSeconds, 17);
  }

  const badRequest = await createClient(async () => jsonResponse(400, { error: { code: 100 } })).sendEvent(event);
  assert.equal(badRequest.ok, false);
  if (!badRequest.ok) {
    assert.equal(badRequest.classification, 'permanent');
    assert.equal(badRequest.retryable, false);
  }

  const networkFailure = await createClient(async () => {
    throw new TypeError('fetch failed: private details that must not escape');
  }).sendEvent(event);
  assert.deepEqual(networkFailure, {
    ok: false,
    classification: 'retriable',
    retryable: true,
    errorCode: 'NETWORK_ERROR',
    safeMessage: 'Meta network request failed'
  });

  const invalidStoredPayload = await createClient(successFetch).sendEventJson('{broken');
  assert.equal(invalidStoredPayload.ok, false);
  if (!invalidStoredPayload.ok) {
    assert.equal(invalidStoredPayload.classification, 'permanent');
    assert.equal(invalidStoredPayload.errorCode, 'CLIENT_INVALID_EVENT_JSON');
  }

  assert.throws(
    () => createClient(successFetch, { mode: 'live', testEventCode: 'MUST_NOT_LEAK' }),
    MetaCapiConfigError
  );

  console.log('Meta CAPI client self-test passed');
};

await main();
