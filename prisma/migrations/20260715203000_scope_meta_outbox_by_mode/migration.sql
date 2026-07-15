DROP INDEX IF EXISTS "MetaDeliveryOutbox_eventId_key";
DROP INDEX IF EXISTS "MetaDeliveryOutbox_eventName_shopifyOrderId_key";

CREATE UNIQUE INDEX "MetaDeliveryOutbox_mode_eventId_key"
ON "MetaDeliveryOutbox"("mode", "eventId");

CREATE UNIQUE INDEX "MetaDeliveryOutbox_mode_eventName_shopifyOrderId_key"
ON "MetaDeliveryOutbox"("mode", "eventName", "shopifyOrderId");

ALTER TABLE "ShipmentRecord"
ADD COLUMN "metaDeliveryLastReason" TEXT,
ADD COLUMN "metaDeliveryLastObservedAt" TIMESTAMP(3),
ADD COLUMN "metaDeliveryLastMode" TEXT;
