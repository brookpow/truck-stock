-- Add ServiceTitan technician id to crm_techs for per-plumber GP attribution.
-- st_tech_id references crm_st_employees.id (the ServiceTitan employee id).
-- Mapping confirmed by name match (crm_techs emails are @ccp.local placeholders,
-- so name was the only viable key). Office (id 1) is intentionally left NULL.
ALTER TABLE crm_techs ADD COLUMN st_tech_id INTEGER;

UPDATE crm_techs SET st_tech_id = 36147118 WHERE id = 2;  -- Brad
UPDATE crm_techs SET st_tech_id = 57019529 WHERE id = 3;  -- Nicholas
UPDATE crm_techs SET st_tech_id = 73198337 WHERE id = 4;  -- Pascal
UPDATE crm_techs SET st_tech_id = 31095086 WHERE id = 5;  -- Pete
UPDATE crm_techs SET st_tech_id = 8706     WHERE id = 6;  -- Brook
UPDATE crm_techs SET st_tech_id = 71636999 WHERE id = 7;  -- Micah
UPDATE crm_techs SET st_tech_id = 57290905 WHERE id = 8;  -- Sarah
