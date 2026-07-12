-- Phase 2 slice 1: bid sheets + price book join the offline sync (LWW needs
-- updated_at; line_items/price_book_items also lacked created_at).
-- cost_breakdown holds an optional {"labor": n, "material": n} split whose sum
-- is always unit_price (unit_price stays authoritative).
ALTER TABLE price_book_items ADD COLUMN updated_at TEXT;
ALTER TABLE price_book_items ADD COLUMN created_at TEXT;
ALTER TABLE bid_sheets ADD COLUMN updated_at TEXT;
ALTER TABLE line_items ADD COLUMN updated_at TEXT;
ALTER TABLE line_items ADD COLUMN created_at TEXT;
ALTER TABLE line_items ADD COLUMN cost_breakdown TEXT;
ALTER TABLE proposals ADD COLUMN updated_at TEXT;
