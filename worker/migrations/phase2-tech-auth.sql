-- Phase 2 tech auth (T1). Additive + reversible. PINs live on crm_techs next to
-- the tech identity the office already manages; ts_auth (office/gp) is untouched.
-- Reverse: the columns can be dropped / ignored; token_version bump revokes.
ALTER TABLE crm_techs ADD COLUMN pin_hash TEXT;                                 -- PBKDF2 salt:hash (same format as ts_auth)
ALTER TABLE crm_techs ADD COLUMN token_version INTEGER NOT NULL DEFAULT 1;      -- bump to revoke ALL of a tech's devices
ALTER TABLE crm_techs ADD COLUMN pin_set_at TEXT;
ALTER TABLE crm_techs ADD COLUMN pin_fail_count INTEGER NOT NULL DEFAULT 0;     -- consecutive wrong PINs
ALTER TABLE crm_techs ADD COLUMN pin_locked_until TEXT;                         -- ISO time; NULL = unlocked

-- Light global brute-force throttle: rolling 1-minute window per client IP.
CREATE TABLE IF NOT EXISTS ts_login_attempts (
  ip           TEXT PRIMARY KEY,
  count        INTEGER NOT NULL DEFAULT 0,
  window_start TEXT
);
