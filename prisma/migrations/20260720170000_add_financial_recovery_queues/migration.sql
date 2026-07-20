ALTER TABLE "ShipmentRecord"
  ADD COLUMN "returnSyncStatus" TEXT,
  ADD COLUMN "returnSyncFingerprint" TEXT,
  ADD COLUMN "returnSyncAttemptCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "returnSyncRetryAt" TIMESTAMP(3),
  ADD COLUMN "returnSyncLastError" TEXT,
  ADD COLUMN "returnSyncClaimedAt" TIMESTAMP(3),
  ADD COLUMN "shopifyPaymentSyncStatus" TEXT,
  ADD COLUMN "shopifyPaymentFingerprint" TEXT,
  ADD COLUMN "shopifyPaymentAttemptCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "shopifyPaymentRetryAt" TIMESTAMP(3),
  ADD COLUMN "shopifyPaymentLastError" TEXT,
  ADD COLUMN "shopifyPaymentClaimedAt" TIMESTAMP(3),
  ADD COLUMN "shopifyPaymentSyncedAt" TIMESTAMP(3),
  ADD COLUMN "shopifyPaymentTransactionId" TEXT;

CREATE INDEX "ShipmentRecord_return_sync_queue_idx"
  ON "ShipmentRecord"("returnSyncStatus", "returnSyncRetryAt");

CREATE INDEX "ShipmentRecord_shopify_payment_queue_idx"
  ON "ShipmentRecord"("shopifyPaymentSyncStatus", "shopifyPaymentRetryAt");
