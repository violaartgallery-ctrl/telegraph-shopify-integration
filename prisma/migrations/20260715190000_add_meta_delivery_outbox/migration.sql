ALTER TABLE "ShipmentRecord"
ADD COLUMN "returnedAt" TIMESTAMP(3),
ADD COLUMN "shopifyCreatedAt" TIMESTAMP(3);

CREATE TABLE "MetaDeliveryOutbox" (
    "id" SERIAL NOT NULL,
    "shipmentRecordId" INTEGER NOT NULL,
    "shopifyOrderId" TEXT NOT NULL,
    "eventName" TEXT NOT NULL DEFAULT 'Delivered',
    "eventId" TEXT NOT NULL,
    "eventTime" TIMESTAMP(3) NOT NULL,
    "source" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "payloadJson" TEXT NOT NULL,
    "payloadHash" TEXT NOT NULL,
    "matchQualityJson" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3),
    "leaseToken" TEXT,
    "leaseExpiresAt" TIMESTAMP(3),
    "lastAttemptAt" TIMESTAMP(3),
    "lastHttpStatus" INTEGER,
    "lastErrorCode" TEXT,
    "lastError" TEXT,
    "eventsReceived" INTEGER,
    "fbtraceId" TEXT,
    "sentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MetaDeliveryOutbox_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "MetaDeliveryOutbox_eventId_key"
ON "MetaDeliveryOutbox"("eventId");

CREATE UNIQUE INDEX "MetaDeliveryOutbox_eventName_shopifyOrderId_key"
ON "MetaDeliveryOutbox"("eventName", "shopifyOrderId");

CREATE INDEX "MetaDeliveryOutbox_status_nextAttemptAt_leaseExpiresAt_idx"
ON "MetaDeliveryOutbox"("status", "nextAttemptAt", "leaseExpiresAt");

CREATE INDEX "MetaDeliveryOutbox_shipmentRecordId_idx"
ON "MetaDeliveryOutbox"("shipmentRecordId");

ALTER TABLE "MetaDeliveryOutbox"
ADD CONSTRAINT "MetaDeliveryOutbox_shipmentRecordId_fkey"
FOREIGN KEY ("shipmentRecordId") REFERENCES "ShipmentRecord"("id")
ON DELETE CASCADE ON UPDATE CASCADE;
