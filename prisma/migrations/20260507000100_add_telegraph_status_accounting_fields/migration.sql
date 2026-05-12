-- Store raw Telegraph status/fee fields so local polling and return-charge accounting
-- do not depend on Arabic/English display names.
ALTER TABLE "ShipmentRecord" ADD COLUMN "accurateStatusCode" TEXT;
ALTER TABLE "ShipmentRecord" ADD COLUMN "accurateReturnStatusCode" TEXT;
ALTER TABLE "ShipmentRecord" ADD COLUMN "accurateIsTerminal" BOOLEAN;
ALTER TABLE "ShipmentRecord" ADD COLUMN "deliveryFees" DOUBLE PRECISION;
ALTER TABLE "ShipmentRecord" ADD COLUMN "returnFees" DOUBLE PRECISION;
ALTER TABLE "ShipmentRecord" ADD COLUMN "returningDueFees" DOUBLE PRECISION;
ALTER TABLE "ShipmentRecord" ADD COLUMN "customerDue" DOUBLE PRECISION;
ALTER TABLE "ShipmentRecord" ADD COLUMN "odooSalePaymentId" INTEGER;
ALTER TABLE "ShipmentRecord" ADD COLUMN "odooReturnBillId" INTEGER;
ALTER TABLE "ShipmentRecord" ADD COLUMN "odooReturnPaymentId" INTEGER;
