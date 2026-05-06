import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';

interface ShopifyTokenResponse {
  access_token: string;
  scope: string;
  expires_in: number;
}

const refreshBufferMs = 5 * 60 * 1000;

export class ShopifyAuth {
  private accessToken?: string;
  private scope?: string;
  private expiresAt = 0;

  async getAccessToken(): Promise<string> {
    if (this.accessToken && Date.now() < this.expiresAt - refreshBufferMs) {
      return this.accessToken;
    }

    const response = await fetch(`https://${env.shopify.shopDomain}/admin/oauth/access_token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: env.shopify.clientId,
        client_secret: env.shopify.clientSecret
      })
    });

    if (!response.ok) {
      throw new Error(`Shopify token request failed with ${response.status}`);
    }

    const tokenResponse = (await response.json()) as ShopifyTokenResponse;
    this.accessToken = tokenResponse.access_token;
    this.scope = tokenResponse.scope;
    this.expiresAt = Date.now() + tokenResponse.expires_in * 1000;

    logger.info('Generated Shopify Admin API token', {
      scope: this.scope,
      expiresIn: tokenResponse.expires_in
    });

    return this.accessToken;
  }

  clearCachedToken(): void {
    this.accessToken = undefined;
    this.scope = undefined;
    this.expiresAt = 0;
  }

  getCachedScope(): string | undefined {
    return this.scope;
  }
}

export const shopifyAuth = new ShopifyAuth();
