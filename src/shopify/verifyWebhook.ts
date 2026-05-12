import crypto from 'node:crypto';

export const verifyShopifyWebhook = (rawBody: Buffer, signatureHeader: string | undefined, secret: string): boolean => {
  if (!signatureHeader) return false;
  const digest = crypto.createHmac('sha256', secret).update(rawBody).digest('base64');
  // BUG-SEC-1 FIX: crypto.timingSafeEqual throws RangeError when buffers differ in length.
  // A malformed or tampered X-Shopify-Hmac-Sha256 header would crash the handler (500)
  // instead of being rejected (401). Compare lengths first and return false safely.
  const digestBuf = Buffer.from(digest);
  const sigBuf = Buffer.from(signatureHeader);
  if (digestBuf.length !== sigBuf.length) return false;
  return crypto.timingSafeEqual(digestBuf, sigBuf);
};
