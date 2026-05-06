import crypto from 'node:crypto';

export const verifyShopifyWebhook = (rawBody: Buffer, signatureHeader: string | undefined, secret: string): boolean => {
  if (!signatureHeader) return false;
  const digest = crypto.createHmac('sha256', secret).update(rawBody).digest('base64');
  return crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(signatureHeader));
};
