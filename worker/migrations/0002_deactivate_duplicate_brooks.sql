-- Deactivate duplicate "Brook" rows in crm_techs so the tech picker is
-- unambiguous. The real Brook is id 6 (st_tech_id 8706). These two stray rows
-- were synced from ServiceTitan (their ids ARE ServiceTitan ids) and carried a
-- NULL st_tech_id, which would attribute logged materials to no one.
-- Reversible: this only flips is_active, it does not delete the rows.
UPDATE crm_techs SET is_active = 0 WHERE id IN (8706, 51792385);
