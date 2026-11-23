-- Lookup indexes for the queue/claim/hold reads.
-- These already exist on the live database: they were created on 2026-11-23 with
-- CREATE INDEX CONCURRENTLY (no lock, no data change). IF NOT EXISTS makes this
-- migration a no-op there and creates them on any fresh database.
-- FailedPayload.reason uses a hash index: a few values are ~12 KB, too large for btree.

-- CreateIndex
CREATE INDEX IF NOT EXISTS "viola_perf_sr_odoo_sync_idx" ON "ShipmentRecord"("odooSyncStatus", "odooRetryAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "viola_perf_sr_collection_status_idx" ON "ShipmentRecord"("collectionStatus");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "viola_perf_sr_accurate_code_idx" ON "ShipmentRecord"("accurateShipmentCode");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "viola_perf_sr_accurate_id_idx" ON "ShipmentRecord"("accurateShipmentId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "viola_perf_sr_order_name_idx" ON "ShipmentRecord"("shopifyOrderName");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "viola_perf_sr_odoo_so_idx" ON "ShipmentRecord"("odooSaleOrderId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "viola_perf_fp_source_external_idx" ON "FailedPayload"("source", "externalId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "viola_perf_fp_external_idx" ON "FailedPayload"("externalId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "viola_perf_fp_reason_hash_idx" ON "FailedPayload" USING HASH ("reason");
