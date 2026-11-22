import { env } from '../config/env.js';
import { beforeAutomaticOdooWrite, haltAutomaticOperation } from '../services/automaticOperationSafety.js';

interface OdooRpcResponse<T> {
  jsonrpc?: string;
  id?: number;
  result?: T;
  error?: {
    message?: string;
    data?: {
      message?: string;
      debug?: string;
    };
  };
}

export type OdooDomain = Array<unknown>;
export type OdooRecord = Record<string, unknown> & { id: number };

export class OdooConfigError extends Error {}

// Exact native ORM reads only. Unknown/custom methods (including read-like
// names, onchange and wizard defaults) must be treated as potential writes.
const READ_ONLY_METHODS = new Set(['search', 'search_read', 'search_count', 'read', 'read_group', 'fields_get']);
export const isReadOnlyOdooMethod = (method: string): boolean => READ_ONLY_METHODS.has(method);

interface MutationRpc {
  model: string;
  method: string;
}

export class OdooWriteOutcomeUnknownError extends Error {
  readonly code = 'ODOO_WRITE_OUTCOME_UNKNOWN';
  readonly manualReviewRequired = true;
  readonly retryable = false;

  constructor(
    readonly model: string,
    readonly method: string,
    readonly reason: string
  ) {
    // Do not append the transport/server message or cause: legacy workers use
    // message regexes to schedule retries, and no sent mutation is safe to replay.
    super('Odoo mutation outcome unknown; manual review required. Do not repeat before independent reconciliation.');
    this.name = 'OdooWriteOutcomeUnknownError';
  }
}

const TRANSIENT_PATTERN = /fetch failed|ECONN|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up|ESOCKETTIMEDOUT|Gateway|HTTP 5\d\d|HTTP 429/i;
const isTransientRpcError = (error: unknown): boolean => {
  if (error instanceof OdooWriteOutcomeUnknownError) return false;
  if (error instanceof Error && ['AbortError', 'TimeoutError'].includes(error.name)) return true;
  const message = error instanceof Error ? error.message : String(error);
  return TRANSIENT_PATTERN.test(message);
};
const wait = async (ms: number): Promise<void> => await new Promise((r) => setTimeout(r, ms));

export class OdooClient {
  private uid?: number;

  private get endpoint(): string {
    if (!env.odoo.url) {
      throw new OdooConfigError('ODOO_URL is required when Odoo sync is enabled');
    }
    return `${env.odoo.url}/jsonrpc`;
  }

  private get db(): string {
    if (!env.odoo.db) {
      throw new OdooConfigError('ODOO_DB is required when Odoo sync is enabled');
    }
    return env.odoo.db;
  }

  private get username(): string {
    if (!env.odoo.username) {
      throw new OdooConfigError('ODOO_USERNAME is required when Odoo sync is enabled');
    }
    return env.odoo.username;
  }

  private get password(): string {
    if (!env.odoo.password) {
      throw new OdooConfigError('ODOO_PASSWORD is required when Odoo sync is enabled');
    }
    return env.odoo.password;
  }

  private async rpcOnce<T>(service: string, method: string, args: unknown[], mutation?: MutationRpc): Promise<T> {
    // Configuration/serialization errors happen before fetch and are not
    // ambiguous external outcomes. The operation-intent hook also runs outside
    // this sent-request boundary, in executeKw.
    const endpoint = this.endpoint;
    const request = {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'call',
        params: { service, method, args },
        id: 1
      })
    };
    const invalidResponse = (reason: string): Error => {
      if (!mutation) return new Error(`Odoo RPC invalid response (${reason})`);
      // Sticky ALS halt also fences native service catches/fallbacks; a caught
      // exception must never permit another write or a successful worker result.
      haltAutomaticOperation('ODOO_WRITE_OUTCOME_UNKNOWN');
      return new OdooWriteOutcomeUnknownError(mutation.model, mutation.method, reason);
    };
    let response: Response;
    try {
      response = await fetch(endpoint, request);
    } catch (error) {
      if (mutation) throw invalidResponse('transport');
      throw error;
    }
    if (!response.ok) {
      // A proxy/auth/server response does not prove that a write was not
      // accepted upstream. Never reauthenticate and replay a sent mutation.
      if (mutation) throw invalidResponse('response-status');
      throw new Error(`Odoo HTTP ${response.status}`);
    }
    let parsed: unknown;
    try {
      parsed = await response.json();
    } catch {
      throw invalidResponse('response-parse');
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw invalidResponse('response-shape');
    }
    const body = parsed as OdooRpcResponse<T>;
    if ((body.id !== undefined && body.id !== 1) || (body.jsonrpc !== undefined && body.jsonrpc !== '2.0')) {
      throw invalidResponse('response-envelope');
    }
    if (body.error != null) {
      const message = body.error?.data?.message ?? body.error?.message;
      if (Object.hasOwn(body, 'result') || typeof message !== 'string' || !message) {
        throw invalidResponse('response-error');
      }
      // A complete Odoo RPC business rejection is not an unknown outcome.
      // Preserve its message for existing missing-method/sequence guards, but
      // the mutation transport still makes exactly one attempt.
      throw new Error(message);
    }
    if (!Object.hasOwn(body, 'result') || body.result === undefined) {
      throw invalidResponse('missing-result');
    }
    if (mutation?.method === 'create') {
      const validId = (id: unknown): boolean => typeof id === 'number' && Number.isSafeInteger(id) && id > 0;
      const validIds = Array.isArray(body.result)
        ? body.result.length > 0 && body.result.every(validId)
        : validId(body.result);
      if (!validIds) throw invalidResponse('invalid-create-result');
    }
    return body.result as T;
  }

  // Only authentication and explicitly allowlisted ORM reads may retry.
  private async rpc<T>(service: string, method: string, args: unknown[], mutation?: MutationRpc): Promise<T> {
    const attempts = mutation ? 1 : 3;
    let lastError: unknown;
    for (let i = 0; i < attempts; i++) {
      try {
        return await this.rpcOnce<T>(service, method, args, mutation);
      } catch (err) {
        lastError = err;
        if (i === attempts - 1 || !isTransientRpcError(err)) throw err;
        await wait(300 * Math.pow(2, i)); // 300 ms, 600 ms
      }
    }
    throw lastError;
  }

  async login(): Promise<number> {
    const uid = await this.rpc<number>('common', 'login', [this.db, this.username, this.password]);
    if (!Number.isSafeInteger(uid) || uid <= 0) {
      throw new Error('Odoo login failed');
    }
    this.uid = uid;
    return uid;
  }

  private async ensureUid(): Promise<number> {
    if (!this.uid) {
      await this.login();
    }
    return this.uid as number;
  }

  async executeKw<T>(
    model: string,
    method: string,
    args: unknown[] = [],
    kwargs: Record<string, unknown> = {}
  ): Promise<T> {
    const uid = await this.ensureUid();
    const mutation = isReadOnlyOdooMethod(method) ? undefined : { model, method };
    // The main-owned hook validates AsyncLocalStorage record authority and
    // persists first-write intent when safe queues are enabled. Rejections
    // propagate unchanged, BEFORE fetch, never as unknown sent writes.
    if (mutation) await beforeAutomaticOdooWrite(model, method);
    return await this.rpc<T>('object', 'execute_kw', [
      this.db,
      uid,
      this.password,
      model,
      method,
      args,
      kwargs
    ], mutation);
  }

  async searchRead<T extends OdooRecord>(
    model: string,
    domain: OdooDomain,
    fields: string[],
    options: { limit?: number; order?: string; context?: Record<string, unknown> } = {}
  ): Promise<T[]> {
    return await this.executeKw<T[]>(model, 'search_read', [domain], {
      fields,
      limit: options.limit ?? 80,
      ...(options.order ? { order: options.order } : {}),
      ...(options.context ? { context: options.context } : {})
    });
  }

  async create(model: string, values: Record<string, unknown>, context?: Record<string, unknown>): Promise<number> {
    return await this.executeKw<number>(model, 'create', [values], context ? { context } : {});
  }

  async call<T = unknown>(
    model: string,
    method: string,
    args: unknown[] = [],
    kwargs: Record<string, unknown> = {}
  ): Promise<T> {
    return await this.executeKw<T>(model, method, args, kwargs);
  }
}
