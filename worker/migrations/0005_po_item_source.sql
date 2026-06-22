-- Manual-add to the EMCO reorder. Tag each draft PO line by origin so the
-- suggested-rebuild only replaces the auto (below-par) lines and manual lines
-- persist. Additive: existing lines default to 'auto' (they were all auto).
ALTER TABLE crm_inventory_po_items ADD COLUMN source TEXT DEFAULT 'auto';
