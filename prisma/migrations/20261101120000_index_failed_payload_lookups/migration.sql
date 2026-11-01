-- Job state, scheduler lanes and bot control rows are looked up by (source, reason)
-- ordered by id. A plain index build briefly blocks writes to this table only.
CREATE INDEX IF NOT EXISTS "FailedPayload_source_reason_id_idx" ON "FailedPayload"("source", "reason", "id");
