ALTER TABLE "ShipmentRecord"
ADD COLUMN "odooCollectionSyncStatus" TEXT,
ADD COLUMN "odooCollectionFingerprint" TEXT,
ADD COLUMN "odooCollectionAttemptCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "odooCollectionRetryAt" TIMESTAMP(3),
ADD COLUMN "odooCollectionLastError" TEXT,
ADD COLUMN "odooCollectionClaimedAt" TIMESTAMP(3),
ADD COLUMN "odooCollectionSyncedAt" TIMESTAMP(3);

CREATE INDEX "ShipmentRecord_odoo_collection_queue_idx"
ON "ShipmentRecord"("odooCollectionSyncStatus", "odooCollectionRetryAt");
