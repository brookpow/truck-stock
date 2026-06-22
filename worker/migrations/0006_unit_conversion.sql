-- Generalize pipe by-the-foot → unit-conversion model (purchase unit ≠ use unit).
-- Forward reshape of 0004's pipe-specific columns. Additive defaults keep the ~300
-- normal each-items at each/each/×1/deduct=yes (unchanged). No real by-the-foot
-- usage exists yet, so migrating the 12 pipe rows is clean.
--
-- Two independent knobs:
--   conversion_factor : use-units per purchase-unit (drives per-use COSTING)
--   deduct_on_use     : 1 = usage deducts stock + auto-reorder; 0 = cost-only + manual
ALTER TABLE crm_materials ADD COLUMN purchase_unit TEXT DEFAULT 'each';
ALTER TABLE crm_materials ADD COLUMN use_unit TEXT DEFAULT 'each';
ALTER TABLE crm_materials ADD COLUMN conversion_factor REAL DEFAULT 1;
ALTER TABLE crm_materials ADD COLUMN cost_per_use_override REAL;
ALTER TABLE crm_materials ADD COLUMN deduct_on_use INTEGER DEFAULT 1;

-- Migrate the pipe items: track_by_foot ⇒ convert (×length_ft) + cost-only (deduct=0).
UPDATE crm_materials
   SET conversion_factor    = length_ft,
       cost_per_use_override = cost_per_foot_override,
       use_unit             = 'ft',
       purchase_unit        = 'length',
       deduct_on_use        = 0
 WHERE track_by_foot = 1;

-- Drop the pipe-specific columns (D1/SQLite supports DROP COLUMN; no index/FK on them).
ALTER TABLE crm_materials DROP COLUMN track_by_foot;
ALTER TABLE crm_materials DROP COLUMN length_ft;
ALTER TABLE crm_materials DROP COLUMN cost_per_foot_override;
