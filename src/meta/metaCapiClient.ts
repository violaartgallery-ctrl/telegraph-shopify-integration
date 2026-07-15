export type MetaCapiMode = 'test' | 'live';

export interface MetaCapiClientConfig {
  pixelId: string;
  accessToken: string;
  apiVersion: string;
  mode: MetaCapiMode;
  testEventCode?: string;
  timeoutMs?: number;
  graphBaseUrl?: string;
}

export interface MetaCapiClientDependencies {
  fetchImpl?: typeof fetch;
}

export interface MetaCapiEvent {
  event_name: string;
  event_time: number;
  action_source: string;
  event_id?: string;
  event_source_url?: string;
  user_data: Record<string, unknown>;
  custom_data?: Record<string, unknown>;
  [key: string]: unknown;
}

export type MetaCapiFailureClassification =
  | 'retriable'
  | 'auth'
  | 'permanent'
  | 'invalid_response';

export interface MetaCapiSendSuccess {
  ok: true;
  classification: 'success';
  httpStatus: number;
  eventsReceived: 1;
  fbtraceId?: string;
}

export interface MetaCapiSendFailure {
  ok: false;
  classification: MetaCapiFailureClassification;
  /**
   * `auth` failures are retryable only after a longer delay/configuration check.
   * The classification lets the worker avoid a hot retry loop.
   */
  retryable: boolean;
  httpStatus?: number;
  eventsReceived?: number;
  fbtraceId?: string;
  errorCode?: number | string;
  errorSubcode?: number;
  errorType?: string;
  retryAfterSeconds?: number;
  safeMessage: string;
}

export type MetaCapiSendResult = MetaCapiSendSuccess | MetaCapiSendFailure;

interface MetaCapiResponseBody {
  events_received?: unknown;
  fbtrace_id?: unknown;
  error?: {
    code?: unknown;
    error_subcode?: unknown;
    type?: unknown;
    fbtrace_id?: unknown;
    is_transient?: unknown;
  };
}

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_GRAPH_BASE_URL = 'https://graph.facebook.com';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const optionalString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length > 0 ? value : undefined;

const optionalInteger = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isSafeInteger(value) ? value : undefined;

const optionalBoolean = (value: unknown): boolean | undefined =>
  typeof value === 'boolean' ? value : undefined;

const META_TRANSIENT_ERROR_CODES = new Set([1, 2, 4, 17, 32, 341, 368, 613]);
const META_AUTH_ERROR_CODES = new Set([10, 190, 200, 294]);

const parseRetryAfterSeconds = (value: string | null): number | undefined => {
  if (!value) return undefined;

  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.ceil(seconds);
  }

  const dateMs = Date.parse(value);
  if (!Number.isNaN(dateMs)) {
    return Math.max(0, Math.ceil((dateMs - Date.now()) / 1000));
  }

  return undefined;
};

const parseJsonObject = (text: string): MetaCapiResponseBody | undefined => {
  if (!text) return undefined;
  try {
    const value: unknown = JSON.parse(text);
    return isRecord(value) ? (value as MetaCapiResponseBody) : undefined;
  } catch {
    return undefined;
  }
};

const getTraceId = (body: MetaCapiResponseBody | undefined): string | undefined =>
  optionalString(body?.fbtrace_id) ?? optionalString(body?.error?.fbtrace_id);

const getErrorCode = (body: MetaCapiResponseBody | undefined): number | string | undefined => {
  const value = body?.error?.code;
  if (typeof value === 'number' && Number.isSafeInteger(value)) return value;
  if (typeof value === 'string' && value.length > 0) return value;
  return undefined;
};

const validateEvent = (event: MetaCapiEvent): MetaCapiSendFailure | undefined => {
  if (
    !isRecord(event) ||
    typeof event.event_name !== 'string' ||
    event.event_name.length === 0 ||
    !Number.isSafeInteger(event.event_time) ||
    event.event_time <= 0 ||
    typeof event.action_source !== 'string' ||
    event.action_source.length === 0 ||
    !isRecord(event.user_data)
  ) {
    return {
      ok: false,
      classification: 'permanent',
      retryable: false,
      errorCode: 'CLIENT_INVALID_EVENT',
      safeMessage: 'Meta event failed local validation'
    };
  }
  return undefined;
};

export class MetaCapiConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MetaCapiConfigError';
  }
}

/**
 * Thin, side-effect-free Meta Conversions API transport.
 *
 * It deliberately does not log requests, responses, event payloads, or tokens.
 * Callers may safely log the returned status/classification/error codes.
 */
export class MetaCapiClient {
  private readonly config: Required<
    Pick<MetaCapiClientConfig, 'pixelId' | 'accessToken' | 'apiVersion' | 'mode' | 'timeoutMs' | 'graphBaseUrl'>
  > & Pick<MetaCapiClientConfig, 'testEventCode'>;
  private readonly fetchImpl: typeof fetch;

  constructor(config: MetaCapiClientConfig, dependencies: MetaCapiClientDependencies = {}) {
    const pixelId = config.pixelId.trim();
    const accessToken = config.accessToken.trim();
    const apiVersion = config.apiVersion.trim();
    const testEventCode = config.testEventCode?.trim() || undefined;
    const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const graphBaseUrl = (config.graphBaseUrl ?? DEFAULT_GRAPH_BASE_URL).replace(/\/+$/, '');

    if (!/^\d+$/.test(pixelId)) {
      throw new MetaCapiConfigError('Meta pixel ID must contain digits only');
    }
    if (!accessToken) {
      throw new MetaCapiConfigError('Meta access token is required');
    }
    if (!/^v\d+\.\d+$/.test(apiVersion)) {
      throw new MetaCapiConfigError('Meta API version must look like v25.0');
    }
    if (config.mode !== 'test' && config.mode !== 'live') {
      throw new MetaCapiConfigError('Meta CAPI mode must be test or live');
    }
    if (config.mode === 'test' && !testEventCode) {
      throw new MetaCapiConfigError('Meta test event code is required in test mode');
    }
    if (config.mode === 'live' && testEventCode) {
      throw new MetaCapiConfigError('Meta test event code must not be configured in live mode');
    }
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
      throw new MetaCapiConfigError('Meta request timeout must be a positive integer');
    }

    let parsedBaseUrl: URL;
    try {
      parsedBaseUrl = new URL(graphBaseUrl);
    } catch {
      throw new MetaCapiConfigError('Meta Graph base URL must be an absolute URL');
    }
    if (!['https:', 'http:'].includes(parsedBaseUrl.protocol)) {
      throw new MetaCapiConfigError('Meta Graph base URL must use HTTP or HTTPS');
    }

    this.config = {
      pixelId,
      accessToken,
      apiVersion,
      mode: config.mode,
      testEventCode,
      timeoutMs,
      graphBaseUrl
    };
    this.fetchImpl = dependencies.fetchImpl ?? fetch;
  }

  async sendEvent(event: MetaCapiEvent): Promise<MetaCapiSendResult> {
    const validationFailure = validateEvent(event);
    if (validationFailure) return validationFailure;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs);

    let response: Response;
    try {
      const body = {
        data: [event],
        ...(this.config.mode === 'test' ? { test_event_code: this.config.testEventCode } : {})
      };

      response = await this.fetchImpl(
        `${this.config.graphBaseUrl}/${this.config.apiVersion}/${encodeURIComponent(this.config.pixelId)}/events`,
        {
          method: 'POST',
          headers: {
            Accept: 'application/json',
            Authorization: `Bearer ${this.config.accessToken}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify(body),
          signal: controller.signal
        }
      );
    } catch (error) {
      const timedOut = controller.signal.aborted || (error instanceof Error && error.name === 'AbortError');
      return {
        ok: false,
        classification: 'retriable',
        retryable: true,
        errorCode: timedOut ? 'TIMEOUT' : 'NETWORK_ERROR',
        safeMessage: timedOut ? 'Meta request timed out' : 'Meta network request failed'
      };
    } finally {
      clearTimeout(timeout);
    }

    let responseText = '';
    try {
      responseText = await response.text();
    } catch {
      // A successful status still needs a valid body with events_received=1.
      // For error statuses the HTTP code remains sufficient for classification.
    }

    const responseBody = parseJsonObject(responseText);
    const httpStatus = response.status;
    const eventsReceived = optionalInteger(responseBody?.events_received);
    const fbtraceId = getTraceId(responseBody);
    const errorCode = getErrorCode(responseBody);
    const errorSubcode = optionalInteger(responseBody?.error?.error_subcode);
    const errorType = optionalString(responseBody?.error?.type);
    const isTransient = optionalBoolean(responseBody?.error?.is_transient);
    const retryAfterSeconds = parseRetryAfterSeconds(response.headers.get('retry-after'));

    if (response.ok && eventsReceived === 1) {
      return {
        ok: true,
        classification: 'success',
        httpStatus,
        eventsReceived: 1,
        ...(fbtraceId ? { fbtraceId } : {})
      };
    }

    const shared = {
      ok: false as const,
      httpStatus,
      ...(eventsReceived !== undefined ? { eventsReceived } : {}),
      ...(fbtraceId ? { fbtraceId } : {}),
      ...(errorCode !== undefined ? { errorCode } : {}),
      ...(errorSubcode !== undefined ? { errorSubcode } : {}),
      ...(errorType ? { errorType } : {}),
      ...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {})
    };

    if (response.ok) {
      return {
        ...shared,
        classification: 'invalid_response',
        retryable: true,
        errorCode: errorCode ?? 'INVALID_SUCCESS_RESPONSE',
        safeMessage: 'Meta returned success HTTP status without accepting exactly one event'
      };
    }

    const numericErrorCode = typeof errorCode === 'number'
      ? errorCode
      : typeof errorCode === 'string' && /^\d+$/.test(errorCode)
        ? Number(errorCode)
        : undefined;

    // Graph API often returns HTTP 400 for OAuth and throttling failures. The
    // structured code/is_transient signal takes precedence over HTTP class.
    if (numericErrorCode !== undefined && META_AUTH_ERROR_CODES.has(numericErrorCode)) {
      return {
        ...shared,
        classification: 'auth',
        retryable: true,
        safeMessage: 'Meta rejected API authentication or permissions'
      };
    }

    if (isTransient === true || (numericErrorCode !== undefined && META_TRANSIENT_ERROR_CODES.has(numericErrorCode))) {
      return {
        ...shared,
        classification: 'retriable',
        retryable: true,
        safeMessage: 'Meta returned a transient Graph API error'
      };
    }

    if (httpStatus === 401 || httpStatus === 403) {
      return {
        ...shared,
        classification: 'auth',
        retryable: true,
        errorCode: errorCode ?? `HTTP_${httpStatus}`,
        safeMessage: 'Meta rejected API authentication or authorization'
      };
    }

    if (httpStatus === 408 || httpStatus === 429 || httpStatus >= 500) {
      return {
        ...shared,
        classification: 'retriable',
        retryable: true,
        errorCode: errorCode ?? `HTTP_${httpStatus}`,
        safeMessage: 'Meta request failed with a transient HTTP status'
      };
    }

    return {
      ...shared,
      classification: 'permanent',
      retryable: false,
      errorCode: errorCode ?? `HTTP_${httpStatus}`,
      safeMessage: 'Meta rejected the event request'
    };
  }

  async sendEventJson(eventJson: string): Promise<MetaCapiSendResult> {
    let event: unknown;
    try {
      event = JSON.parse(eventJson);
    } catch {
      return {
        ok: false,
        classification: 'permanent',
        retryable: false,
        errorCode: 'CLIENT_INVALID_EVENT_JSON',
        safeMessage: 'Stored Meta event payload is not valid JSON'
      };
    }

    if (!isRecord(event)) {
      return {
        ok: false,
        classification: 'permanent',
        retryable: false,
        errorCode: 'CLIENT_INVALID_EVENT_JSON',
        safeMessage: 'Stored Meta event payload must be a JSON object'
      };
    }

    return await this.sendEvent(event as MetaCapiEvent);
  }
}
