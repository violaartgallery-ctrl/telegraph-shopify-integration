import dotenv from 'dotenv';

const maskToken = (token: string): string => {
  if (token.length <= 12) return `${token.slice(0, 4)}...`;
  return `${token.slice(0, 8)}...${token.slice(-4)}`;
};

interface ShopifyTokenResponse {
  access_token: string;
  scope: string;
  expires_in: number;
}

const main = async (): Promise<void> => {
  dotenv.config();

  const shopDomain = process.env.SHOPIFY_SHOP_DOMAIN;
  const clientId = process.env.SHOPIFY_CLIENT_ID;
  const clientSecret = process.env.SHOPIFY_CLIENT_SECRET;

  if (!shopDomain || !clientId || !clientSecret) {
    throw new Error('Set SHOPIFY_SHOP_DOMAIN, SHOPIFY_CLIENT_ID, and SHOPIFY_CLIENT_SECRET');
  }

  const response = await fetch(`https://${shopDomain}/admin/oauth/access_token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: clientId,
      client_secret: clientSecret
    })
  });

  if (!response.ok) {
    throw new Error(`Token request failed with ${response.status}`);
  }

  const tokenResponse = (await response.json()) as ShopifyTokenResponse;

  console.log('Shopify token generation succeeded');
  console.log(`Token: ${maskToken(tokenResponse.access_token)}`);
  console.log(`Scopes: ${tokenResponse.scope}`);
  console.log(`Expires in: ${tokenResponse.expires_in}s`);
};

main().catch((error) => {
  const message = error instanceof Error ? error.message : 'Unknown token test error';
  console.error(`Shopify token generation failed: ${message}`);
  process.exitCode = 1;
});
