-- CreateTable
CREATE TABLE "WhatsappOdooLink" (
    "id" SERIAL NOT NULL,
    "accurateShipmentId" INTEGER NOT NULL,
    "accurateShipmentCode" TEXT NOT NULL,
    "carrierRefNumber" TEXT NOT NULL,
    "odooSaleOrderId" INTEGER,
    "odooSaleOrderName" TEXT,
    "matchMethod" TEXT,
    "state" TEXT NOT NULL,
    "reviewReason" TEXT,
    "reviewNotifiedAt" TIMESTAMP(3),
    "plannedAction" TEXT,
    "soAmountTotal" DOUBLE PRECISION,
    "soPartnerId" INTEGER,
    "soFingerprint" TEXT,
    "carrierStatusCode" TEXT,
    "carrierReturnStatusCode" TEXT,
    "carrierCancelled" BOOLEAN,
    "carrierCollected" BOOLEAN,
    "carrierPaidToCustomer" BOOLEAN,
    "carrierPrice" DOUBLE PRECISION,
    "collectedAmount" DOUBLE PRECISION,
    "customerDue" DOUBLE PRECISION,
    "deliveryFees" DOUBLE PRECISION,
    "returnFees" DOUBLE PRECISION,
    "returnedValue" DOUBLE PRECISION,
    "carrierFingerprint" TEXT,
    "returnObservedAt" TIMESTAMP(3),
    "returnFingerprint" TEXT,
    "merchantTarget" DOUBLE PRECISION,
    "odooInvoiceId" INTEGER,
    "odooInvoiceName" TEXT,
    "odooPaymentId" INTEGER,
    "stockDoneAt" TIMESTAMP(3),
    "invoicedAt" TIMESTAMP(3),
    "paidAt" TIMESTAMP(3),
    "returnedAt" TIMESTAMP(3),
    "matchCheckedAt" TIMESTAMP(3),
    "lastSyncedAt" TIMESTAMP(3),
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WhatsappOdooLink_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WhatsappOdooOperation" (
    "id" SERIAL NOT NULL,
    "linkId" INTEGER NOT NULL,
    "key" TEXT NOT NULL,
    "epoch" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "fingerprint" TEXT,
    "status" TEXT NOT NULL,
    "requestAttempted" BOOLEAN NOT NULL DEFAULT false,
    "reason" TEXT,
    "claimedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "WhatsappOdooOperation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "WhatsappOdooLink_accurateShipmentId_key" ON "WhatsappOdooLink"("accurateShipmentId");

-- CreateIndex
CREATE UNIQUE INDEX "WhatsappOdooLink_accurateShipmentCode_key" ON "WhatsappOdooLink"("accurateShipmentCode");

-- CreateIndex
CREATE UNIQUE INDEX "WhatsappOdooLink_odooSaleOrderId_key" ON "WhatsappOdooLink"("odooSaleOrderId");

-- CreateIndex
CREATE INDEX "WhatsappOdooLink_state_lastSyncedAt_idx" ON "WhatsappOdooLink"("state", "lastSyncedAt");

-- CreateIndex
CREATE INDEX "WhatsappOdooOperation_status_idx" ON "WhatsappOdooOperation"("status");

-- CreateIndex
CREATE UNIQUE INDEX "WhatsappOdooOperation_linkId_key_key" ON "WhatsappOdooOperation"("linkId", "key");

-- AddForeignKey
ALTER TABLE "WhatsappOdooOperation" ADD CONSTRAINT "WhatsappOdooOperation_linkId_fkey" FOREIGN KEY ("linkId") REFERENCES "WhatsappOdooLink"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

