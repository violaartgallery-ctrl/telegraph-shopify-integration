import { env } from '../config/env.js';
import { UnauthorizedError, ValidationError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import { retry } from '../lib/retry.js';
import { GET_SHIPMENT_QUERY, LIST_ZONES_QUERY, LOGIN_MUTATION, SAVE_SHIPMENT_MUTATION } from './queries.js';

interface LoginResponse {
  login: {
    token: string;
    ttl?: string | null;
  };
}

interface SaveShipmentResponse {
  saveShipment: {
    id: number;
    code: string;
    refNumber?: string | null;
    status?: {
      code?: string | null;
      name?: string | null;
    } | null;
  } | null;
}

interface ShipmentLookupResponse {
  shipment: {
    id: number;
    code: string;
    refNumber?: string | null;
    deliveredOrReturnedDate?: string | null;
    collected: boolean;
    paidToCustomer: boolean;
    paidToDeliveryAgent: boolean;
    cancelled: boolean;
    trackingUrl: string;
    collectedAmount: number;
    pendingCollectionAmount: number;
    returnedValue: number;
    deliveryFees: number;
    returnFees: number;
    returningDueFees: number;
    customerDue: number;
    status?: {
      code?: string | null;
      name?: string | null;
    } | null;
    returnStatus?: {
      code?: string | null;
      name?: string | null;
    } | null;
  } | null;
}

interface ZoneDropdownResponse {
  listZonesDropdown: Array<{
    id: number;
    name: string;
    code?: string | null;
  }>;
}

interface AccurateGraphqlResponse<T> {
  data?: T;
  errors?: Array<{ message: string; extensions?: Record<string, unknown> }>;
}

class AccurateGraphqlError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly errors?: Array<{ message: string; extensions?: Record<string, unknown> }>
  ) {
    super(message);
  }
}

export interface AccurateShipmentInput {
  code?: string;
  date?: string;
  deliveryDate?: string;
  description?: string;
  notes?: string;
  openableCode?: string;
  paymentTypeCode?: string;
  piecesCount?: number;
  price?: number;
  priceTypeCode?: string;
  recipientAddress: string;
  recipientLatitude?: number;
  recipientLongitude?: number;
  recipientMobile: string;
  recipientName?: string;
  recipientPhone: string;
  recipientSubzoneId: number;
  recipientZoneId: number;
  refNumber?: string;
  returnPiecesCount?: number;
  serviceId: number;
  customerId?: number;
  branchId?: number;
  originBranchId?: number;
  senderAddress?: string;
  senderLatitude?: number;
  senderLongitude?: number;
  senderMobile?: string;
  senderName?: string;
  senderPhone?: string;
  senderPostalCode?: string;
  senderSubzoneId?: number;
  senderZoneId?: number;
  shipmentProducts?: Array<{
    productId: number;
    quantity: number;
    price: number;
    typeCode?: string;
  }>;
  typeCode?: string;
  weight?: number;
}

const parseTtlToExpiry = (ttl?: string | null): number => {
  if (!ttl) {
    return Date.now() + 55 * 60_000;
  }
  const seconds = Number.parseInt(ttl, 10);
  if (!Number.isNaN(seconds)) {
    return Date.now() + seconds * 1000 - 60_000;
  }
  return Date.now() + 55 * 60_000;
};

const isUnauthorized = (error: unknown): boolean => {
  if (error instanceof UnauthorizedError) return true;
  if (error instanceof AccurateGraphqlError) {
    return error.status === 401 || (error.errors?.some((entry) => /unauth/i.test(entry.message)) ?? false);
  }
  return false;
};

const isValidationError = (error: unknown): boolean => {
  if (error instanceof ValidationError) return true;
  if (error instanceof AccurateGraphqlError) {
    return Boolean(error.errors?.length) && error.status !== 401;
  }
  return false;
};

const isTransientError = (error: unknown): boolean => {
  if (isUnauthorized(error) || isValidationError(error)) return false;
  if (error instanceof AccurateGraphqlError) {
    return error.status >= 500;
  }
  if (error instanceof Error) {
    return /ECONN|ETIMEDOUT|fetch failed|network/i.test(error.message);
  }
  return false;
};

export class AccurateClient {
  private token?: string;
  private tokenExpiresAt?: number;

  private async login(): Promise<void> {
    logger.info('Authenticating with Accurate API');
    const response = await this.request<LoginResponse>(LOGIN_MUTATION, {
      input: {
        username: env.accurate.username,
        password: env.accurate.password,
        rememberMe: true
      }
    });

    this.token = response.login.token;
    this.tokenExpiresAt = parseTtlToExpiry(response.login.ttl);
  }

  private async ensureAuthenticated(): Promise<void> {
    if (!this.token || !this.tokenExpiresAt || Date.now() >= this.tokenExpiresAt) {
      await this.login();
    }
  }

  private async requestWithAuth<T>(document: string, variables?: Record<string, unknown>): Promise<T> {
    await this.ensureAuthenticated();

    const run = async (): Promise<T> => {
      try {
        return await this.request<T>(document, variables, this.token);
      } catch (error) {
        if (isUnauthorized(error)) {
          this.token = undefined;
          this.tokenExpiresAt = undefined;
          throw new UnauthorizedError();
        }
        if (error instanceof AccurateGraphqlError && error.errors?.length) {
          throw new ValidationError('Accurate GraphQL validation error', error.errors);
        }
        throw error;
      }
    };

    try {
      return await retry(run, isTransientError, 3, 500);
    } catch (error) {
      if (isUnauthorized(error)) {
        await this.login();
        return await retry(run, isTransientError, 2, 300);
      }
      logger.error('Accurate GraphQL request failed', error);
      throw error;
    }
  }

  private async request<T>(document: string, variables?: Record<string, unknown>, token?: string): Promise<T> {
    const response = await fetch(env.accurate.endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {})
      },
      body: JSON.stringify({ query: document, variables })
    });

    const body = (await response.json()) as AccurateGraphqlResponse<T>;
    if (!response.ok || body.errors?.length) {
      throw new AccurateGraphqlError(
        body.errors?.map((entry) => entry.message).join('; ') || `Accurate GraphQL HTTP ${response.status}`,
        response.status,
        body.errors
      );
    }

    if (!body.data) {
      throw new AccurateGraphqlError('Accurate GraphQL returned no data', response.status);
    }

    return body.data;
  }

  async saveShipment(input: AccurateShipmentInput): Promise<SaveShipmentResponse['saveShipment']> {
    const response = await this.requestWithAuth<SaveShipmentResponse>(SAVE_SHIPMENT_MUTATION, { input });
    return response.saveShipment;
  }

  async getShipment(params: { id?: number; code?: string }): Promise<ShipmentLookupResponse['shipment']> {
    const response = await this.requestWithAuth<ShipmentLookupResponse>(GET_SHIPMENT_QUERY, params);
    return response.shipment;
  }

  async listZones(input: {
    branchId?: number;
    parentId?: number | null;
    countryId?: number;
    active?: boolean;
    name?: string;
    service?: {
      customerId?: number;
      customerTypeCode?: string;
      fromZoneId?: number;
      fromSubzoneId?: number;
      serviceId: number;
    };
  }): Promise<ZoneDropdownResponse['listZonesDropdown']> {
    const response = await this.requestWithAuth<ZoneDropdownResponse>(LIST_ZONES_QUERY, { input });
    return response.listZonesDropdown;
  }
}
