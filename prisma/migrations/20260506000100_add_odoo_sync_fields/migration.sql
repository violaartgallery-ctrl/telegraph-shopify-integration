-- Add Odoo sync tracking to shipment records.
ALTER TABLE "ShipmentRecord" ADD COLUMN "odooSaleOrderId" INTEGER;
ALTER TABLE "ShipmentRecord" ADD COLUMN "odooSaleOrderName" TEXT;
ALTER TABLE "ShipmentRecord" ADD COLUMN "odooInvoiceId" INTEGER;
ALTER TABLE "ShipmentRecord" ADD COLUMN "odooInvoiceName" TEXT;
ALTER TABLE "ShipmentRecord" ADD COLUMN "odooPaymentId" INTEGER;
ALTER TABLE "ShipmentRecord" ADD COLUMN "odooSyncStatus" TEXT;
ALTER TABLE "ShipmentRecord" ADD COLUMN "odooLastError" TEXT;
ALTER TABLE "ShipmentRecord" ADD COLUMN "odooSyncedAt" TIMESTAMP(3);
