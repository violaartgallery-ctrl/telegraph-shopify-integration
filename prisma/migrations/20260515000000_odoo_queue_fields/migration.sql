-- Add Odoo background queue tracking fields
ALTER TABLE "ShipmentRecord" ADD COLUMN "odooAttemptCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "ShipmentRecord" ADD COLUMN "odooRetryAt" TIMESTAMP(3);
