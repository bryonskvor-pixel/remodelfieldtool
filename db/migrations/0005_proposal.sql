-- Phase 2 slice 2: proposal builder (§9).
-- Timeline estimate is manual entry per §9 (ranges encouraged) — it never
-- existed in the 0001 proposals table. updated_at already arrived in 0003.
ALTER TABLE proposals ADD COLUMN timeline_estimate TEXT;
