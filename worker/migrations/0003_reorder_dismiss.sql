-- Per-item dismiss for the EMCO reorder suggested list.
-- A nullable timestamp on the SHOP stock row (location_id = 1). When set, the
-- /api/reorder/suggested query hides that material UNTIL the shop row changes
-- again (modified_at > reorder_dismissed_at) — i.e. it re-surfaces on the next
-- shop stock change (count correction or PO receive), per the agreed behavior.
-- Touches NO stock: this column is a view/suggestion flag only. Additive ADD
-- COLUMN (non-destructive). Stock reversals stay with the audited restock-undo.
ALTER TABLE crm_inventory_stock ADD COLUMN reorder_dismissed_at TEXT;
