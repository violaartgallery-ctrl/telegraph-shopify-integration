import { env } from '../config/env.js';

interface OdooRpcResponse<T> {
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

const TRANSIENT_PATTERN = /fetch failed|ECONN|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|ECONNRESET|socket hang up|ESOCKETTIMEDOUT|Gateway|HTTP 5(0[234]|99)/i;
const isTransientRpcError = (error: unknown): boolean => {
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

  private async rpcOnce<T>(service: string, method: string, args: unknown[]): Promise<T> {
    const response = await fetch(this.endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'call',
        params: { service, method, args },
        id: 1
      })
    });

    const body = (await response.json()) as OdooRpcResponse<T>;
    if (!response.ok || body.error) {
      throw new Error(body.error?.data?.message ?? body.error?.message ?? `Odoo HTTP ${response.status}`);
    }
    return body.result as T;
  }

  // Retry transient network/gateway errors twice with exponential backoff before giving up.
  // Non-transient Odoo business errors (validation, missing record, etc.) propagate immediately.
  private async rpc<T>(service: string, method: string, args: unknown[]): Promise<T> {
    const attempts = 3;
    let lastError: unknown;
    for (let i = 0; i < attempts; i++) {
      try {
        return await this.rpcOnce<T>(service, method, args);
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
    if (!uid) {
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
    return await this.rpc<T>('object', 'execute_kw', [
      this.db,
      uid,
      this.password,
      model,
      method,
      args,
      kwargs
    ]);
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
