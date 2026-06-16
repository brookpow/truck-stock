-- Phase 1 scan diagnostics. Additive, read-only-safe: the scan endpoint writes a
-- log row per scan (raw model output + which failure path + a pointer to the image
-- in R2) so we can SEE the real failure mix before building Phase 2. Logging is
-- best-effort and never alters the scan response. Drop the table to reverse.
CREATE TABLE IF NOT EXISTS ts_scan_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at  TEXT DEFAULT (datetime('now')),
  job_id      TEXT,
  tech_id     INTEGER,
  outcome     TEXT,        -- success | success_truncated | parse_failed | vision_unavailable | network
  http_status INTEGER,     -- Anthropic HTTP status (null on network error)
  stop_reason TEXT,        -- Anthropic stop_reason: end_turn | max_tokens | ...
  model       TEXT,
  source_type TEXT,        -- parsed source_type: wholesaler | retail | unknown
  supplier    TEXT,
  item_count  INTEGER,
  raw_len     INTEGER,     -- full length of the model's raw text
  raw_output  TEXT,        -- raw text, capped ~12KB
  image_key   TEXT,        -- R2 key (scan-log/<uuid>.jpg) of the image we sent
  image_bytes INTEGER
);
