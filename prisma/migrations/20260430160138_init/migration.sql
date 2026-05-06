-- CreateTable
CREATE TABLE "ShipmentRecord" (
    "id" SERIAL NOT NULL,
    "shopifyOrderId" TEXT NOT NULL,
    "shopifyOrderNumber" TEXT NOT NULL,
    "shopifyOrderName" TEXT,
    "plannedShipmentCode" TEXT,
    "accurateShipmentId" INTEGER,
    "accurateShipmentCode" TEXT,
    "accurateStatus" TEXT,
    "accurateReturnStatus" TEXT,
    "collectionStatus" TEXT,
    "trackingUrl" TEXT,
    "collectedAmount" DOUBLE PRECISION,
    "pendingCollectionAmount" DOUBLE PRECISION,
    "returnedValue" DOUBLE PRECISION,
    "deliveredAt" TIMESTAMP(3),
    "lastSyncedAt" TIMESTAMP(3),
    "lastError" TEXT,
    "rawOrderJson" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ShipmentRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FailedPayload" (
    "id" SERIAL NOT NULL,
    "source" TEXT NOT NULL,
    "externalId" TEXT,
    "reason" TEXT NOT NULL,
    "payloadJson" TEXT NOT NULL,
    "headersJson" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FailedPayload_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ShipmentSequence" (
    "name" TEXT NOT NULL,
    "nextValue" INTEGER NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ShipmentSequence_pkey" PRIMARY KEY ("name")
);

-- CreateIndex
CREATE UNIQUE INDEX "ShipmentRecord_shopifyOrderId_key" ON "ShipmentRecord"("shopifyOrderId");

-- CreateIndex
CREATE UNIQUE INDEX "ShipmentRecord_plannedShipmentCode_key" ON "ShipmentRecord"("plannedShipmentCode");
