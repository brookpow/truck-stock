-- Pipe / by-the-foot (Phase 1) — additive catalog columns. All nullable / default
-- 0, so the ~300 normal each-items are completely untouched (NULL length_ft,
-- track_by_foot=0, NULL override → behave exactly as today).
--   track_by_foot          1 = priced/logged by the foot, exempt from stock
--                          deduction + below-par auto-logic. 0 = normal each-item.
--   length_ft              stick length in feet (e.g. 12). Set once per pipe item.
--   cost_per_foot_override explicit per-foot cost; used ONLY when set. Otherwise
--                          effective per-foot = cost / length_ft (the derivation).
ALTER TABLE crm_materials ADD COLUMN track_by_foot INTEGER DEFAULT 0;
ALTER TABLE crm_materials ADD COLUMN length_ft REAL;
ALTER TABLE crm_materials ADD COLUMN cost_per_foot_override REAL;
