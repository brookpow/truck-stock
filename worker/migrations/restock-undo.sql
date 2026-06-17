-- Restock/receive UNDO. Additive + reversible. batch_id groups every ledger leg
-- written by ONE confirm (shop->van restock) or ONE PO receive action, so undo can
-- target that batch — never the whole list. undone_at marks a leg that's been
-- reversed (blocks double-undo). Reversing legs are real ledger rows (auditable),
-- not deletes. Drop the columns to reverse.
ALTER TABLE crm_inventory_movements ADD COLUMN batch_id  TEXT;
ALTER TABLE crm_inventory_movements ADD COLUMN undone_at TEXT;
CREATE INDEX IF NOT EXISTS idx_inv_mov_batch ON crm_inventory_movements(batch_id);
