// Truck-stock worker — CRITICAL PATH ONLY (the shortest route to unblocking GP).
//
// Three endpoints:
//   GET  /api/materials/search?q=elbow   -> search-as-you-type over crm_materials
//   POST /api/jobs/:jobId/materials       -> log a used material to crm_job_materials
//   GET  /api/jobs/:jobId/materials       -> list materials logged on a job
//
// Stock deduction, restock lists, pull lists, POs are deliberately NOT here yet.
// They don't block gross profit. Add them after capture is proven.
//
// IMPORTANT — verify column names before trusting this in production:
//   The confirmed columns we built against are:
//     crm_materials:     id, code, emco_sku, name, cost, price, vendor, vendor_sku
//     crm_job_materials: id, job_id, job_number, material_id, quantity,
//                        unit_cost, total_cost, tech_id, truck_location_id
//   If your real schema differs, Claude Code should run PRAGMA table_info on both
//   and adjust the column names below. Marked with  // VERIFY  comments.

import { authenticate, signJWT, verifyPassword, hashPassword } from "./auth.js";

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...cors() },
  });

const cors = () => ({
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,PATCH,DELETE,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Expose-Headers": "X-TS-Token",   // refresh-on-use token for the tech app
});

// Pacific (America/Vancouver) calendar day as UTC bounds, DST-correct.
// crm_st_appointments.start_date is stored UTC ISO ("2026-06-09T15:00:00Z");
// a tech's "today" is the Pacific day, so we return [midnight, next-midnight)
// Pacific expressed in UTC for a simple range filter on start_date.
// Provenance tag GP depends on: matched receipt-purchase lines carry this exact
// string in crm_job_materials.notes so GP EXCLUDES them from material-cost sums
// (option A — the receipt's tax-included receipt_total is the cost of record).
// Single-sourced here: POST sets it, GET/DELETE match it. Do NOT change the
// format — GP filters with: notes IS NULL OR notes NOT LIKE 'receipt purchase #%'.
const RECEIPT_TAG_PREFIX = "receipt purchase #";
const receiptTag = (purchaseId) => RECEIPT_TAG_PREFIX + purchaseId;
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

// ── Phase 2 tech auth (T1: endpoints live, tech-write enforcement OFF) ──
const TECH_TOKEN_TTL = 2592000;        // 30 days
const TECH_REFRESH_AFTER = 1296000;    // re-issue once a token is past half-life (15d)
const PIN_MAX_FAILS = 5, PIN_LOCK_MINUTES = 15;
const IP_WINDOW_SEC = 60, IP_MAX_ATTEMPTS = 30;

// Verify a Bearer token as a TECH token: account:'tech' AND token_version still
// matches crm_techs (a revoke bump invalidates every device) AND the tech is
// active. Returns { payload, refresh, fresh } or null. `fresh` is a re-signed 30d
// token when the current one is past half-life — surfaced via the X-TS-Token header.
async function techAuth(request, env) {
  const payload = await authenticate(request, env);
  if (!payload || payload.account !== "tech" || payload.tech_id == null) return null;
  const row = await env.DB.prepare(`SELECT token_version, is_active, name FROM crm_techs WHERE st_tech_id = ?`).bind(payload.tech_id).first();
  if (!row || row.is_active !== 1) return null;                       // deactivated → token dead
  if ((row.token_version || 1) !== (payload.tv || 1)) return null;    // revoked (version bumped)
  let refresh = false, fresh = null;
  const now = Math.floor(Date.now() / 1000);
  if (payload.iat && now - payload.iat > TECH_REFRESH_AFTER && env.TS_JWT_SECRET) {
    fresh = await signJWT({ account: "tech", tech_id: payload.tech_id, name: row.name, tv: row.token_version || 1 }, env.TS_JWT_SECRET, TECH_TOKEN_TTL);
    refresh = true;
  }
  return { payload, refresh, fresh };
}

const clientIp = (request) => request.headers.get("CF-Connecting-IP") || "unknown";

// Light global throttle: rolling 60s window per IP, max 30 login attempts.
// true = allowed, false = over the limit.
async function ipAllow(env, ip) {
  const nowIso = new Date().toISOString();
  const row = await env.DB.prepare(`SELECT count, window_start FROM ts_login_attempts WHERE ip = ?`).bind(ip).first();
  const within = row && row.window_start && (Date.now() - Date.parse(row.window_start)) < IP_WINDOW_SEC * 1000;
  if (!within) { await env.DB.prepare(`INSERT INTO ts_login_attempts (ip,count,window_start) VALUES (?,1,?) ON CONFLICT(ip) DO UPDATE SET count=1, window_start=excluded.window_start`).bind(ip, nowIso).run(); return true; }
  if ((row.count || 0) >= IP_MAX_ATTEMPTS) return false;
  await env.DB.prepare(`UPDATE ts_login_attempts SET count = count + 1 WHERE ip = ?`).bind(ip).run();
  return true;
}

// Office-token gate for the admin (Techs & PINs) endpoints. The office app attaches
// its Bearer on every call, so this is safe in T1 and doesn't strand techs.
async function officeAuth(request, env) {
  const payload = await authenticate(request, env);
  return payload && payload.account === "office" ? payload : null;
}

// Shared shop(loc 1) -> van transfer. ONE atomic batch: van on_hand += qty +
// transfer_in, shop on_hand -= qty + transfer_out. PURE inventory — no purchase,
// no crm_job_materials line. Used by BOTH the office restock confirm (pull_shop)
// and the tech from-shop restock. Returns a per-item result row. opts:
//   autoCreateVan   — create the van stock row at on_hand 0 if missing (tech adds
//                     a material not yet on the van). Office leaves it required.
//   reportShortfall — include shop_shortfall when shop < qty (shop goes negative).
//   note            — movement note (defaults to the office wording).
async function pullShopToVan(env, vanId, mid, qty, operator, ref, opts = {}) {
  const WAREHOUSE_ID = 1; // Shop Warehouse (loc 1)
  if (mid == null) throw new Error("material_id required");
  if (!(qty > 0)) throw new Error("qty required for a pull");
  const note = opts.note || "restock pull (shop->van)";

  const whRow = await env.DB.prepare(
    `SELECT id, on_hand FROM crm_inventory_stock WHERE location_id = ? AND material_id = ?`
  ).bind(WAREHOUSE_ID, mid).first();
  if (!whRow) {
    // Can't pull what the shop doesn't track. Office throws (caught -> failed);
    // tech flags it so the tech sees why nothing moved.
    if (opts.autoCreateVan) return { material_id: mid, result: "shop_untracked", quantity: qty };
    throw new Error("no warehouse stock row");
  }

  let vanRow = await env.DB.prepare(
    `SELECT id, on_hand FROM crm_inventory_stock WHERE location_id = ? AND material_id = ?`
  ).bind(vanId, mid).first();
  if (!vanRow) {
    if (!opts.autoCreateVan) throw new Error("no van stock row");
    // Tech grabbed a material not yet on their van — add the row at 0 (no par).
    const ins = await env.DB.prepare(
      `INSERT INTO crm_inventory_stock (location_id, material_id, on_hand, min_qty, max_qty) VALUES (?,?,0,0,0)`
    ).bind(vanId, mid).run();
    vanRow = { id: ins.meta?.last_row_id, on_hand: 0 };
  }

  const shopBefore = whRow.on_hand ?? 0;
  const batchId = opts.batchId ?? null;   // groups every leg of one confirm action (for undo)
  await env.DB.batch([
    env.DB.prepare(`UPDATE crm_inventory_stock SET on_hand = ?, last_restocked = datetime('now'), modified_at = datetime('now') WHERE id = ?`)
      .bind((vanRow.on_hand ?? 0) + qty, vanRow.id),
    env.DB.prepare(`INSERT INTO crm_inventory_movements (material_id, location_id, qty_change, reason, reference_id, notes, created_by, batch_id) VALUES (?,?,?,?,?,?,?,?)`)
      .bind(mid, vanId, qty, "transfer_in", ref, note, operator, batchId),
    env.DB.prepare(`UPDATE crm_inventory_stock SET on_hand = ?, modified_at = datetime('now') WHERE id = ?`)
      .bind(shopBefore - qty, whRow.id),   // shop may go negative — recount/reorder signal
    env.DB.prepare(`INSERT INTO crm_inventory_movements (material_id, location_id, qty_change, reason, reference_id, notes, created_by, batch_id) VALUES (?,?,?,?,?,?,?,?)`)
      .bind(mid, WAREHOUSE_ID, -qty, "transfer_out", ref, note, operator, batchId),
  ]);

  const out = { material_id: mid, result: "pulled_shop", quantity: qty };
  if (opts.reportShortfall && shopBefore < qty) out.shop_shortfall = qty - shopBefore;
  return out;
}

// Reverse ONE batch (a shop->van confirm/restock, or a PO-receive action) — or a
// single line of it (materialId). Writes REVERSING ledger legs (never deletes),
// restores on_hand, and for PO receive decrements qty_received + recomputes PO
// status. Idempotent: undone_at blocks double-undo. Returns a summary + warnings
// (e.g. on_hand went negative because stock was used/moved since the restock).
async function undoBatch(env, batchId, { materialId = null, operator = 8 } = {}) {
  if (!batchId) return { ok: false, error: "batch_id required" };
  const binds = materialId != null ? [batchId, materialId] : [batchId];
  const legs = (await env.DB.prepare(
    `SELECT id, material_id, location_id, qty_change, reason, reference_id
       FROM crm_inventory_movements
      WHERE batch_id = ? AND undone_at IS NULL
        ${materialId != null ? "AND material_id = ?" : ""}`
  ).bind(...binds).all()).results || [];
  // Only reversible restock/receive legs (ignore anything else that shares the id).
  const work = legs.filter((l) => ["transfer_in", "transfer_out", "po_receive"].includes(l.reason));
  if (!work.length) return { ok: false, error: "nothing_to_undo", message: "already undone, or no such batch/line" };

  const revBatch = `undo:${batchId}`;
  const warnings = [], poIds = new Set(), stmts = [];
  for (const leg of work) {
    const reverseQty = -leg.qty_change;   // opposite sign restores stock
    const srow = await env.DB.prepare(
      `SELECT id, on_hand FROM crm_inventory_stock WHERE location_id=? AND material_id=?`
    ).bind(leg.location_id, leg.material_id).first();
    if (srow) {
      const after = (srow.on_hand ?? 0) + reverseQty;
      stmts.push(env.DB.prepare(`UPDATE crm_inventory_stock SET on_hand=?, modified_at=datetime('now') WHERE id=?`).bind(after, srow.id));
      if (after < 0) warnings.push({ material_id: leg.material_id, location_id: leg.location_id, on_hand_after: after, note: "stock went negative — some was used or moved since this restock" });
    }
    const revReason = leg.reason === "transfer_in" ? "transfer_out"
                    : leg.reason === "transfer_out" ? "transfer_in"
                    : "manual";   // po_receive: CHECK has no po_unreceive
    if (leg.reason === "po_receive") poIds.add(leg.reference_id);
    stmts.push(env.DB.prepare(
      `INSERT INTO crm_inventory_movements (material_id, location_id, qty_change, reason, reference_id, notes, created_by, batch_id)
       VALUES (?,?,?,?,?,?,?,?)`
    ).bind(leg.material_id, leg.location_id, reverseQty, revReason, leg.reference_id, `undo of batch ${batchId}`, operator, revBatch));
    if (leg.reason === "po_receive") {
      stmts.push(env.DB.prepare(
        `UPDATE crm_inventory_po_items SET qty_received = MAX(0, COALESCE(qty_received,0) - ?) WHERE po_id=? AND material_id=?`
      ).bind(leg.qty_change, leg.reference_id, leg.material_id));
    }
    stmts.push(env.DB.prepare(`UPDATE crm_inventory_movements SET undone_at=datetime('now') WHERE id=?`).bind(leg.id));
  }
  await env.DB.batch(stmts);

  // Recompute status for any PO whose receive was reversed.
  const po = [];
  for (const poId of poIds) {
    const lines = (await env.DB.prepare(`SELECT qty_ordered, qty_received FROM crm_inventory_po_items WHERE po_id=?`).bind(poId).all()).results || [];
    const received = lines.reduce((a, l) => a + (l.qty_received ?? 0), 0);
    const anyOut = lines.some((l) => (l.qty_received ?? 0) < l.qty_ordered);
    const status = received <= 0 ? "Sent" : (anyOut ? "Partial" : "Received");
    if (status === "Received") await env.DB.prepare(`UPDATE crm_inventory_purchase_orders SET status='Received', received_at=datetime('now') WHERE id=?`).bind(poId).run();
    else await env.DB.prepare(`UPDATE crm_inventory_purchase_orders SET status=?, received_at=NULL WHERE id=?`).bind(status, poId).run();
    po.push({ po_id: poId, status });
  }
  return { ok: true, batch_id: batchId, legs_reversed: work.length, reversing_batch: revBatch, warnings, po };
}

// ── Reorder PO coverage naming ──────────────────────────────────────────────
// A PO's human label = the window of usage it refills: "since the last order →
// today". The START date is stamped into po.notes at draft creation (the prior
// order's date); the END is the PO's sent/received date, or today while it's
// still a draft. Renders as "Jun 28 – Jul 3" (single day → "Jul 3"; cross-year
// shows the year).
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function poCoverageName(notesStart, endTs) {
  const s = String(notesStart || "").slice(0, 10);
  if (!/^\d{4}-\d\d-\d\d$/.test(s)) return null;                 // notes doesn't hold a date → no label
  const e = String(endTs || "").slice(0, 10) || s;
  const lbl = (d) => { const [, m, day] = d.split("-").map(Number); return `${MON[m - 1]} ${day}`; };
  if (s === e) return lbl(s);
  const sy = s.slice(0, 4), ey = e.slice(0, 4);
  return sy === ey ? `${lbl(s)} – ${lbl(e)}` : `${lbl(s)} '${sy.slice(2)} – ${lbl(e)} '${ey.slice(2)}`;
}
// Label from a PO row (draft end = today). Row needs {notes, sent_at, received_at}.
function poName(row) {
  return poCoverageName(row.notes, row.sent_at || row.received_at || new Date().toISOString());
}
async function poNameFor(env, poId) {
  const r = await env.DB.prepare(`SELECT notes, sent_at, received_at FROM crm_inventory_purchase_orders WHERE id=?`).bind(poId).first();
  return r ? poName(r) : null;
}
// The coverage START for a NEW draft = the most recent prior order's date.
async function reorderCoverStart(env) {
  const prev = await env.DB.prepare(
    `SELECT MAX(COALESCE(sent_at, created_at)) AS ts FROM crm_inventory_purchase_orders WHERE status IN ('Sent','Partial','Received')`
  ).first();
  return (prev && prev.ts) ? String(prev.ts).slice(0, 10) : new Date().toISOString().slice(0, 10);
}

function pacificDayBoundsUTC(now = new Date()) {
  const dayStr = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Vancouver" }).format(now);
  const wall = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Vancouver", hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(now).reduce((a, x) => ((a[x.type] = x.value), a), {});
  const asIfUTC = Date.UTC(+wall.year, +wall.month - 1, +wall.day, +wall.hour % 24, +wall.minute, +wall.second);
  const offsetMs = asIfUTC - now.getTime();                 // -7h PDT / -8h PST
  const startMs = Date.parse(`${dayStr}T00:00:00Z`) - offsetMs;
  const iso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
  return { dayStr, start: iso(startMs), end: iso(startMs + 86400000) };
}

// ---- Stock read/write for ANY location (shop or a van) -------------------
// One implementation behind both /api/shop/stock (loc 1) and
// /api/locations/:id/stock (vans). The movement is bound to the GIVEN location.

// Full stock for a location, joined to the catalog, grouped by category.
async function getLocationStock(env, locationId) {
  const r = await env.DB.prepare(
    `SELECT s.material_id, m.name, m.emco_sku, m.category, m.bin_location,
            s.on_hand, s.min_qty, s.max_qty, s.last_counted
       FROM crm_inventory_stock s
       JOIN crm_materials m ON m.id = s.material_id
      WHERE s.location_id = ?
      ORDER BY m.category, m.name`
  ).bind(locationId).all();
  return r.results || [];
}

// Batch-apply counts + thresholds to a location, per item, atomic + non-fatal:
//   on_hand provided -> set it, stamp last_counted; if it CHANGED, write a
//     count_adjust movement (qty_change = counted - current) at THIS location,
//     in the same batch so stock + ledger never diverge.
//   min_qty/max_qty provided -> updated directly (thresholds are settings, not
//     stock movements — NO movement row).
// `note` labels the movement (e.g. "van count" / "shop count").
async function saveLocationStock(env, locationId, items, operator, note) {
  const num = (v) => (v != null && v !== "" ? Number(v) : undefined);
  const results = [];
  for (const it of items) {
    const mid = it.material_id;
    try {
      if (mid == null) throw new Error("material_id required");
      const row = await env.DB.prepare(
        `SELECT id, on_hand, min_qty, max_qty FROM crm_inventory_stock
          WHERE location_id = ? AND material_id = ?`
      ).bind(locationId, mid).first();
      if (!row) throw new Error("no stock row at this location");

      const countVal = num(it.on_hand);            // undefined if not counting
      const hasCount = countVal !== undefined;
      const newMin = num(it.min_qty) ?? row.min_qty;
      const newMax = num(it.max_qty) ?? row.max_qty;
      const newOnHand = hasCount ? countVal : (row.on_hand ?? 0);
      if (hasCount && !Number.isFinite(newOnHand)) throw new Error("on_hand not a number");
      if (!Number.isFinite(newMin) || !Number.isFinite(newMax)) throw new Error("min/max not a number");

      const delta = newOnHand - (row.on_hand ?? 0);
      const countChanged = hasCount && delta !== 0;          // movement only when it moved
      const minMaxChanged = newMin !== row.min_qty || newMax !== row.max_qty;

      if (!hasCount && !minMaxChanged) {
        results.push({ material_id: mid, result: "unchanged",
          on_hand: row.on_hand, min_qty: row.min_qty, max_qty: row.max_qty });
        continue;
      }

      const stamp = hasCount ? ", last_counted = datetime('now')" : "";
      const upd = env.DB.prepare(
        `UPDATE crm_inventory_stock
            SET on_hand = ?, min_qty = ?, max_qty = ?${stamp}, modified_at = datetime('now')
          WHERE id = ?`
      ).bind(newOnHand, newMin, newMax, row.id);

      if (countChanged) {
        await env.DB.batch([
          upd,
          env.DB.prepare(
            `INSERT INTO crm_inventory_movements
               (material_id, location_id, qty_change, reason, reference_id, notes, created_by)
             VALUES (?,?,?,?,?,?,?)`
          ).bind(mid, locationId, delta, "count_adjust", null, note, operator),
        ]);
      } else {
        await upd.run();
      }

      results.push({ material_id: mid, result: hasCount ? "counted" : "updated",
        delta: countChanged ? delta : 0, on_hand: newOnHand, min_qty: newMin, max_qty: newMax });
    } catch (e) {
      results.push({ material_id: mid, result: "failed", error: String(e.message || e) });
    }
  }
  return results;
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null, { headers: cors() });
    // Verify the tech token ONCE per request (account:'tech', token_version, active).
    // null in T1 when a tech hasn't logged in yet — writes then fall back to b.tech_id.
    const techTok = await techAuth(request, env);
    const run = async () => {
    const url = new URL(request.url);
    const p = url.pathname;

    try {
      // --- Auth (self-contained TS auth; TS_JWT_SECRET, isolated from the CRM) ---
      // POST /api/auth/login { account, password } -> { token } signed with
      // TS_JWT_SECRET, verified against ts_auth (PBKDF2). Issuer for BOTH the
      // office and gp shared logins.
      if (p === "/api/auth/login" && request.method === "POST") {
        const b = await request.json().catch(() => ({}));
        const account = String(b.account || "").trim().toLowerCase();
        const password = String(b.password || "");
        if (!account || !password) return json({ error: "account and password required" }, 400);
        if (!env.TS_JWT_SECRET) return json({ error: "auth_not_configured" }, 503);
        const row = await env.DB.prepare(`SELECT password_hash FROM ts_auth WHERE account = ?`).bind(account).first();
        if (!row || !(await verifyPassword(password, row.password_hash))) {
          return json({ error: "invalid_credentials" }, 401);
        }
        return json({ ok: true, account, token: await signJWT({ account, typ: "ts" }, env.TS_JWT_SECRET) });
      }

      // GET /api/whoami -> the token's account (S2/S3 verify point; no enforcement).
      if (p === "/api/whoami" && request.method === "GET") {
        const payload = await authenticate(request, env);
        if (!payload) return json({ error: "unauthenticated" }, 401);
        return json({ ok: true, account: payload.account, typ: payload.typ, tech_id: payload.tech_id ?? null });
      }

      // ── Phase 2 tech auth (T1 — live, but tech-write enforcement is OFF) ──

      // GET /api/auth/tech-list -> active techs WITH a PIN set (the name picker).
      if (p === "/api/auth/tech-list" && request.method === "GET") {
        const r = await env.DB.prepare(
          `SELECT st_tech_id, name FROM crm_techs
            WHERE is_active = 1 AND pin_hash IS NOT NULL AND st_tech_id IS NOT NULL ORDER BY name`
        ).all();
        return json({ techs: r.results || [] });
      }

      // POST /api/auth/tech-login { tech_id, pin } -> { token } (account:'tech', 30d).
      // Per-tech lockout (5 fails -> 15 min) + light global IP throttle.
      if (p === "/api/auth/tech-login" && request.method === "POST") {
        if (!env.TS_JWT_SECRET) return json({ error: "auth_not_configured" }, 503);
        if (!(await ipAllow(env, clientIp(request)))) return json({ error: "too_many_attempts", retry_after_sec: IP_WINDOW_SEC }, 429);
        const b = await request.json().catch(() => ({}));
        const techId = parseInt(b.tech_id, 10);
        const pin = String(b.pin || "");
        if (!Number.isFinite(techId) || !/^\d{4}$/.test(pin)) return json({ error: "tech_id and 4-digit pin required" }, 400);
        const row = await env.DB.prepare(
          `SELECT st_tech_id, name, pin_hash, is_active, token_version, pin_fail_count, pin_locked_until FROM crm_techs WHERE st_tech_id = ?`
        ).bind(techId).first();
        if (!row || row.is_active !== 1 || !row.pin_hash) return json({ error: "invalid_credentials" }, 401);
        if (row.pin_locked_until && Date.parse(row.pin_locked_until) > Date.now()) return json({ error: "locked", locked_until: row.pin_locked_until }, 423);
        if (!(await verifyPassword(pin, row.pin_hash))) {
          const fails = (row.pin_fail_count || 0) + 1;
          const lockTo = fails >= PIN_MAX_FAILS ? new Date(Date.now() + PIN_LOCK_MINUTES * 60000).toISOString() : null;
          await env.DB.prepare(`UPDATE crm_techs SET pin_fail_count = ?, pin_locked_until = ? WHERE st_tech_id = ?`).bind(lockTo ? 0 : fails, lockTo, techId).run();
          return json(lockTo ? { error: "locked", locked_until: lockTo } : { error: "invalid_credentials", attempts_left: PIN_MAX_FAILS - fails }, lockTo ? 423 : 401);
        }
        await env.DB.prepare(`UPDATE crm_techs SET pin_fail_count = 0, pin_locked_until = NULL WHERE st_tech_id = ?`).bind(techId).run();
        const token = await signJWT({ account: "tech", tech_id: techId, name: row.name, tv: row.token_version || 1 }, env.TS_JWT_SECRET, TECH_TOKEN_TTL);
        return json({ ok: true, token, tech: { st_tech_id: techId, name: row.name } });
      }

      // GET /api/auth/tech-refresh -> fresh 30d token (tech app calls on open).
      if (p === "/api/auth/tech-refresh" && request.method === "GET") {
        if (!techTok) return json({ error: "unauthenticated" }, 401);
        const token = await signJWT({ account: "tech", tech_id: techTok.payload.tech_id, name: techTok.payload.name, tv: techTok.payload.tv }, env.TS_JWT_SECRET, TECH_TOKEN_TTL);
        return json({ ok: true, token });
      }

      // ── Office "Techs & PINs" admin (office token required) ──
      if (p === "/api/admin/techs" && request.method === "GET") {
        if (!(await officeAuth(request, env))) return json({ error: "office_auth_required" }, 401);
        const r = await env.DB.prepare(
          `SELECT st_tech_id, name, is_active, (pin_hash IS NOT NULL) AS has_pin, pin_set_at, pin_locked_until, token_version
             FROM crm_techs WHERE st_tech_id IS NOT NULL ORDER BY is_active DESC, name`
        ).all();
        const now = Date.now();
        return json({ techs: (r.results || []).map((t) => ({ ...t, locked: !!(t.pin_locked_until && Date.parse(t.pin_locked_until) > now) })) });
      }

      const adminPin = p.match(/^\/api\/admin\/techs\/(\d+)\/pin$/);
      if (adminPin && request.method === "POST") {
        if (!(await officeAuth(request, env))) return json({ error: "office_auth_required" }, 401);
        const techId = parseInt(adminPin[1], 10);
        const b = await request.json().catch(() => ({}));
        const pin = String(b.pin || "");
        if (!/^\d{4}$/.test(pin)) return json({ error: "pin must be 4 digits" }, 400);
        const row = await env.DB.prepare(`SELECT st_tech_id FROM crm_techs WHERE st_tech_id = ?`).bind(techId).first();
        if (!row) return json({ error: "tech_not_found" }, 404);
        const hash = await hashPassword(pin);
        // Setting/resetting a PIN clears any lockout + fail count.
        await env.DB.prepare(`UPDATE crm_techs SET pin_hash = ?, pin_set_at = datetime('now'), pin_fail_count = 0, pin_locked_until = NULL WHERE st_tech_id = ?`).bind(hash, techId).run();
        return json({ ok: true, st_tech_id: techId });
      }

      const adminActive = p.match(/^\/api\/admin\/techs\/(\d+)\/active$/);
      if (adminActive && request.method === "POST") {
        if (!(await officeAuth(request, env))) return json({ error: "office_auth_required" }, 401);
        const techId = parseInt(adminActive[1], 10);
        const b = await request.json().catch(() => ({}));
        const active = b.active ? 1 : 0;
        await env.DB.prepare(`UPDATE crm_techs SET is_active = ? WHERE st_tech_id = ?`).bind(active, techId).run();
        return json({ ok: true, st_tech_id: techId, is_active: active });
      }

      const adminRevoke = p.match(/^\/api\/admin\/techs\/(\d+)\/revoke$/);
      if (adminRevoke && request.method === "POST") {
        if (!(await officeAuth(request, env))) return json({ error: "office_auth_required" }, 401);
        const techId = parseInt(adminRevoke[1], 10);
        // Bump token_version -> every existing device token for this tech fails next request.
        await env.DB.prepare(`UPDATE crm_techs SET token_version = token_version + 1 WHERE st_tech_id = ?`).bind(techId).run();
        const row = await env.DB.prepare(`SELECT token_version FROM crm_techs WHERE st_tech_id = ?`).bind(techId).first();
        return json({ ok: true, st_tech_id: techId, token_version: row?.token_version });
      }

      // ── ServiceTitan sync health (office banner). The crm-worker's */10 incremental
      // sync writes an 'st-incremental' heartbeat row each run; if that heartbeat is
      // older than the threshold, the sync has stalled (this is exactly the silent
      // stall we got bitten by). We key on the HEARTBEAT, not per-table synced_at,
      // because a low-churn table (customers) can legitimately look stale during a
      // quiet period — the heartbeat fires every run regardless of changes. Before
      // the crm-worker fix ships there's no heartbeat yet, so we fall back to jobs'
      // freshness (high-churn) to avoid a false alarm on day one.
      if (p === "/api/admin/sync-health" && request.method === "GET") {
        if (!(await officeAuth(request, env))) return json({ error: "office_auth_required" }, 401);
        const STALE_MIN = 30;
        const minsAgo = (ts) => ts == null ? null : Math.round((Date.now() - Date.parse(String(ts).replace(" ", "T") + "Z")) / 60000);
        const hb = await env.DB.prepare(`SELECT MAX(finished_at) AS t FROM crm_st_sync_log WHERE entity='st-incremental'`).first();
        const heartbeat_min = minsAgo(hb?.t);
        const ent = (await env.DB.prepare(
          `SELECT 'jobs' AS e, MAX(synced_at) AS t FROM crm_st_jobs
           UNION ALL SELECT 'appointments', MAX(synced_at) FROM crm_st_appointments
           UNION ALL SELECT 'customers', MAX(synced_at) FROM crm_st_customers
           UNION ALL SELECT 'assignments', MAX(synced_at) FROM crm_st_appointment_assignments`
        ).all()).results || [];
        const entities = ent.map((r) => ({ entity: r.e, last_synced: r.t, minutes_ago: minsAgo(r.t) }));
        const jobsMin = entities.find((x) => x.entity === "jobs")?.minutes_ago;
        // Heartbeat present → trust it. No heartbeat yet (pre-fix) → fall back to jobs.
        const systemic = heartbeat_min != null ? heartbeat_min > STALE_MIN
                       : (jobsMin != null && jobsMin > 60);
        const reason = heartbeat_min != null
          ? `the */10 incremental sync last ran ${heartbeat_min} min ago`
          : (systemic ? `no sync heartbeat and jobs last changed ${jobsMin} min ago` : null);
        return json({ stale_threshold_min: STALE_MIN, heartbeat_minutes_ago: heartbeat_min, systemic, reason, entities });
      }

      // ── Scanner health (office banner). SYSTEMIC = API-level breaks that are NOT
      // photo-dependent: vision_unavailable with a hard/config status (404 model-
      // not-found, 401/403 auth, 400) OR network. parse_failed (bad/illegible slip)
      // and success_truncated (long receipt) contribute ZERO — a tech's crumpled
      // photo can never trip the banner. Transient 5xx/429/529 self-heal → excluded.
      if (p === "/api/admin/scan-health" && request.method === "GET") {
        if (!(await officeAuth(request, env))) return json({ error: "office_auth_required" }, 401);
        const HARD = "(outcome='network' OR (outcome='vision_unavailable' AND http_status IN (400,401,403,404)))";
        const stats = await env.DB.prepare(
          `SELECT COUNT(*) AS total,
             SUM(CASE WHEN outcome IN ('success','success_truncated') THEN 1 ELSE 0 END) AS success,
             SUM(CASE WHEN outcome='parse_failed' THEN 1 ELSE 0 END) AS parse_failed,
             SUM(CASE WHEN ${HARD} THEN 1 ELSE 0 END) AS hard_api_fail,
             SUM(CASE WHEN outcome='vision_unavailable' AND (http_status IS NULL OR http_status NOT IN (400,401,403,404)) THEN 1 ELSE 0 END) AS transient_fail
           FROM ts_scan_log WHERE created_at >= datetime('now','-24 hours')`
        ).first();
        const hard = Number(stats?.hard_api_fail || 0);
        const systemic = hard >= 2;        // ≥2 infra failures in 24h = reproducible break, not a fluke
        let top_status = null, top_message = null, last_fail_at = null;
        if (systemic) {
          const r = await env.DB.prepare(
            `SELECT http_status, outcome, raw_output, created_at FROM ts_scan_log
              WHERE created_at >= datetime('now','-24 hours') AND ${HARD} ORDER BY id DESC LIMIT 1`
          ).first();
          top_status = r?.http_status ?? null;
          top_message = String(r?.raw_output || r?.outcome || "").slice(0, 220);
          last_fail_at = r?.created_at || null;
        }
        return json({
          window_hours: 24, model: env.VISION_MODEL || "claude-sonnet-4-6",
          total: Number(stats?.total || 0), success: Number(stats?.success || 0),
          parse_failed: Number(stats?.parse_failed || 0), hard_api_fail: hard,
          transient_fail: Number(stats?.transient_fail || 0),
          systemic, top_status, top_message, last_fail_at,
        });
      }

      // --- 0a. Tech roster for the name picker ----------------------------
      // Verified against the real crm_techs schema (PRAGMA table_info):
      //   id, name, email, is_active, st_tech_id, ...
      // st_tech_id is the ServiceTitan employee id (crm_st_employees.id),
      // populated via migration 0001 by name match. It drives the per-plumber
      // GP breakdown, so it's what the app attributes materials by. May be NULL
      // for non-ServiceTitan techs (e.g. Office). Active flag is is_active.
      // Pass ?all=1 to include inactive techs.
      if (p === "/api/techs" && request.method === "GET") {
        const includeInactive = url.searchParams.get("all") === "1";
        const r = await env.DB.prepare(
          `SELECT id, name, email, is_active, st_tech_id
             FROM crm_techs
            ${includeInactive ? "" : "WHERE is_active = 1"}
            ORDER BY name`
        ).all();
        return json(r.results || []);
      }

      // --- 0a-quater. Office people for the "who's at the keyboard?" picker.
      // Active admins only (Brook, Jen). Retired placeholders (dup Jen id 3,
      // Warehouse Manager id 8) are is_active=0 so they drop off but old
      // created_by rows still resolve. GET /api/office-users
      if (p === "/api/office-users" && request.method === "GET") {
        const r = await env.DB.prepare(
          `SELECT id, TRIM(COALESCE(first_name,'') || ' ' || COALESCE(last_name,'')) AS name
             FROM crm_users WHERE role='admin' AND is_active=1 ORDER BY id`
        ).all();
        return json({ users: r.results || [] });
      }

      // --- 0a-bis. Per-plumber activity (read-only reporting, surfaces existing
      // data). GET /api/techs/:stTechId/activity?from=YYYY-MM-DD&to=YYYY-MM-DD ->
      //   usage:    van stock used on jobs (job_usage, created_by = this plumber)
      //   restocks: shop->van pulls INTO their van (transfer_in at their van loc;
      //             tagged by who did it — office vs the tech)
      //   requests: every "can't find it" they filed (all statuses + types)
      const activityMatch = p.match(/^\/api\/techs\/(\d+)\/activity$/);
      if (activityMatch && request.method === "GET") {
        const tid = activityMatch[1];
        const to = url.searchParams.get("to") || new Date().toISOString().slice(0, 10);
        const from = url.searchParams.get("from") || (() => { const d = new Date(); d.setUTCDate(d.getUTCDate() - 60); return d.toISOString().slice(0, 10); })();
        const dateOK = "substr(m.created_at,1,10) >= ? AND substr(m.created_at,1,10) <= ?";
        const tech = await env.DB.prepare(`SELECT st_tech_id, name FROM crm_techs WHERE st_tech_id = ?`).bind(tid).first();
        const van = await env.DB.prepare(`SELECT id, name FROM crm_inventory_locations WHERE type='truck' AND assigned_tech_id = ? ORDER BY active DESC LIMIT 1`).bind(tid).first();

        // job_usage.reference_id = crm_job_materials.id (the logged line) — the job
        // lives on that line (job_id + job_number); customer via crm_st_jobs.
        const usage = (await env.DB.prepare(
          `SELECT m.created_at, jm.job_id, jm.job_number, c.name AS customer,
                  COALESCE(l.address_street, c.address_street) AS address_street,
                  COALESCE(l.address_city, c.address_city) AS address_city,
                  l.name AS location_name, jm.total_cost AS cost,
                  m.material_id, mat.name AS material, ABS(m.qty_change) AS qty
             FROM crm_inventory_movements m
             LEFT JOIN crm_job_materials jm ON jm.id = m.reference_id
             LEFT JOIN crm_st_jobs j ON j.id = jm.job_id
             LEFT JOIN crm_st_locations l ON l.id = j.location_id
             LEFT JOIN crm_st_customers c ON c.id = j.customer_id
             LEFT JOIN crm_materials mat ON mat.id = m.material_id
            WHERE m.reason='job_usage' AND jm.id IS NOT NULL AND CAST(m.created_by AS TEXT)=? AND ${dateOK}
            ORDER BY m.created_at DESC, m.id DESC LIMIT 500`
        ).bind(tid, from, to).all()).results || [];

        const restocks = van ? (await env.DB.prepare(
          `SELECT m.created_at, m.material_id, mat.name AS material, m.qty_change AS qty,
                  m.created_by, m.undone_at, t.name AS by_name
             FROM crm_inventory_movements m
             LEFT JOIN crm_materials mat ON mat.id = m.material_id
             LEFT JOIN crm_techs t ON CAST(t.st_tech_id AS TEXT)=CAST(m.created_by AS TEXT)
            WHERE m.reason='transfer_in' AND m.location_id=? AND ${dateOK}
              AND (m.batch_id IS NULL OR m.batch_id NOT LIKE 'undo:%')
            ORDER BY m.created_at DESC, m.id DESC LIMIT 500`
        ).bind(van.id, from, to).all()).results || [] : [];
        for (const r of restocks) r.source = String(r.created_by) === String(tid) ? "tech" : (r.by_name || "office");

        const requests = (await env.DB.prepare(
          `SELECT r.created_at, r.type, r.status, r.quantity, r.custom_description,
                  r.material_id, mat.name AS material
             FROM crm_inventory_requests r LEFT JOIN crm_materials mat ON mat.id = r.material_id
            WHERE CAST(r.requested_by AS TEXT)=? AND substr(r.created_at,1,10) >= ? AND substr(r.created_at,1,10) <= ?
            ORDER BY r.id DESC LIMIT 500`
        ).bind(tid, from, to).all()).results || [];

        // Scanned-receipt parts (crm_job_purchases) for this tech in the window —
        // per-job material cost = van (usage above) + receipts (receipt_total,
        // tax-incl cost of record), matching GP's "Materials = van + receipts".
        // Receipt-matched lines never create a job_usage movement, so the usage
        // sum already excludes them — no double-count. is_overhead=0 drops the
        // job_id=0 overhead receipts. Customer/address joined so a receipt-only
        // job (no van usage) can still render a full card.
        const purchases = (await env.DB.prepare(
          `SELECT pu.id, pu.created_at, pu.job_id, pu.job_number, pu.supplier,
                  pu.receipt_total AS cost, c.name AS customer,
                  COALESCE(l.address_street, c.address_street) AS address_street,
                  COALESCE(l.address_city, c.address_city) AS address_city,
                  l.name AS location_name
             FROM crm_job_purchases pu
             LEFT JOIN crm_st_jobs j ON j.id = pu.job_id
             LEFT JOIN crm_st_locations l ON l.id = j.location_id
             LEFT JOIN crm_st_customers c ON c.id = j.customer_id
            WHERE CAST(pu.tech_id AS TEXT)=? AND pu.is_overhead = 0
              AND substr(pu.created_at,1,10) >= ? AND substr(pu.created_at,1,10) <= ?
            ORDER BY pu.id DESC LIMIT 500`
        ).bind(tid, from, to).all()).results || [];

        return json({
          tech: tech || { st_tech_id: Number(tid), name: "#" + tid },
          van: van || null, from, to,
          usage, restocks, requests, purchases,
          totals: { usage: usage.length, restocks: restocks.length, requests: requests.length, receipts: purchases.length },
        });
      }

      // --- 0a-ter. Recent material activity across ALL techs (last N days),
      // newest-first, for the tech-select landing stream. Same usage+purchases
      // shapes as the per-tech activity so the client groups both by job with the
      // identical card. Each row carries its tech name (one chronological stream,
      // not per-tech sections). GET /api/activity/recent?days=3
      if (p === "/api/activity/recent" && request.method === "GET") {
        const days = Math.min(Math.max(parseInt(url.searchParams.get("days") || "3", 10) || 3, 1), 31);
        const since = (() => { const d = new Date(); d.setUTCDate(d.getUTCDate() - days); return d.toISOString().slice(0, 10); })();
        const usage = (await env.DB.prepare(
          `SELECT m.created_at, m.created_by AS st_tech_id, t.name AS tech_name,
                  jm.job_id, jm.job_number, c.name AS customer,
                  COALESCE(l.address_street, c.address_street) AS address_street,
                  COALESCE(l.address_city, c.address_city) AS address_city,
                  l.name AS location_name, jm.total_cost AS cost,
                  m.material_id, mat.name AS material, ABS(m.qty_change) AS qty
             FROM crm_inventory_movements m
             LEFT JOIN crm_job_materials jm ON jm.id = m.reference_id
             LEFT JOIN crm_st_jobs j ON j.id = jm.job_id
             LEFT JOIN crm_st_locations l ON l.id = j.location_id
             LEFT JOIN crm_st_customers c ON c.id = j.customer_id
             LEFT JOIN crm_materials mat ON mat.id = m.material_id
             LEFT JOIN crm_techs t ON CAST(t.st_tech_id AS TEXT)=CAST(m.created_by AS TEXT)
            WHERE m.reason='job_usage' AND jm.id IS NOT NULL AND substr(m.created_at,1,10) >= ?
            ORDER BY m.created_at DESC, m.id DESC LIMIT 500`
        ).bind(since).all()).results || [];
        const purchases = (await env.DB.prepare(
          `SELECT pu.id, pu.created_at, pu.tech_id AS st_tech_id, t.name AS tech_name,
                  pu.job_id, pu.job_number, pu.supplier, pu.receipt_total AS cost,
                  c.name AS customer,
                  COALESCE(l.address_street, c.address_street) AS address_street,
                  COALESCE(l.address_city, c.address_city) AS address_city,
                  l.name AS location_name
             FROM crm_job_purchases pu
             LEFT JOIN crm_st_jobs j ON j.id = pu.job_id
             LEFT JOIN crm_st_locations l ON l.id = j.location_id
             LEFT JOIN crm_st_customers c ON c.id = j.customer_id
             LEFT JOIN crm_techs t ON CAST(t.st_tech_id AS TEXT)=CAST(pu.tech_id AS TEXT)
            WHERE pu.is_overhead = 0 AND substr(pu.created_at,1,10) >= ?
            ORDER BY pu.id DESC LIMIT 500`
        ).bind(since).all()).results || [];
        return json({ since, days, usage, purchases,
          totals: { usage: usage.length, purchases: purchases.length } });
      }

      // --- 0b. Today's jobs for a tech (ServiceTitan-fed via D1) ----------
      // TWO TIERS, two date windows:
      //   ACTIVE (jobs[]):  the tech's appointment-assignments -> jobs for TODAY
      //     (Pacific) where the appointment is Working/Dispatched/Scheduled and
      //     the job isn't finished. Ranked Working -> Dispatched -> Scheduled (the
      //     tech's status on the job today). A "Working" appt is always included
      //     even if its start fell outside today's window (they're on it now).
      //   RECENT (recent[]): the tech's jobs visited in the LAST 3 DAYS whose job
      //     status is Completed or paused (tech-finished / awaiting office review),
      //     so a forgotten material can still be logged. De-emphasized in the UI.
      // The two tiers are mutually exclusive (active excludes finished job
      // statuses; recent only includes them). ST data lands in D1 via the
      // crm-worker */10 incremental sync. Empty active list -> manual fallback.
      if (p === "/api/techs/jobs" && request.method === "GET") {
        const tid = parseInt(url.searchParams.get("st_tech_id") || "", 10);
        if (!tid) return json({ jobs: [], recent: [], fallback: "manual" });
        const { dayStr, start, end } = pacificDayBoundsUTC();
        const recentStart = new Date(Date.parse(start) - 7 * 86400000)
          .toISOString().replace(/\.\d{3}Z$/, "Z");                 // today's Pacific midnight, -7 days (covers a weekend gap)
        // Prefer the job's SERVICE-location address (crm_st_locations via
        // j.location_id); fall back to the customer BILLING address when the
        // location isn't synced yet (stale locations table — see CRM_BUILD task).
        const addr =
          `TRIM(COALESCE(l.address_street, c.address_street, '') ||
                CASE WHEN COALESCE(l.address_city, c.address_city) IS NOT NULL THEN ', ' || COALESCE(l.address_city, c.address_city) ELSE '' END)`;
        const [activeRes, recentRes] = await env.DB.batch([
          // ACTIVE — today, active appointment status, job not finished.
          env.DB.prepare(
            `SELECT aa.job_id, j.job_number, j.status AS job_status, c.name AS customer,
                    ${addr} AS address, l.name AS location_name,
                    MIN(CASE ap.status WHEN 'Working' THEN 1 WHEN 'Dispatched' THEN 2
                                       WHEN 'Scheduled' THEN 3 ELSE 4 END) AS status_rank,
                    MIN(ap.start_date) AS start_date,
                    COUNT(DISTINCT aa.appointment_id) AS appt_count
               FROM crm_st_appointment_assignments aa
               JOIN crm_st_appointments ap ON ap.id = aa.appointment_id
               JOIN crm_st_jobs j           ON j.id = aa.job_id
               LEFT JOIN crm_st_locations l ON l.id = j.location_id
               LEFT JOIN crm_st_customers c ON c.id = j.customer_id
              WHERE aa.technician_id = ?1
                AND ap.status IN ('Working','Dispatched','Scheduled')
                AND ((ap.start_date >= ?2 AND ap.start_date < ?3) OR ap.status = 'Working')
                AND j.status NOT IN ('Completed','Canceled')
                AND LOWER(j.status) != 'paused'
              GROUP BY aa.job_id, j.job_number, j.status, c.name, l.address_street, l.address_city, l.name, c.address_street, c.address_city
              ORDER BY status_rank, start_date`
          ).bind(tid, start, end),
          // RECENT — finished (Completed/paused) jobs visited in the last 3 days.
          env.DB.prepare(
            `SELECT aa.job_id, j.job_number, j.status AS job_status, c.name AS customer,
                    ${addr} AS address, l.name AS location_name,
                    MAX(ap.start_date) AS start_date,
                    COUNT(DISTINCT aa.appointment_id) AS appt_count
               FROM crm_st_appointment_assignments aa
               JOIN crm_st_appointments ap ON ap.id = aa.appointment_id
               JOIN crm_st_jobs j           ON j.id = aa.job_id
               LEFT JOIN crm_st_locations l ON l.id = j.location_id
               LEFT JOIN crm_st_customers c ON c.id = j.customer_id
              WHERE aa.technician_id = ?1
                AND (j.status = 'Completed' OR LOWER(j.status) = 'paused')
                AND ap.start_date >= ?2
              GROUP BY aa.job_id, j.job_number, j.status, c.name, l.address_street, l.address_city, l.name, c.address_street, c.address_city
              ORDER BY start_date DESC`
          ).bind(tid, recentStart),
        ]);
        const RANK = { 1: "Working", 2: "Dispatched", 3: "Scheduled" };
        const jobs = (activeRes.results || []).map((row) => ({
          job_id: row.job_id, job_number: row.job_number, customer: row.customer,
          address: row.address || null, location_name: row.location_name || null,
          status: RANK[row.status_rank] || "Scheduled",
          start_date: row.start_date, appt_count: row.appt_count, job_status: row.job_status,
        }));
        const recent = (recentRes.results || []).map((row) => ({
          job_id: row.job_id, job_number: row.job_number, customer: row.customer,
          address: row.address || null, location_name: row.location_name || null,
          status: String(row.job_status).toLowerCase() === "paused" ? "Paused" : "Done",
          start_date: row.start_date, appt_count: row.appt_count, job_status: row.job_status,
        }));
        return json({ st_tech_id: tid, date: dayStr, jobs, recent, fallback: jobs.length ? null : "manual" });
      }

      // --- 0c. Van roster for the office UI -------------------------------
      // Active truck locations with their assigned tech's name, plus a count of
      // materials below par (on_hand < min_qty) for the restock badge. The tech
      // join is on crm_techs.st_tech_id (assigned_tech_id holds the ServiceTitan
      // id), NOT crm_techs.id; LEFT JOIN so a van whose tech isn't in crm_techs
      // (e.g. Graham) still appears with a null tech_name. The below-par count
      // is a single GROUP BY subquery (one round trip, not N), COALESCEd to 0.
      if (p === "/api/locations/vans" && request.method === "GET") {
        const r = await env.DB.prepare(
          `SELECT l.id, l.name, l.assigned_tech_id, t.name AS tech_name,
                  COALESCE(c.below_par_count, 0) AS below_par_count
             FROM crm_inventory_locations l
             LEFT JOIN crm_techs t ON t.st_tech_id = l.assigned_tech_id
             LEFT JOIN (
               SELECT location_id, COUNT(*) AS below_par_count
                 FROM crm_inventory_stock
                WHERE on_hand < min_qty
                GROUP BY location_id
             ) c ON c.location_id = l.id
            WHERE l.type = 'truck' AND l.active = 1
            ORDER BY l.name`
        ).all();
        return json(r.results || []);
      }

      // --- 1. Search-as-you-type over the catalog -------------------------
      // Matches name, code, or EMCO SKU. Returns cost so the capture screen
      // can freeze it onto the job line at time of use.
      if (p === "/api/materials/search" && request.method === "GET") {
        const q = (url.searchParams.get("q") || "").trim();
        if (q.length < 2) return json([]); // wait for 2+ chars
        const like = `%${q}%`;
        // search_terms is a dedicated field for tech vocabulary ("elbow" -> "90 copper ell").
        // is_active filters out retired catalog items. unit/category help the capture UI.
        const r = await env.DB.prepare(
          `SELECT id, code, emco_sku, name, cost, price, unit, category, search_terms,
                  conversion_factor, use_unit, purchase_unit, deduct_on_use,
                  ROUND(COALESCE(cost_per_use_override, CASE WHEN conversion_factor>0 THEN cost/conversion_factor END),2) AS cost_per_use
             FROM crm_materials
            WHERE is_active = 1
              AND (name LIKE ? OR code LIKE ? OR emco_sku LIKE ? OR search_terms LIKE ?)
            ORDER BY name
            LIMIT 25`
        ).bind(like, like, like, like).all();
        return json(r.results || []);
      }

      // --- 1b. Catalog grouped by category (tech browse) -----------------
      // One fetch (~302 active rows) grouped by category for the collapsible
      // browse below the search bar. Lean fields: just what add()/display need.
      if (p === "/api/materials/by-category" && request.method === "GET") {
        const rows = (await env.DB.prepare(
          `SELECT id, name, cost, category, conversion_factor, use_unit, deduct_on_use,
                  ROUND(COALESCE(cost_per_use_override, CASE WHEN conversion_factor>0 THEN cost/conversion_factor END),2) AS cost_per_use
             FROM crm_materials WHERE is_active = 1 ORDER BY category, name`
        ).all()).results || [];
        const map = new Map();
        for (const r of rows) {
          const cat = r.category || "Uncategorized";
          if (!map.has(cat)) map.set(cat, []);
          map.get(cat).push({ id: r.id, name: r.name, cost: r.cost, conversion_factor: r.conversion_factor, use_unit: r.use_unit, deduct_on_use: r.deduct_on_use, cost_per_use: r.cost_per_use });
        }
        const categories = [...map.entries()].map(([name, items]) => ({ name, count: items.length, items }));
        return json({ categories });
      }

      // --- 1c. Special request: tech can't find an item ------------------
      // POST /api/requests  body { tech_id, description, quantity?, notes?, job_id? }
      // Writes crm_inventory_requests: material_id=0 sentinel (column is NOT NULL,
      // no FK), type='special_request', status='pending'. No cost, no stock
      // change. truck_location_id resolved from the tech's van.
      if (p === "/api/requests" && request.method === "POST") {
        const b = await request.json().catch(() => ({}));
        if (techTok) b.tech_id = techTok.payload.tech_id;   // T1: server-stamp actor from token; falls back to client body
        const description = (b.description || "").trim();
        if (b.tech_id == null) return json({ error: "tech_id required" }, 400);
        if (!description) return json({ error: "description required" }, 400);
        const qty = Number(b.quantity) > 0 ? Number(b.quantity) : 1;
        const van = await env.DB.prepare(
          `SELECT id FROM crm_inventory_locations WHERE type='truck' AND active=1 AND assigned_tech_id = ?`
        ).bind(b.tech_id).first();
        const ins = await env.DB.prepare(
          `INSERT INTO crm_inventory_requests
             (material_id, type, custom_description, quantity, urgency, notes, requested_by, truck_location_id, job_id, status)
           VALUES (0, 'special_request', ?, ?, 'normal', ?, ?, ?, ?, 'pending')`
        ).bind(description, qty, b.notes || null, b.tech_id, van ? van.id : null, b.job_id || null).run();
        return json({ ok: true, request_id: ins.meta?.last_row_id ?? null, truck_location_id: van ? van.id : null });
      }

      // --- 1d. Office: list special requests + mark handled --------------
      // GET /api/requests?type=special_request&status=pending -> { requests, count }.
      // The type filter is AIRTIGHT: special_request and shop_reorder never mix.
      if (p === "/api/requests" && request.method === "GET") {
        // Defaults keep the current behavior (pending special-requests → the Home
        // badge stays "needs action"), but type/status accept 'all' and tech_id
        // filters by plumber, so the screen can show real history without
        // conflating special_request vs shop_reorder.
        const type = url.searchParams.get("type") || "special_request";
        const status = url.searchParams.get("status") || "pending";
        const techId = url.searchParams.get("tech_id");
        const conds = [], binds = [];
        if (type !== "all") { conds.push("r.type = ?"); binds.push(type); }
        if (status !== "all") { conds.push("r.status = ?"); binds.push(status); }
        if (techId) { conds.push("CAST(r.requested_by AS TEXT) = ?"); binds.push(String(techId)); }
        const rows = (await env.DB.prepare(
          `SELECT r.id, r.type, r.status, r.custom_description, r.quantity, r.notes, r.created_at,
                  r.requested_by, r.truck_location_id, r.material_id, mat.name AS material,
                  t.name AS tech_name, l.name AS van_name
             FROM crm_inventory_requests r
             LEFT JOIN crm_techs t ON t.st_tech_id = r.requested_by
             LEFT JOIN crm_inventory_locations l ON l.id = r.truck_location_id
             LEFT JOIN crm_materials mat ON mat.id = r.material_id
            ${conds.length ? "WHERE " + conds.join(" AND ") : ""}
            ORDER BY r.id DESC`
        ).bind(...binds).all()).results || [];
        return json({ requests: rows, count: rows.length });
      }

      // POST /api/requests/:id/handle -> status='fulfilled' (scoped to special_request).
      const reqHandle = p.match(/^\/api\/requests\/(\d+)\/handle$/);
      if (reqHandle && request.method === "POST") {
        const id = reqHandle[1];
        const b = await request.json().catch(() => ({}));
        const r = await env.DB.prepare(
          `UPDATE crm_inventory_requests SET status='fulfilled', updated_at=datetime('now'), fulfilled_note=?
            WHERE id=? AND type='special_request'`
        ).bind(b.note || null, id).run();
        return json({ ok: true, id: Number(id), handled: (r.meta?.changes ?? 0) > 0 });
      }

      // --- 2. Log a used material to a job --------------------------------
      // Body: { material_id, quantity, tech_id?, truck_location_id?, job_number? }
      // Cost is FROZEN here: we read the catalog cost now and write it onto the
      // job line, so historical GP stays true even if catalog prices change later.
      const saveMatch = p.match(/^\/api\/jobs\/([^/]+)\/materials$/);
      if (saveMatch && request.method === "POST") {
        const jobId = saveMatch[1];
        const b = await request.json();
        if (techTok) b.tech_id = techTok.payload.tech_id;   // T1: server-stamp actor from token; falls back to client body
        if (!b.material_id || !b.quantity) {
          return json({ error: "material_id and quantity are required" }, 400);
        }
        // Freeze cost from catalog at time of use.
        const mat = await env.DB.prepare(
          `SELECT cost, conversion_factor, cost_per_use_override, deduct_on_use FROM crm_materials WHERE id = ?`
        ).bind(b.material_id).first();
        // quantity is always in USE-UNITS, and we ALWAYS freeze the per-USE cost:
        //   override, else cost / conversion_factor — NEVER the per-purchase `cost`
        //   when conversion > 1 (that would be a ~conversion× overcharge: a 12ft
        //   stick at $47.40 must freeze at $3.95/ft, not $47.40/ft). A normal item
        //   has conversion=1, so cost/1 = cost — identical to before.
        let unitCost = 0;
        if (mat) {
          const conv = mat.conversion_factor;
          unitCost = mat.cost_per_use_override != null ? mat.cost_per_use_override
                   : (conv > 0 ? mat.cost / conv : (mat.cost ?? 0));
        }
        // deduct_on_use=0 (pipe, untracked bag) = cost-only: never moves stock.
        const noDeduct = !!(mat && mat.deduct_on_use === 0);
        unitCost = Math.round(unitCost * 100) / 100;          // store to the cent
        const totalCost = Math.round(unitCost * b.quantity * 100) / 100;

        // is_prepull lets you distinguish materials pulled for a job vs actually used.
        // Defaults to 0 (used) unless the caller marks it a pre-pull.
        const ins = await env.DB.prepare(
          `INSERT INTO crm_job_materials
             (job_id, job_number, material_id, quantity, unit_cost, total_cost,
              tech_id, truck_location_id, notes, is_prepull)
           VALUES (?,?,?,?,?,?,?,?,?,?)`
        ).bind(
          jobId,
          b.job_number ?? null,
          b.material_id,
          b.quantity,
          unitCost,
          totalCost,
          b.tech_id ?? null,
          b.truck_location_id ?? null,
          b.notes ?? null,
          b.is_prepull ? 1 : 0
        ).run();
        const jobMaterialId = ins.meta?.last_row_id ?? null;

        // --- Stock-deduction hinge -------------------------------------------
        // The usage record above is the SOURCE OF TRUTH and is already committed.
        // Everything below adjusts van stock as a best-effort side effect: any
        // failure here is caught and reported, NEVER fatal to the material log.
        // We deduct only from the logging tech's own van. deduct_on_use=0 items
        // (pipe, untracked bag) NEVER touch inventory — usage is job-cost-only,
        // fully decoupled from the physical stock (counted/reordered manually).
        let stock = { deducted: false, reason: noDeduct ? "cost_only" : "no_van_for_tech" };
        if (!noDeduct) try {
          // Resolve the tech's active van. tech_id in the log body is the
          // ServiceTitan id, which is what crm_inventory_locations stores in
          // assigned_tech_id. active=1 excludes the retired test rig.
          const van = b.tech_id == null ? null : await env.DB.prepare(
            `SELECT id FROM crm_inventory_locations
              WHERE type = 'truck' AND active = 1 AND assigned_tech_id = ?`
          ).bind(b.tech_id).first();

          if (!van) {
            // Tech has no resolvable van — log stands, no movement. Noted.
            stock = { deducted: false, reason: "no_van_for_tech" };
          } else {
            // Deduct only if this material is actually stocked on the van.
            // No stock row => non-van / counter item => skip (no deduction).
            const row = await env.DB.prepare(
              `SELECT id, on_hand FROM crm_inventory_stock
                WHERE location_id = ? AND material_id = ?`
            ).bind(van.id, b.material_id).first();

            if (!row) {
              stock = { deducted: false, reason: "not_van_stocked", location_id: van.id };
            } else {
              const before = row.on_hand ?? 0;
              const after = before - b.quantity; // allow negative — never block
              // Atomic: stock update + ledger row succeed or fail together, so
              // on_hand and the movement log can never diverge.
              await env.DB.batch([
                env.DB.prepare(
                  `UPDATE crm_inventory_stock
                      SET on_hand = ?, modified_at = datetime('now')
                    WHERE id = ?`
                ).bind(after, row.id),
                env.DB.prepare(
                  `INSERT INTO crm_inventory_movements
                     (material_id, location_id, qty_change, reason, reference_id, created_by)
                   VALUES (?,?,?,?,?,?)`
                ).bind(
                  b.material_id,
                  van.id,
                  -b.quantity,
                  "job_usage",
                  jobMaterialId,        // reference back to the crm_job_materials row
                  b.tech_id ?? null
                ),
              ]);
              stock = {
                deducted: true,
                location_id: van.id,
                on_hand_before: before,
                on_hand_after: after,
                below_zero: after < 0,   // surface "needs review" later
              };
            }
          }
        } catch (e) {
          // Deduction failed — report it, but the material log itself stands.
          stock = { deducted: false, error: String(e.message || e) };
        }

        return json({
          ok: true,
          job_material_id: jobMaterialId,
          unit_cost: unitCost,
          total_cost: totalCost,
          stock,
        });
      }

      // --- 3. List materials logged on a job ------------------------------
      if (saveMatch && request.method === "GET") {
        const jobId = saveMatch[1];
        const r = await env.DB.prepare(
          // tech_id stores the ServiceTitan id (st_tech_id), so the tech join
          // is on t.st_tech_id, NOT t.id. tech_name is aliased to avoid
          // colliding with m.name (the material name). Both joins are LEFT so
          // a missing material or unmapped tech still returns the line.
          `SELECT jm.id, jm.material_id, jm.quantity, jm.unit_cost, jm.total_cost,
                  jm.notes, jm.is_prepull, jm.tech_id, m.name, m.code, m.unit, m.use_unit, m.deduct_on_use,
                  t.name AS tech_name
             FROM crm_job_materials jm
             LEFT JOIN crm_materials m ON m.id = jm.material_id
             LEFT JOIN crm_techs t ON t.st_tech_id = jm.tech_id
            WHERE jm.job_id = ?
            ORDER BY jm.id DESC`
        ).bind(jobId).all();
        const rows = r.results || [];
        const total = rows.reduce((a, x) => a + (x.total_cost || 0), 0);
        return json({ job_id: jobId, items: rows, total_material_cost: total });
      }

      // --- 4. Delete a logged material line (hard delete) -----------------
      // DELETE /api/jobs/:jobId/materials/:lineId
      // Scope check is REQUIRED: we only delete when the row's job_id matches
      // the :jobId in the URL. If the line doesn't exist, or belongs to a
      // different job, return 404 and delete nothing — this prevents deleting
      // another job's line by guessing its id.
      const delMatch = p.match(/^\/api\/jobs\/([^/]+)\/materials\/([^/]+)$/);
      if (delMatch && request.method === "DELETE") {
        const jobId = delMatch[1];
        const lineId = delMatch[2];
        const delBody = await request.json().catch(() => ({}));
        const actorId = delBody.actor_id ?? null;   // WHO deleted (tech or office person) — distinct from the line's original tech
        // Fetch the columns we need both for the scope check AND to reverse the
        // stock deduction symmetrically (material_id, quantity, tech_id).
        const row = await env.DB.prepare(
          `SELECT id, job_id, material_id, quantity, tech_id
             FROM crm_job_materials WHERE id = ?`
        ).bind(lineId).first();
        if (!row || String(row.job_id) !== String(jobId)) {
          return json({ error: "not found" }, 404);
        }
        await env.DB.prepare(
          `DELETE FROM crm_job_materials WHERE id = ? AND job_id = ?`
        ).bind(lineId, jobId).run();

        // --- Stock-reversal hinge (mirror of the deduction on log) -----------
        // The line is already deleted (source of truth). Restoring van stock is
        // a best-effort side effect: any failure here is caught and reported,
        // NEVER fatal to the delete.
        //
        // We reverse against the location the material was ORIGINALLY deducted
        // from — found via the ledger (the job_usage movement whose reference_id
        // is this line) — NOT the tech's current van, which may have changed
        // since logging. If no such movement exists, nothing was ever deducted
        // (no van / counter item / deduction errored), so there's nothing to
        // reverse.
        let stock = { reversed: false, reason: "no_deduction_found" };
        try {
          const orig = await env.DB.prepare(
            `SELECT location_id FROM crm_inventory_movements
              WHERE reference_id = ? AND reason = 'job_usage'
              ORDER BY id DESC LIMIT 1`
          ).bind(row.id).first();

          if (!orig) {
            stock = { reversed: false, reason: "no_deduction_found" };
          } else {
            const locId = orig.location_id;
            // Restore the line's FULL current quantity, not just the original
            // job_usage amount. A line's net deduction always equals its current
            // quantity (log deducts -qty; each PATCH adjusts by -delta), so if it
            // was quantity-edited the deducted total is row.quantity — reversing
            // -orig.qty_change alone would leave the qty-edit delta unrestored.
            const restoreQty = row.quantity;
            const srow = await env.DB.prepare(
              `SELECT id, on_hand FROM crm_inventory_stock
                WHERE location_id = ? AND material_id = ?`
            ).bind(locId, row.material_id).first();

            if (!srow) {
              // Deduction existed but its stock row is gone — can't restore it.
              stock = { reversed: false, reason: "stock_row_missing", location_id: locId };
            } else {
              const before = srow.on_hand ?? 0;
              const after = before + restoreQty; // restore exactly what was deducted
              // reason 'usage_reversed' isn't in the crm_inventory_movements
              // CHECK constraint, so we record it as an allowed 'manual'
              // adjustment and carry the intent + source line in notes.
              // Atomic batch keeps on_hand and the ledger in lockstep.
              await env.DB.batch([
                env.DB.prepare(
                  `UPDATE crm_inventory_stock
                      SET on_hand = ?, modified_at = datetime('now')
                    WHERE id = ?`
                ).bind(after, srow.id),
                env.DB.prepare(
                  `INSERT INTO crm_inventory_movements
                     (material_id, location_id, qty_change, reason, reference_id, notes, created_by, actor_id)
                   VALUES (?,?,?,?,?,?,?,?)`
                ).bind(
                  row.material_id,
                  locId,                 // the ORIGINAL deduction's location
                  restoreQty,            // positive — compensating movement
                  "manual",
                  row.id,                // reference back to the deleted line id
                  `usage_reversed; line ${row.id}`,
                  row.tech_id ?? null,   // created_by stays the ORIGINAL tech (unchanged)
                  actorId                // actor_id = WHO performed the delete
                ),
              ]);
              stock = {
                reversed: true,
                location_id: locId,
                on_hand_before: before,
                on_hand_after: after,
              };
            }
          }
        } catch (e) {
          // Reversal failed — report it, but the delete itself stands.
          stock = { reversed: false, error: String(e.message || e) };
        }

        return json({ ok: true, deleted_id: row.id, stock });
      }

      // --- 4b. Edit a logged line's quantity (online v1) -----------------
      // PATCH /api/jobs/:jobId/materials/:lineId   Body: { quantity }
      // Recompute total_cost from the FROZEN unit_cost (qty x unit_cost), then
      // adjust van stock by the delta: more qty -> deduct the extra, less qty
      // -> restore the difference. Like the delete reversal, the van is found
      // from the ORIGINAL job_usage movement's location (the tech's current van
      // may differ). The line update is the source of truth; the stock
      // adjustment is atomic and non-fatal.
      if (delMatch && request.method === "PATCH") {
        const jobId = delMatch[1];
        const lineId = delMatch[2];
        const b = await request.json();
        const newQty = Number(b.quantity);
        const actorId = b.actor_id ?? null;   // WHO edited — distinct from the line's original tech
        if (!(newQty > 0)) {
          return json({ error: "quantity must be > 0 (use DELETE to remove)" }, 400);
        }
        // Scope check (same as delete) + fetch what we need to recompute/adjust.
        const row = await env.DB.prepare(
          `SELECT id, job_id, material_id, quantity, unit_cost, tech_id
             FROM crm_job_materials WHERE id = ?`
        ).bind(lineId).first();
        if (!row || String(row.job_id) !== String(jobId)) {
          return json({ error: "not found" }, 404);
        }
        const oldQty = row.quantity;
        const unitCost = row.unit_cost ?? 0;
        const newTotal = unitCost * newQty;

        // Source of truth: update the usage line (qty + recomputed total). Cost
        // stays FROZEN — we never re-read the catalog. Must succeed (a throw
        // here returns 500 via the outer catch).
        await env.DB.prepare(
          `UPDATE crm_job_materials SET quantity = ?, total_cost = ? WHERE id = ?`
        ).bind(newQty, newTotal, lineId).run();

        // --- Stock-delta hinge (atomic, non-fatal) -------------------------
        // delta = newQty - oldQty; on_hand moves by -delta (more usage lowers
        // stock, less usage raises it), so qty_change = -delta. Recorded as
        // 'manual' — the allowed CHECK reason we already use for usage
        // corrections (no 'qty_edit'/'usage_reversed' in the CHECK set) — with
        // the before->after in notes. Negative on_hand allowed and flagged.
        let stock = { adjusted: false, reason: "no_change" };
        if (newQty !== oldQty) {
          stock = { adjusted: false, reason: "no_deduction_found" };
          try {
            const delta = newQty - oldQty;
            const orig = await env.DB.prepare(
              `SELECT location_id FROM crm_inventory_movements
                WHERE reference_id = ? AND reason = 'job_usage'
                ORDER BY id DESC LIMIT 1`
            ).bind(row.id).first();
            if (orig) {
              const locId = orig.location_id;
              const srow = await env.DB.prepare(
                `SELECT id, on_hand FROM crm_inventory_stock
                  WHERE location_id = ? AND material_id = ?`
              ).bind(locId, row.material_id).first();
              if (!srow) {
                stock = { adjusted: false, reason: "stock_row_missing", location_id: locId };
              } else {
                const before = srow.on_hand ?? 0;
                const after = before - delta; // more qty -> lower stock
                await env.DB.batch([
                  env.DB.prepare(
                    `UPDATE crm_inventory_stock
                        SET on_hand = ?, modified_at = datetime('now')
                      WHERE id = ?`
                  ).bind(after, srow.id),
                  env.DB.prepare(
                    `INSERT INTO crm_inventory_movements
                       (material_id, location_id, qty_change, reason, reference_id, notes, created_by, actor_id)
                     VALUES (?,?,?,?,?,?,?,?)`
                  ).bind(
                    row.material_id, locId, -delta, "manual", row.id,
                    `qty edit: line ${row.id} ${oldQty}->${newQty}`, row.tech_id ?? null, actorId
                  ),
                ]);
                stock = {
                  adjusted: true, location_id: locId, delta,
                  on_hand_before: before, on_hand_after: after, below_zero: after < 0,
                };
              }
            }
          } catch (e) {
            stock = { adjusted: false, error: String(e.message || e) };
          }
        }

        return json({
          ok: true,
          job_material_id: row.id,
          quantity: newQty,
          unit_cost: unitCost,
          total_cost: newTotal,
          stock,
        });
      }

      // --- 4c. AI receipt / packing-slip scan (wholesaler + retail) ------
      // Returns parsed data for the tech to review; writes NOTHING to the job.
      // Phase 1: logs each scan to ts_scan_log (diagnostics) — best-effort, never
      // alters the response.
      // POST /api/jobs/:jobId/scan-receipt   Body: { image_base64, media_type }
      // Ported from CRM_BUILD inventory.js: Claude vision extracts supplier +
      // line items + totals; we fuzzy-match each line to the catalog and return
      // it for the tech to review. NOTHING is written here — the confirm step
      // (POST .../purchases) commits only what the tech approves. No auth gate
      // (truck-stock is open). Needs ANTHROPIC_API_KEY as a worker secret.
      const scanMatch = p.match(/^\/api\/jobs\/([^/]+)\/scan-receipt$/);
      if (scanMatch && request.method === "POST") {
        if (!env.ANTHROPIC_API_KEY) {
          return json({ error: "missing_api_key",
            message: "Set ANTHROPIC_API_KEY via `wrangler secret put ANTHROPIC_API_KEY`." }, 500);
        }
        const b = await request.json().catch(() => ({}));
        if (!b.image_base64) return json({ error: "missing_image" }, 400);
        const mediaType = b.media_type || "image/jpeg";
        const VISION_MODEL = env.VISION_MODEL || "claude-sonnet-4-6";   // configured in wrangler.toml [vars]; fallback here

        // Phase 1 diagnostics (best-effort; NEVER alters the scan response): store
        // the image we sent + log each scan outcome so we can see the real failure
        // mix (truncated / parse_failed / wrong values / network) before Phase 2.
        const scanId = crypto.randomUUID();
        const imgBytes = Math.round((b.image_base64.length * 3) / 4);
        let imageKey = null;
        if (env.RECEIPTS) {
          try {
            imageKey = `scan-log/${scanId}.jpg`;
            await env.RECEIPTS.put(imageKey, Uint8Array.from(atob(b.image_base64), (c) => c.charCodeAt(0)), { httpMetadata: { contentType: mediaType } });
          } catch (_) { imageKey = null; }
        }
        const logScan = async (outcome, x = {}) => {
          try {
            await env.DB.prepare(`INSERT INTO ts_scan_log (job_id, tech_id, outcome, http_status, stop_reason, model, source_type, supplier, item_count, raw_len, raw_output, image_key, image_bytes) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
              .bind(scanMatch[1], techTok?.payload?.tech_id ?? null, outcome, x.status ?? null, x.stop_reason ?? null, VISION_MODEL,
                    x.source_type ?? null, x.supplier ?? null, x.item_count ?? null, x.raw_len ?? null,
                    x.raw != null ? String(x.raw).slice(0, 12000) : null, imageKey, imgBytes).run();
          } catch (_) {}
        };

        const prompt = `You are reading a supplier receipt or packing slip from a plumbing job. It may be from a plumbing WHOLESALER (EMCO, Wolseley, Sheret, and similar) OR a RETAIL store (Home Depot, Lowe's, Canadian Tire, Rona, Costco, and similar). The image may be rotated. Return JSON ONLY — no markdown fences, no prose.

MONEY FORMAT: Read every money value EXACTLY as printed, including its decimal point. ONLY if the slip prints money with NO decimal points ANYWHERE — a quirk of some wholesaler slips like Wolseley ("13106" = 131.06, "2694" = 26.94, "585" = 5.85) — treat the last two digits as cents and divide by 100. Retail receipts (Home Depot, Lowe's, Canadian Tire, etc.) always print normal decimals — NEVER divide those by 100.

Extract:
- "source_type": "wholesaler" if it's a plumbing-supply house (EMCO / Wolseley / Sheret / etc.), "retail" if it's a retail or big-box store (Home Depot / Lowe's / Canadian Tire / Rona / Costco / etc.), or "unknown".
- "supplier": the store/company name as printed (e.g. "EMCO", "Wolseley", "The Home Depot", "Canadian Tire"), or "" if unclear.
- "items": EVERY line item, each with:
   · "description": the item name as printed (omit leading column codes / line numbers / SKUs).
   · "quantity": the quantity bought (a number; default 1).
   · "unit_price": the per-unit price.
   · "line_total": the printed EXTENDED/line amount for that row — the column headed "EXTENSION", "Line amt", "Amount", "Total", or similar (common on wholesaler slips; it already accounts for per-100/per-foot pricing). If there is no such column (typical on retail receipts), use 0.
- "tax_shown": true if the receipt prints a GST / PST / HST / TAX line OR a clearly tax-included grand total; false ONLY if there is no tax anywhere (e.g. a wholesaler packing slip with a blank or 0.00 total).
- "shown_subtotal": the printed pre-tax subtotal, else 0.
- "shown_tax": GST + PST (+ HST / TAX) added together, else 0.
- "shown_total": the printed grand TOTAL line. IGNORE a 0.00 or blank total — use 0 then.

Use 0 for any number not visible. Do not hallucinate.
Schema: {"source_type":"unknown","supplier":"","items":[{"description":"","quantity":1,"unit_price":0,"line_total":0}],"tax_shown":false,"shown_subtotal":0,"shown_tax":0,"shown_total":0}`;

        const callVision = () => fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-api-key": env.ANTHROPIC_API_KEY,
            "anthropic-version": "2023-06-01",
          },
          body: JSON.stringify({
            model: VISION_MODEL,
            max_tokens: 4096,        // long retail receipts + multi-line POs overflowed 1500 → truncated JSON
            temperature: 0,          // deterministic structured extraction
            messages: [{
              role: "user",
              content: [
                { type: "image", source: { type: "base64", media_type: mediaType, data: b.image_base64 } },
                { type: "text", text: prompt },
              ],
            }],
          }),
        });
        let aiResp;
        try {
          aiResp = await callVision();
          // 529 = Overloaded (transient Anthropic capacity). One quick retry
          // before surfacing it — many overloads clear within a second or two.
          if (aiResp.status === 529) {
            await new Promise((r) => setTimeout(r, 1500));
            aiResp = await callVision();
          }
        } catch (e) {
          await logScan("network", { raw: String(e?.message || e), raw_len: 0 });
          return json({ error: "anthropic_network", message: String(e?.message || e) }, 502);
        }
        if (!aiResp.ok) {
          const errText = await aiResp.text().catch(() => "");
          // retryable flag lets the client distinguish "busy, try again" (529/5xx)
          // from a hard failure. The tech UI shows a friendly message either way.
          const retryable = aiResp.status === 529 || aiResp.status >= 500;
          await logScan("vision_unavailable", { status: aiResp.status, raw: errText, raw_len: errText.length });
          return json({ error: "vision_unavailable", status: aiResp.status, retryable, message: errText.slice(0, 300) }, 502);
        }
        const data = await aiResp.json().catch(() => null);
        const text = data?.content?.[0]?.text || "";
        const stopReason = data?.stop_reason || null;   // 'max_tokens' => truncated output

        // Claude occasionally wraps in ```json fences even when told not to.
        let parsed = null;
        try {
          const stripped = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "").trim();
          parsed = JSON.parse(stripped);
        } catch (_) {
          const m = text.match(/\{[\s\S]*\}/);
          if (m) { try { parsed = JSON.parse(m[0]); } catch {} }
        }
        if (!parsed) {
          await logScan("parse_failed", { status: aiResp.status, stop_reason: stopReason, raw: text, raw_len: text.length });
          return json({ error: "parse_failed", raw: text.slice(0, 500) }, 502);
        }

        // Compute each line total = qty × unit_price (NEVER read the line total
        // off the slip — that was the EMCO bug, grabbing unit price as the total).
        // Then fuzzy-match each line to a catalog material.
        const items = Array.isArray(parsed.items) ? parsed.items : [];
        for (const it of items) {
          const qty = Number(it.quantity) || 1;
          const unit = Number(it.unit_price != null ? it.unit_price : it.unit_cost) || 0;
          const ext = Number(it.line_total) || 0;
          it.quantity = qty;
          it.unit_cost = round2(unit);        // UI reads unit_cost
          // Prefer the slip's printed EXTENSION (authoritative — handles EMCO's
          // per-100-ft pipe pricing); fall back to qty × unit when none printed.
          it.total = ext > 0 ? round2(ext) : round2(qty * unit);
          delete it.unit_price;
          delete it.line_total;
          const desc = String(it.description || "").trim();
          if (!desc) { it.match = null; continue; }
          const like = `%${desc.slice(0, 30)}%`;
          const m = await env.DB.prepare(
            `SELECT id, code, emco_sku, name, cost FROM crm_materials
              WHERE is_active = 1
                AND (name LIKE ? OR code LIKE ? OR emco_sku LIKE ? OR search_terms LIKE ?)
              ORDER BY length(name) LIMIT 1`
          ).bind(like, like, like, like).first();
          it.match = m ? { id: m.id, name: m.name, code: m.code, emco_sku: m.emco_sku, cost: m.cost } : null;
        }

        // Subtotal / tax / total — routes by what's printed (works for BOTH
        // wholesaler and retail; the math is unchanged from the verified version):
        //  · tax ALREADY on the slip (retail receipt, or Wolseley GST/PST, or a
        //    tax-included total) -> trust the printed grand total; do NOT add 12%.
        //  · NO tax + NO total (a wholesaler packing slip) -> sum the line totals
        //    and apply 12% (PST+GST). A RETAIL receipt should never land here — if
        //    it does, the total was misread, so we flag low_confidence (no silent
        //    fabricated total).
        const sourceType = parsed.source_type || "unknown";
        const lineSum = round2(items.reduce((a, it) => a + (it.total || 0), 0));
        const taxShown = parsed.tax_shown === true;
        const shownTotal = Number(parsed.shown_total) || 0;   // 0.00 → ignored
        const shownTax = Number(parsed.shown_tax) || 0;
        const shownSub = Number(parsed.shown_subtotal) || 0;
        let subtotal, tax, total, low_confidence = false;
        if (taxShown && shownTotal > 0) {
          total = round2(shownTotal);
          subtotal = shownSub > 0 ? round2(shownSub)
            : (shownTax > 0 ? round2(total - shownTax) : round2(total / 1.12));
          tax = shownTax > 0 ? round2(shownTax) : round2(total - subtotal);
        } else {
          subtotal = lineSum;
          tax = round2(subtotal * 0.12);
          total = round2(subtotal * 1.12);
          if (sourceType === "retail") low_confidence = true;  // retail always has a total → this is a misread
        }

        await logScan(stopReason === "max_tokens" ? "success_truncated" : "success",
          { status: aiResp.status, stop_reason: stopReason, source_type: sourceType, supplier: parsed.supplier || "", item_count: items.length, raw: text, raw_len: text.length });

        return json({
          ok: true,
          job_id: scanMatch[1],
          source_type: sourceType,
          supplier: parsed.supplier || "",
          items,                                  // each: {description, quantity, unit_cost, total, match}
          subtotal, tax, total,
          tax_shown: taxShown,                    // true = tax already on the slip (not re-taxed)
          low_confidence,                         // true = retail receipt with no readable total (double-check)
        });
      }

      // --- 4d. Commit a confirmed receipt (NO van deduction) -------------
      // POST /api/jobs/:jobId/purchases   Body: {
      //   tech_id, supplier, total, description?, job_number?, receipt_photo_url?,
      //   items: [{ description, quantity, unit_cost, total, material_id?, log_to_materials? }]
      // }
      // Writes ONE crm_job_purchases row (the receipt header). For each item the
      // tech matched AND flagged (material_id set AND log_to_materials===true),
      // also writes a crm_job_materials line at the frozen cost — but NEVER
      // touches van stock (no job_usage movement). A receipt is purchase cost,
      // not a van draw-down.
      const purchMatch = p.match(/^\/api\/jobs\/([^/]+)\/purchases$/);
      if (purchMatch && request.method === "POST") {
        const jobId = purchMatch[1];
        const b = await request.json().catch(() => ({}));
        if (techTok) b.tech_id = techTok.payload.tech_id;   // T1: server-stamp actor from token; falls back to client body
        const supplier = (b.supplier || "").trim();
        const total = Number(b.total);
        if (!supplier) return json({ error: "supplier required" }, 400);
        if (!Number.isFinite(total)) return json({ error: "total must be a number" }, 400);
        if (b.tech_id == null) return json({ error: "tech_id required" }, 400);
        const subtotal = Number.isFinite(Number(b.subtotal)) ? Number(b.subtotal) : null;
        const tax = Number.isFinite(Number(b.tax)) ? Number(b.tax) : null;

        const items = Array.isArray(b.items) ? b.items : [];
        const description = (b.description && String(b.description).trim()) ||
          items.map((i) => i.description).filter(Boolean).slice(0, 4).join(", ") || null;

        // 1) Receipt header -> crm_job_purchases.
        const ins = await env.DB.prepare(
          `INSERT INTO crm_job_purchases
             (job_id, job_number, supplier, receipt_total, subtotal, tax, description, receipt_photo_url, tech_id, truck_location_id)
           VALUES (?,?,?,?,?,?,?,?,?,?)`
        ).bind(
          jobId,
          b.job_number ?? String(jobId),
          supplier,
          total,             // receipt_total = tax-included total = the cost of record (option A)
          subtotal,
          tax,
          description,
          b.receipt_photo_url ?? null,
          b.tech_id,
          b.truck_location_id ?? null
        ).run();
        const purchaseId = ins.meta?.last_row_id ?? null;

        // 1b) Store the receipt photo in R2 (PRIVATE; served via
        // /api/purchases/:id/photo). Reuses the base64 the tech already captured
        // for the scan — no second photo. Non-fatal: a storage hiccup must never
        // lose the receipt itself.
        if (purchaseId && b.image_base64 && env.RECEIPTS) {
          try {
            const key = `receipts/${purchaseId}.jpg`;
            const bytes = Uint8Array.from(atob(b.image_base64), (c) => c.charCodeAt(0));
            await env.RECEIPTS.put(key, bytes, { httpMetadata: { contentType: b.media_type || "image/jpeg" } });
            await env.DB.prepare(`UPDATE crm_job_purchases SET receipt_photo_url = ? WHERE id = ?`).bind(key, purchaseId).run();
          } catch (_) { /* photo is optional — keep the receipt */ }
        }

        // 2) Optionally log matched lines to crm_job_materials — NO deduction.
        const loggedLines = [];
        for (const it of items) {
          if (it.material_id == null || it.log_to_materials !== true) continue;
          try {
            const qty = Number(it.quantity) || 1;
            // Freeze cost: prefer the receipt's unit_cost, else catalog cost.
            let unitCost = Number(it.unit_cost);
            if (!Number.isFinite(unitCost) || unitCost <= 0) {
              const mat = await env.DB.prepare(`SELECT cost FROM crm_materials WHERE id = ?`).bind(it.material_id).first();
              unitCost = mat ? (mat.cost ?? 0) : 0;
            }
            const lineTotal = unitCost * qty;
            const mIns = await env.DB.prepare(
              `INSERT INTO crm_job_materials
                 (job_id, job_number, material_id, quantity, unit_cost, total_cost,
                  tech_id, truck_location_id, notes, is_prepull)
               VALUES (?,?,?,?,?,?,?,?,?,?)`
            ).bind(jobId, b.job_number ?? String(jobId), it.material_id, qty, unitCost, lineTotal,
              b.tech_id, null, receiptTag(purchaseId), 0).run();   // GP-exclusion tag
            loggedLines.push({ material_id: it.material_id, line_id: mIns.meta?.last_row_id ?? null,
              quantity: qty, unit_cost: unitCost, total_cost: lineTotal });
          } catch (e) {
            loggedLines.push({ material_id: it.material_id, error: String(e.message || e) });
          }
        }

        return json({
          ok: true,
          job_id: jobId,
          purchase_id: purchaseId,
          supplier, subtotal, tax, receipt_total: total,
          logged_to_materials: loggedLines,   // matched lines also recorded as job materials (tagged for GP exclusion)
          deducted_van_stock: false,          // explicit: receipts never draw down the van
        });
      }

      // --- 4e. View a job's receipt purchases (+ the lines each created) --
      // GET /api/jobs/:jobId/purchases -> { purchases:[{ id, supplier, subtotal,
      // tax, receipt_total, description, created_at, lines:[matched materials] }]}.
      if (purchMatch && request.method === "GET") {
        const jobId = purchMatch[1];
        const purchases = (await env.DB.prepare(
          `SELECT id, supplier, subtotal, tax, receipt_total, description, created_at,
                  (receipt_photo_url IS NOT NULL) AS has_photo
             FROM crm_job_purchases WHERE job_id = ? ORDER BY id DESC`
        ).bind(jobId).all()).results || [];
        const mlines = (await env.DB.prepare(
          `SELECT jm.id AS line_id, jm.material_id, m.name AS material, m.emco_sku,
                  jm.quantity, jm.unit_cost, jm.total_cost, jm.notes
             FROM crm_job_materials jm LEFT JOIN crm_materials m ON m.id = jm.material_id
            WHERE jm.job_id = ? AND jm.notes LIKE ?`
        ).bind(jobId, RECEIPT_TAG_PREFIX + "%").all()).results || [];
        const byPurchase = {};
        for (const ln of mlines) {
          const mm = /receipt purchase #(\d+)/.exec(ln.notes || "");
          if (mm) (byPurchase[mm[1]] ??= []).push(ln);
        }
        return json({ purchases: purchases.map((pp) => ({ ...pp, lines: byPurchase[pp.id] || [] })) });
      }

      // --- 4f. Delete / edit one receipt purchase (job-scoped) -----------
      // DELETE /api/jobs/:jobId/purchases/:id -> remove the receipt + the matched
      //   lines it created (the GP-tagged crm_job_materials rows). NO van reversal
      //   — purchases never wrote a job_usage movement, so nothing was deducted.
      // PATCH  /api/jobs/:jobId/purchases/:id  body { supplier?, subtotal?, tax?,
      //   total? } -> edit the receipt header only.
      const purchOne = p.match(/^\/api\/jobs\/([^/]+)\/purchases\/(\d+)$/);
      if (purchOne && (request.method === "DELETE" || request.method === "PATCH")) {
        const jobId = purchOne[1];
        const purchaseId = purchOne[2];
        const row = await env.DB.prepare(
          `SELECT id, job_id FROM crm_job_purchases WHERE id = ?`
        ).bind(purchaseId).first();
        if (!row || String(row.job_id) !== String(jobId)) return json({ error: "not found" }, 404);

        if (request.method === "DELETE") {
          await env.DB.batch([
            env.DB.prepare(`DELETE FROM crm_job_materials WHERE job_id = ? AND notes = ?`)
              .bind(jobId, receiptTag(purchaseId)),
            env.DB.prepare(`DELETE FROM crm_job_purchases WHERE id = ?`).bind(purchaseId),
          ]);
          // Drop the receipt photo from R2 too (non-fatal). Report the outcome
          // so a storage failure is visible, not silently swallowed.
          let photo_removed = false, photo_error = null;
          if (env.RECEIPTS) {
            try { await env.RECEIPTS.delete(`receipts/${purchaseId}.jpg`); photo_removed = true; }
            catch (e) { photo_error = String(e?.message || e); }
          }
          return json({ ok: true, deleted_purchase: Number(purchaseId), photo_removed, photo_error, deducted_van_stock: false });
        }

        // PATCH — header only (matched lines are edited as ordinary materials).
        const b = await request.json().catch(() => ({}));
        const sets = [], binds = [];
        if (b.supplier != null && String(b.supplier).trim()) { sets.push("supplier = ?"); binds.push(String(b.supplier).trim()); }
        if (b.subtotal != null && Number.isFinite(Number(b.subtotal))) { sets.push("subtotal = ?"); binds.push(Number(b.subtotal)); }
        if (b.tax != null && Number.isFinite(Number(b.tax))) { sets.push("tax = ?"); binds.push(Number(b.tax)); }
        if (b.total != null && Number.isFinite(Number(b.total))) { sets.push("receipt_total = ?"); binds.push(Number(b.total)); }
        if (!sets.length) return json({ error: "nothing to update" }, 400);
        await env.DB.prepare(`UPDATE crm_job_purchases SET ${sets.join(", ")} WHERE id = ?`).bind(...binds, purchaseId).run();
        const updated = await env.DB.prepare(
          `SELECT id, supplier, subtotal, tax, receipt_total FROM crm_job_purchases WHERE id = ?`
        ).bind(purchaseId).first();
        return json({ ok: true, purchase: updated });
      }

      // --- 4f2. Off-cycle / overhead purchase (NO job) -------------------
      // POST /api/overhead/purchases  Body: { tech_id, supplier, total, subtotal?,
      //   tax?, description?, image_base64?, media_type?, items? }
      // Writes ONE crm_job_purchases row flagged is_overhead=1 with the job_id=0
      // sentinel (the column is NOT NULL). NO matched crm_job_materials lines and
      // NO van deduction — structurally a job receipt minus the job, so it touches
      // ZERO inventory.
      if (p === "/api/overhead/purchases" && request.method === "POST") {
        const b = await request.json().catch(() => ({}));
        if (techTok) b.tech_id = techTok.payload.tech_id;   // T1: server-stamp actor from token; falls back to client body
        const supplier = (b.supplier || "").trim();
        const total = Number(b.total);
        if (!supplier) return json({ error: "supplier required" }, 400);
        if (!Number.isFinite(total)) return json({ error: "total must be a number" }, 400);
        if (b.tech_id == null) return json({ error: "tech_id required" }, 400);
        const subtotal = Number.isFinite(Number(b.subtotal)) ? Number(b.subtotal) : null;
        const tax = Number.isFinite(Number(b.tax)) ? Number(b.tax) : null;
        const items = Array.isArray(b.items) ? b.items : [];
        const description = (b.description && String(b.description).trim()) ||
          items.map((i) => i.description).filter(Boolean).slice(0, 4).join(", ") || null;

        // ONE row, is_overhead=1, job_id=0 sentinel. No crm_job_materials writes.
        const ins = await env.DB.prepare(
          `INSERT INTO crm_job_purchases
             (job_id, job_number, supplier, receipt_total, subtotal, tax, description, receipt_photo_url, tech_id, truck_location_id, is_overhead)
           VALUES (0, NULL, ?, ?, ?, ?, ?, NULL, ?, NULL, 1)`
        ).bind(supplier, total, subtotal, tax, description, b.tech_id).run();
        const purchaseId = ins.meta?.last_row_id ?? null;

        // Receipt photo -> R2 (same as job receipts). Non-fatal.
        if (purchaseId && b.image_base64 && env.RECEIPTS) {
          try {
            const key = `receipts/${purchaseId}.jpg`;
            const bytes = Uint8Array.from(atob(b.image_base64), (c) => c.charCodeAt(0));
            await env.RECEIPTS.put(key, bytes, { httpMetadata: { contentType: b.media_type || "image/jpeg" } });
            await env.DB.prepare(`UPDATE crm_job_purchases SET receipt_photo_url = ? WHERE id = ?`).bind(key, purchaseId).run();
          } catch (_) { /* photo optional */ }
        }

        return json({
          ok: true,
          purchase_id: purchaseId,
          is_overhead: true,
          supplier, subtotal, tax, receipt_total: total,
          logged_to_materials: [],     // overhead writes ZERO job-material lines
          deducted_van_stock: false,   // and NEVER touches van stock
        });
      }

      // --- 4g. Office-wide receipts list ---------------------------------
      // GET /api/purchases?tech_id=&supplier=&from=YYYY-MM-DD&to=YYYY-MM-DD
      // All purchases newest-first with tech name + customer/job + matched
      // lines. Powers the office "Receipts" screen. Edit/delete reuse the
      // job-scoped PATCH/DELETE /api/jobs/:jobId/purchases/:id.
      if (p === "/api/purchases" && request.method === "GET") {
        const where = [], binds = [];
        const techId = url.searchParams.get("tech_id");
        const supplier = url.searchParams.get("supplier");
        const from = url.searchParams.get("from");   // YYYY-MM-DD (inclusive)
        const to = url.searchParams.get("to");       // YYYY-MM-DD (inclusive)
        if (techId) { where.push("p.tech_id = ?"); binds.push(techId); }
        if (supplier) { where.push("p.supplier LIKE ?"); binds.push(`%${supplier}%`); }
        if (from) { where.push("p.created_at >= ?"); binds.push(from); }
        if (to) { where.push("p.created_at < datetime(?, '+1 day')"); binds.push(to); }
        const whereSql = where.length ? "WHERE " + where.join(" AND ") : "";
        const purchases = (await env.DB.prepare(
          `SELECT p.id, p.job_id, p.job_number, p.supplier, p.subtotal, p.tax,
                  p.receipt_total, p.description, p.tech_id, p.truck_location_id,
                  p.created_at, (p.receipt_photo_url IS NOT NULL) AS has_photo, p.is_overhead,
                  t.name AS tech_name, j.status AS job_status,
                  c.name AS customer, c.address_street, c.address_city
             FROM crm_job_purchases p
             LEFT JOIN crm_techs t        ON t.st_tech_id = p.tech_id
             LEFT JOIN crm_st_jobs j      ON j.id = p.job_id
             LEFT JOIN crm_st_customers c ON c.id = j.customer_id
             ${whereSql}
            ORDER BY p.id DESC
            LIMIT 500`
        ).bind(...binds).all()).results || [];

        // Matched lines for these purchases, keyed by the GP-exclusion tag.
        // Chunk the IN list by 100 (D1 bind-variable safety).
        const ids = purchases.map((x) => x.id);
        const byPurchase = {};
        for (let i = 0; i < ids.length; i += 100) {
          const notes = ids.slice(i, i + 100).map((id) => receiptTag(id));
          const ph = notes.map(() => "?").join(",");
          const rows = (await env.DB.prepare(
            `SELECT jm.id AS line_id, jm.material_id, m.name AS material, m.emco_sku,
                    jm.quantity, jm.unit_cost, jm.total_cost, jm.notes
               FROM crm_job_materials jm LEFT JOIN crm_materials m ON m.id = jm.material_id
              WHERE jm.notes IN (${ph})`
          ).bind(...notes).all()).results || [];
          for (const ln of rows) {
            const mm = /receipt purchase #(\d+)/.exec(ln.notes || "");
            if (mm) (byPurchase[mm[1]] ??= []).push(ln);
          }
        }
        return json({ purchases: purchases.map((pp) => ({ ...pp, lines: byPurchase[pp.id] || [] })) });
      }

      // --- 4h. Serve a receipt photo from R2 (PRIVATE; through the worker) --
      // GET /api/purchases/:id/photo -> the stored JPEG, or 404 if none.
      const photoMatch = p.match(/^\/api\/purchases\/(\d+)\/photo$/);
      if (photoMatch && request.method === "GET") {
        const row = await env.DB.prepare(
          `SELECT receipt_photo_url FROM crm_job_purchases WHERE id = ?`
        ).bind(photoMatch[1]).first();
        if (!row || !row.receipt_photo_url) return json({ error: "no_photo" }, 404);
        if (!env.RECEIPTS) return json({ error: "storage_unbound" }, 503);
        const obj = await env.RECEIPTS.get(row.receipt_photo_url);
        if (!obj) return json({ error: "not_in_storage" }, 404);
        return new Response(obj.body, {
          headers: {
            "content-type": obj.httpMetadata?.contentType || "image/jpeg",
            "cache-control": "private, max-age=86400",
            "access-control-allow-origin": "*",
          },
        });
      }

      // --- 5a. Replenishment list for a van ------------------------------
      // GET /api/restock/:locationId/list
      // The validated replenishment query: materials on this van below reorder
      // point (on_hand < min_qty), with the suggested pull to bring them to par
      // (max_qty - on_hand). Matches what we validated against loc 2.
      const restockListMatch = p.match(/^\/api\/restock\/([^/]+)\/list$/);
      if (restockListMatch && request.method === "GET") {
        const locationId = restockListMatch[1];
        const r = await env.DB.prepare(
          `SELECT s.material_id, m.name, m.emco_sku, m.cost,
                  s.on_hand, s.min_qty, s.max_qty,
                  (s.max_qty - s.on_hand) AS suggested_pull
             FROM crm_inventory_stock s
             JOIN crm_materials m ON m.id = s.material_id
            WHERE s.location_id = ? AND s.on_hand < s.min_qty
              AND m.deduct_on_use = 1   -- cost-only items (pipe, untracked bag) are pulled/counted manually
            ORDER BY m.name`
        ).bind(locationId).all();
        return json({ location_id: Number(locationId) || locationId, items: r.results || [] });
      }

      // --- 5a-bis. Van restock BY JOB ------------------------------------
      // GET /api/restock/:locationId/by-job
      // The usage that drew THIS van down since its last restock, grouped by the
      // jobs that caused it. Source: crm_job_materials for the van's assigned
      // tech, joined to crm_st_jobs/customers, restricted to lines that actually
      // deducted from this van (a job_usage movement at this location) AND logged
      // AFTER the van's most recent transfer_in (restock pull) — so each restock
      // resets the list. Powers the office by-job review/correct section.
      const byJobMatch = p.match(/^\/api\/restock\/([^/]+)\/by-job$/);
      if (byJobMatch && request.method === "GET") {
        const locationId = byJobMatch[1];
        const loc = await env.DB.prepare(
          `SELECT id, type, assigned_tech_id FROM crm_inventory_locations WHERE id = ?`
        ).bind(locationId).first();
        if (!loc) return json({ error: "location not found" }, 404);
        if (loc.type !== "truck") return json({ error: "location is not a truck" }, 400);

        // Anchor: the van's most recent restock pull (transfer_in). Usage since.
        const lastRestock = await env.DB.prepare(
          `SELECT MAX(created_at) AS ts FROM crm_inventory_movements
            WHERE location_id = ? AND reason = 'transfer_in'`
        ).bind(locationId).first();
        const since = (lastRestock && lastRestock.ts) || "1970-01-01";

        const rows = (await env.DB.prepare(
          `SELECT jm.id AS line_id, jm.job_id, jm.material_id, m.name AS material, m.emco_sku,
                  jm.quantity, jm.unit_cost, jm.total_cost, jm.created_at,
                  j.job_number, j.status AS job_status, c.name AS customer,
                  COALESCE(l.address_street, c.address_street) AS address_street,
                  COALESCE(l.address_city, c.address_city) AS address_city,
                  l.name AS location_name
             FROM crm_job_materials jm
             JOIN crm_materials m ON m.id = jm.material_id
             LEFT JOIN crm_st_jobs j ON j.id = jm.job_id
             LEFT JOIN crm_st_locations l ON l.id = j.location_id
             LEFT JOIN crm_st_customers c ON c.id = j.customer_id
            WHERE jm.tech_id = ?
              AND jm.created_at > ?
              AND EXISTS (SELECT 1 FROM crm_inventory_movements mv
                           WHERE mv.reference_id = jm.id AND mv.reason = 'job_usage'
                             AND mv.location_id = ?)
            ORDER BY j.job_number, jm.created_at`
        ).bind(loc.assigned_tech_id, since, locationId).all()).results || [];

        // Group flat rows into jobs (GET order preserved).
        const byJob = new Map();
        for (const r of rows) {
          const key = r.job_id ?? `unknown-${r.line_id}`;
          if (!byJob.has(key)) {
            byJob.set(key, {
              job_id: r.job_id,
              job_number: r.job_number,
              status: r.job_status,
              customer: r.customer,
              address: [r.address_street, r.address_city].filter(Boolean).join(", ") || null,
              location_name: r.location_name || null,
              materials: [],
              purchases: [],
            });
          }
          byJob.get(key).materials.push({
            line_id: r.line_id, material_id: r.material_id, material: r.material,
            emco_sku: r.emco_sku, quantity: r.quantity,
            unit_cost: r.unit_cost, total_cost: r.total_cost,
          });
        }

        // Attach each job's RECEIPT PURCHASES (by this van's tech) for context +
        // office delete/edit. Purchases don't deduct van stock; their matched
        // lines never show in `materials` above (no job_usage movement).
        const jobIds = [...byJob.keys()].filter((k) => /^\d+$/.test(String(k)));
        if (jobIds.length) {
          const ph = jobIds.map(() => "?").join(",");
          const purchases = (await env.DB.prepare(
            `SELECT id, job_id, supplier, subtotal, tax, receipt_total, created_at,
                    (receipt_photo_url IS NOT NULL) AS has_photo
               FROM crm_job_purchases
              WHERE tech_id = ? AND job_id IN (${ph})
              ORDER BY id DESC`
          ).bind(loc.assigned_tech_id, ...jobIds).all()).results || [];
          for (const pu of purchases) {
            const job = byJob.get(pu.job_id);
            if (job) job.purchases.push(pu);
          }
        }

        return json({
          location_id: Number(locationId) || locationId,
          tech_id: loc.assigned_tech_id,
          since,
          jobs: [...byJob.values()],
        });
      }

      // --- 5a-ter. Recent usage for correction (NOT restock-anchored) -------
      // GET /api/restock/:locationId/recent-usage?days=7
      // Same join as by-job, but windowed by a ROLLING N-day window instead of
      // the last-restock anchor — so a mis-logged line stays reachable even after
      // a restock rolled it off the by-job view. Keeps the EXISTS job_usage-at-
      // this-loc guard, so every row is a real, 1:1-reversible van deduction
      // (delete -> DELETE /jobs/:id/materials/:lineId reverses THAT line's usage).
      // Powers the office "Correct a mis-logged item" panel. Read-only.
      const recentUsageMatch = p.match(/^\/api\/restock\/([^/]+)\/recent-usage$/);
      if (recentUsageMatch && request.method === "GET") {
        const locationId = recentUsageMatch[1];
        const loc = await env.DB.prepare(
          `SELECT id, type, assigned_tech_id FROM crm_inventory_locations WHERE id = ?`
        ).bind(locationId).first();
        if (!loc) return json({ error: "location not found" }, 404);
        if (loc.type !== "truck") return json({ error: "location is not a truck" }, 400);

        const days = Math.min(30, Math.max(1, parseInt(url.searchParams.get("days") || "7", 10) || 7));
        const win = `-${days} days`;

        const rows = (await env.DB.prepare(
          `SELECT jm.id AS line_id, jm.job_id, jm.material_id, m.name AS material, m.emco_sku,
                  jm.quantity, jm.unit_cost, jm.total_cost, jm.created_at,
                  j.job_number, j.status AS job_status, c.name AS customer,
                  COALESCE(l.address_street, c.address_street) AS address_street,
                  COALESCE(l.address_city, c.address_city) AS address_city,
                  l.name AS location_name
             FROM crm_job_materials jm
             JOIN crm_materials m ON m.id = jm.material_id
             LEFT JOIN crm_st_jobs j ON j.id = jm.job_id
             LEFT JOIN crm_st_locations l ON l.id = j.location_id
             LEFT JOIN crm_st_customers c ON c.id = j.customer_id
            WHERE jm.tech_id = ?
              AND jm.created_at >= datetime('now', ?)
              AND EXISTS (SELECT 1 FROM crm_inventory_movements mv
                           WHERE mv.reference_id = jm.id AND mv.reason = 'job_usage'
                             AND mv.location_id = ?)
            ORDER BY jm.created_at DESC, j.job_number`
        ).bind(loc.assigned_tech_id, win, locationId).all()).results || [];

        // Group into jobs (newest line first preserved within each job).
        const byJob = new Map();
        for (const r of rows) {
          const key = r.job_id ?? `unknown-${r.line_id}`;
          if (!byJob.has(key)) {
            byJob.set(key, {
              job_id: r.job_id, job_number: r.job_number, status: r.job_status,
              customer: r.customer,
              address: [r.address_street, r.address_city].filter(Boolean).join(", ") || null,
              location_name: r.location_name || null,
              materials: [],
            });
          }
          byJob.get(key).materials.push({
            line_id: r.line_id, material_id: r.material_id, material: r.material,
            emco_sku: r.emco_sku, quantity: r.quantity,
            unit_cost: r.unit_cost, total_cost: r.total_cost, created_at: r.created_at,
          });
        }

        return json({
          location_id: Number(locationId) || locationId,
          tech_id: loc.assigned_tech_id,
          days,
          jobs: [...byJob.values()],
        });
      }

      // --- 5. Confirm a van restock --------------------------------------
      // POST /api/restock/:locationId/confirm
      // Body: { items: [{ material_id, action, qty }], created_by? }
      // action is one of four per-line outcomes, ATOMIC and NON-FATAL per item:
      //   "pull_shop"  : van.on_hand += qty (transfer_in) AND shop(loc 1).on_hand
      //                  -= qty (transfer_out) in ONE batch — both legs share a
      //                  reference_id. The standard pull from the counted shelf.
      //   "pull_other" : van.on_hand += qty (transfer_in) ONLY — shop UNTOUCHED.
      //                  Parts came from loose extras, not the counted shelf; the
      //                  lone transfer_in is noted as an other/manual source.
      //   "shop_out"   : NO stock change, NO refill. Seed a crm_inventory_requests
      //                  row (type 'shop_reorder') for the shortfall (max_qty -
      //                  on_hand) to flag it for EMCO.
      //   "skip"       : remove the line — no van, shop, or reorder change.
      // One item failing is reported as 'failed' and never blocks the others.
      const restockMatch = p.match(/^\/api\/restock\/([^/]+)\/confirm$/);
      if (restockMatch && request.method === "POST") {
        const locationId = restockMatch[1];
        const body = await request.json();
        const items = Array.isArray(body.items) ? body.items : null;
        if (!items) return json({ error: "items array required" }, 400);
        // Restock operator: crm_users.id used for movement created_by AND the
        // shop_reorder requested_by (which is NOT NULL). Defaults to the
        // Warehouse Manager (crm_users.id 8) unless the caller passes created_by.
        // TODO: requests.requested_by is commented FK crm_users.id; revisit if a
        // dedicated office requester is introduced later.
        const OFFICE_OPERATOR = 8; // crm_users.id — Warehouse Manager
        const operator = body.created_by ?? OFFICE_OPERATOR;
        const WAREHOUSE_ID = 1; // Shop Warehouse (type='warehouse')

        // Guard: the target must be an existing truck — never the shop or a bad id.
        const loc = await env.DB.prepare(
          `SELECT id, type FROM crm_inventory_locations WHERE id = ?`
        ).bind(locationId).first();
        if (!loc) return json({ error: "location not found" }, 404);
        if (loc.type !== "truck") return json({ error: "location is not a truck" }, 400);

        // Base for transfer reference_ids — each item's two legs share refBase+i,
        // so the in/out legs of one pull are linkable (and distinct per item).
        // FUTURE IMPROVEMENT: create a real crm_inventory_transfers record per
        // pull and use its id as reference_id (true FK, reversible like CRM's
        // /transfers/:id/reverse) instead of this synthetic shared token.
        const refBase = Date.now() * 1000;
        const batchId = crypto.randomUUID();   // one id for this whole confirm action (undo target)

        const results = [];
        for (let i = 0; i < items.length; i++) {
          const it = items[i] || {};
          const mid = it.material_id;
          const action = it.action || "skip";   // pull_shop | pull_other | shop_out | skip
          const qty = Number(it.qty) || 0;
          const ref = refBase + i;               // links the leg(s) of THIS line
          try {
            if (mid == null) throw new Error("material_id required");

            if (action === "pull_shop") {
              // Shared transfer engine (factored). Office keeps its behavior:
              // van/shop row required — a throw becomes a "failed" result below,
              // no auto-create, no shortfall field.
              results.push(await pullShopToVan(env, locationId, mid, qty, operator, ref, { batchId }));

            } else if (action === "pull_other") {
              // Van += qty only. Shop UNTOUCHED — parts came from loose extras,
              // not the counted shelf. A lone transfer_in noted as other source.
              if (qty <= 0) throw new Error("qty required for a pull");
              const vanRow = await env.DB.prepare(
                `SELECT id, on_hand FROM crm_inventory_stock
                  WHERE location_id = ? AND material_id = ?`
              ).bind(locationId, mid).first();
              if (!vanRow) throw new Error("no van stock row");

              await env.DB.batch([
                env.DB.prepare(
                  `UPDATE crm_inventory_stock
                      SET on_hand = ?, last_restocked = datetime('now'), modified_at = datetime('now')
                    WHERE id = ?`
                ).bind((vanRow.on_hand ?? 0) + qty, vanRow.id),
                env.DB.prepare(
                  `INSERT INTO crm_inventory_movements
                     (material_id, location_id, qty_change, reason, reference_id, notes, created_by, batch_id)
                   VALUES (?,?,?,?,?,?,?,?)`
                ).bind(mid, locationId, qty, "transfer_in", ref, "restock pull (other source — not from shop)", operator, batchId),
              ]);
              results.push({ material_id: mid, result: "pulled_other", quantity: qty });

            } else if (action === "shop_out") {
              // No stock change, NO refill. Seed a shop_reorder request for the
              // shortfall (max_qty - on_hand) to flag it for EMCO.
              const vanRow = await env.DB.prepare(
                `SELECT on_hand, max_qty FROM crm_inventory_stock
                  WHERE location_id = ? AND material_id = ?`
              ).bind(locationId, mid).first();
              if (!vanRow) throw new Error("no van stock row");
              const shortfall = (vanRow.max_qty ?? 0) - (vanRow.on_hand ?? 0);
              if (shortfall <= 0) {
                results.push({ material_id: mid, result: "skipped", reason: "at_or_above_par" });
              } else {
                await env.DB.prepare(
                  `INSERT INTO crm_inventory_requests
                     (material_id, quantity, truck_location_id, requested_by, status, type, notes)
                   VALUES (?,?,?,?,?,?,?)`
                ).bind(mid, shortfall, locationId, operator, "pending", "shop_reorder", "shop out during restock").run();
                results.push({ material_id: mid, result: "shop_reorder", quantity: shortfall });
              }

            } else {
              // skip / delete — line removed from this restock. No change anywhere.
              results.push({ material_id: mid, result: "skipped" });
            }
          } catch (e) {
            results.push({ material_id: mid, result: "failed", error: String(e.message || e) });
          }
        }

        // Return the van's updated on_hand for each material (chunked to stay
        // under D1's SQL-variable limit).
        const mids = [...new Set(items.map((x) => x && x.material_id).filter((x) => x != null))];
        const onHandMap = {};
        for (let j = 0; j < mids.length; j += 100) {
          const chunk = mids.slice(j, j + 100);
          const ph = chunk.map(() => "?").join(",");
          const r = await env.DB.prepare(
            `SELECT material_id, on_hand FROM crm_inventory_stock
              WHERE location_id = ? AND material_id IN (${ph})`
          ).bind(locationId, ...chunk).all();
          for (const sr of (r.results || [])) onHandMap[sr.material_id] = sr.on_hand;
        }
        const on_hand = Object.entries(onHandMap).map(
          ([material_id, oh]) => ({ material_id: Number(material_id), on_hand: oh })
        );

        return json({ location_id: Number(locationId) || locationId, batch_id: batchId, results, on_hand });
      }

      // --- Restock/receive UNDO (batch-scoped, auditable) ----------------
      // GET /api/restock/:loc/batches — recent confirm batches that stocked THIS van
      // (newest first), each with its lines + undone flag, for the undo UI.
      const batchesMatch = p.match(/^\/api\/restock\/([^/]+)\/batches$/);
      if (batchesMatch && request.method === "GET") {
        const locId = Number(batchesMatch[1]);
        const rows = (await env.DB.prepare(
          `SELECT m.batch_id, m.material_id, m.qty_change, m.created_at, m.created_by, m.undone_at, mat.name AS material
             FROM crm_inventory_movements m LEFT JOIN crm_materials mat ON mat.id = m.material_id
            WHERE m.location_id = ? AND m.reason = 'transfer_in'
              AND m.batch_id IS NOT NULL AND m.batch_id NOT LIKE 'undo:%'
            ORDER BY m.created_at DESC, m.id DESC`
        ).bind(locId).all()).results || [];
        const byBatch = new Map();
        for (const r of rows) {
          let b = byBatch.get(r.batch_id);
          if (!b) { b = { batch_id: r.batch_id, created_at: r.created_at, created_by: r.created_by, lines: [] }; byBatch.set(r.batch_id, b); }
          b.lines.push({ material_id: r.material_id, material: r.material, qty: r.qty_change, undone: !!r.undone_at });
        }
        const batches = [...byBatch.values()].map((b) => ({ ...b, undone: b.lines.every((l) => l.undone) })).slice(0, 25);

        // Covered-usage rollup: a restock refills the van to par to cover the
        // usage since the PREVIOUS restock — so a batch has no single job, but it
        // DOES cover the jobs whose van usage falls in (prevRestock, thisBatch].
        // Attach those jobs (date · customer · address) so the office can tell
        // what each refill was for. This is a time-window attribution, not a
        // stored 1:1 link (a pull-to-par can't map a unit to a single job).
        const vloc = await env.DB.prepare(
          `SELECT assigned_tech_id FROM crm_inventory_locations WHERE id = ?`
        ).bind(locId).first();
        const techId = vloc && vloc.assigned_tech_id;
        if (techId != null && batches.length) {
          const asc = [...batches].reverse();                  // oldest → newest
          const oldestTs = asc[0].created_at;
          // Floor = the transfer_in immediately BEFORE the oldest displayed batch
          // (so that batch gets a real window), else the epoch. Exclude the oldest
          // batch's OWN legs — its 7 legs can span a second (17:04:40→:41), and the
          // batch's representative created_at is the max, so `< oldestTs` would
          // otherwise match its own earlier legs and collapse the window to ~1s.
          const prev = await env.DB.prepare(
            `SELECT MAX(created_at) AS ts FROM crm_inventory_movements
              WHERE location_id = ? AND reason = 'transfer_in'
                AND batch_id IS NOT NULL AND batch_id NOT LIKE 'undo:%'
                AND batch_id <> ?
                AND created_at < ?`
          ).bind(locId, asc[0].batch_id, oldestTs).first();
          const floor = (prev && prev.ts) || "1970-01-01";
          // Each batch's window starts at the prior batch's time (floor for the oldest).
          const starts = asc.map((b, i) => (i === 0 ? floor : asc[i - 1].created_at));
          // All van-usage lines (this van's tech, job_usage-backed) since the floor.
          const usage = (await env.DB.prepare(
            `SELECT jm.created_at, jm.job_id, j.job_number,
                    c.name AS customer, c.address_street, c.address_city
               FROM crm_job_materials jm
               LEFT JOIN crm_st_jobs j ON j.id = jm.job_id
               LEFT JOIN crm_st_customers c ON c.id = j.customer_id
              WHERE jm.tech_id = ? AND jm.created_at > ?
                AND EXISTS (SELECT 1 FROM crm_inventory_movements mv
                             WHERE mv.reference_id = jm.id AND mv.reason = 'job_usage'
                               AND mv.location_id = ?)
              ORDER BY jm.created_at`
          ).bind(techId, floor, locId).all()).results || [];
          for (const u of usage) {
            // Bucket into the batch whose window (starts[i], asc[i].created_at] holds it.
            let idx = -1;
            for (let i = 0; i < asc.length; i++) {
              if (u.created_at > starts[i] && u.created_at <= asc[i].created_at) { idx = i; break; }
            }
            if (idx === -1) continue;                          // usage not yet refilled by any shown batch
            const b = asc[idx];
            if (!b._jobs) b._jobs = new Map();
            const key = u.job_id != null ? "j" + u.job_id : "t" + u.created_at;
            if (!b._jobs.has(key)) b._jobs.set(key, {
              job_id: u.job_id, job_number: u.job_number, customer: u.customer,
              address: [u.address_street, u.address_city].filter(Boolean).join(", ") || null,
              first_used: u.created_at, last_used: u.created_at, lines: 0,
            });
            const jj = b._jobs.get(key); jj.lines += 1; jj.last_used = u.created_at;
          }
          for (const b of batches) { b.covered_jobs = b._jobs ? [...b._jobs.values()] : []; delete b._jobs; }
        }
        return json({ location_id: locId, batches });
      }

      // GET /api/reorder/po/:id/receipts — receive events (batches) for one PO.
      const poReceiptsMatch = p.match(/^\/api\/reorder\/po\/(\d+)\/receipts$/);
      if (poReceiptsMatch && request.method === "GET") {
        const poId = Number(poReceiptsMatch[1]);
        const rows = (await env.DB.prepare(
          `SELECT m.batch_id, m.material_id, m.qty_change, m.created_at, m.created_by, m.undone_at, mat.name AS material
             FROM crm_inventory_movements m LEFT JOIN crm_materials mat ON mat.id = m.material_id
            WHERE m.reason = 'po_receive' AND m.reference_id = ?
              AND m.batch_id IS NOT NULL AND m.batch_id NOT LIKE 'undo:%'
            ORDER BY m.created_at DESC, m.id DESC`
        ).bind(poId).all()).results || [];
        const byBatch = new Map();
        for (const r of rows) {
          let b = byBatch.get(r.batch_id);
          if (!b) { b = { batch_id: r.batch_id, created_at: r.created_at, created_by: r.created_by, lines: [] }; byBatch.set(r.batch_id, b); }
          b.lines.push({ material_id: r.material_id, material: r.material, qty: r.qty_change, undone: !!r.undone_at });
        }
        const receipts = [...byBatch.values()].map((b) => ({ ...b, undone: b.lines.every((l) => l.undone) }));
        return json({ po_id: poId, receipts });
      }

      // POST /api/inventory/batch/:batchId/undo  body { material_id?, created_by? }
      // Whole-batch undo, or one line (material_id). Reverses inventory + writes
      // reversing ledger legs. Idempotent (undone_at blocks a second undo).
      const undoMatch = p.match(/^\/api\/inventory\/batch\/([^/]+)\/undo$/);
      if (undoMatch && request.method === "POST") {
        const batchId = decodeURIComponent(undoMatch[1]);
        const body = await request.json().catch(() => ({}));
        const res = await undoBatch(env, batchId, { materialId: body.material_id ?? null, operator: body.created_by ?? 8 });
        return json(res, res.ok ? 200 : 409);
      }

      // --- 5c. Tech-initiated restock FROM SHOP (no job, no purchase) -----
      // POST /api/restock/from-shop  { st_tech_id, items:[{material_id, quantity}] }
      // Resolves the tech's van and runs each item through the SAME pullShopToVan
      // transfer (shop loc 1 -> van). PURE inventory: transfer_out + transfer_in,
      // NO purchase, NO crm_job_materials line. Insufficient shop -> pull + flag
      // shop_shortfall (shop may go negative). Material not on the van -> auto-create
      // the van row; material the shop doesn't track -> result "shop_untracked".
      if (p === "/api/restock/from-shop" && request.method === "POST") {
        const body = await request.json().catch(() => ({}));
        if (techTok) { body.st_tech_id = techTok.payload.tech_id; body.created_by = techTok.payload.tech_id; }   // T1: server-stamp actor from token
        const stTechId = body.st_tech_id;
        const items = Array.isArray(body.items) ? body.items : null;
        if (stTechId == null) return json({ error: "st_tech_id required" }, 400);
        if (!items || !items.length) return json({ error: "items array required" }, 400);

        const van = await env.DB.prepare(
          `SELECT id, name FROM crm_inventory_locations WHERE type='truck' AND active=1 AND assigned_tech_id = ?`
        ).bind(stTechId).first();
        if (!van) return json({ error: "no_van_for_tech", message: "No active van assigned to this tech." }, 404);

        const operator = body.created_by ?? 8;   // crm_users.id — movement created_by
        const refBase = Date.now() * 1000;
        const batchId = crypto.randomUUID();      // one id for this from-shop action (undo target)
        const results = [];
        for (let i = 0; i < items.length; i++) {
          const it = items[i] || {};
          const qty = Number(it.quantity ?? it.qty) || 0;
          try {
            results.push(await pullShopToVan(env, van.id, it.material_id, qty, operator, refBase + i,
              { autoCreateVan: true, reportShortfall: true, batchId, note: `tech restock from shop (tech ${stTechId})` }));
          } catch (e) {
            results.push({ material_id: it.material_id, result: "failed", error: String(e.message || e) });
          }
        }
        return json({ van_id: van.id, van_name: van.name, batch_id: batchId, results });
      }

      // --- 6a. Shop (warehouse) stock — full dump for count/levels views --
      // GET /api/shop/stock -> every loc-1 stock row joined to the catalog,
      // ordered by category then name so the UI can group by category. Feeds
      // both the physical count screen and the min/max levels screen.
      if (p === "/api/shop/stock" && request.method === "GET") {
        return json({ location_id: 1, items: await getLocationStock(env, 1) });
      }

      // --- 6b. Shop stock save — batch (a category's worth at once) -------
      // POST /api/shop/stock
      // Body: { items: [{ material_id, on_hand?, min_qty?, max_qty? }], created_by? }
      // Per item, atomic + non-fatal:
      //   on_hand provided -> set it and stamp last_counted; if it changed,
      //     write a count_adjust movement (qty_change = counted - current) in
      //     the SAME batch so stock + ledger never diverge.
      //   min_qty/max_qty provided -> updated directly on crm_inventory_stock
      //     (thresholds are settings, NOT stock movements).
      //   count + thresholds in one item are applied together.
      if (p === "/api/shop/stock" && request.method === "POST") {
        const body = await request.json();
        const items = Array.isArray(body.items) ? body.items : null;
        if (!items) return json({ error: "items array required" }, 400);
        const operator = body.created_by ?? 8; // crm_users.id — Warehouse Manager
        const results = await saveLocationStock(env, 1, items, operator, "shop count");
        return json({ location_id: 1, results });
      }

      // --- 6c. Stock for ANY location (vans) — same engine, parameterized --
      // GET  /api/locations/:id/stock -> that location's stock (count + levels).
      // POST /api/locations/:id/stock  Body: { items:[{material_id, on_hand?,
      //   min_qty?, max_qty?}], created_by? }. on_hand -> count_adjust movement
      //   AT THIS LOCATION; min/max -> direct. Validates the location exists.
      const locStock = p.match(/^\/api\/locations\/(\d+)\/stock$/);
      if (locStock) {
        const locId = Number(locStock[1]);
        const loc = await env.DB.prepare(
          `SELECT id, name, type, active FROM crm_inventory_locations WHERE id = ?`
        ).bind(locId).first();
        if (!loc) return json({ error: "location not found" }, 404);

        if (request.method === "GET") {
          return json({
            location_id: locId, location_name: loc.name, location_type: loc.type,
            items: await getLocationStock(env, locId),
          });
        }
        if (request.method === "POST") {
          const body = await request.json();
          const items = Array.isArray(body.items) ? body.items : null;
          if (!items) return json({ error: "items array required" }, 400);
          const operator = body.created_by ?? 8; // Warehouse Manager
          const note = (loc.type === "shop" ? "shop" : "van") + " count";
          const results = await saveLocationStock(env, locId, items, operator, note);
          return json({ location_id: locId, location_name: loc.name, results });
        }
      }

      // --- 7. Catalog editor — CRUD on the SHARED crm_materials ----------
      // GET    /api/catalog?q=&all=1   list/search (active only unless all=1)
      // POST   /api/catalog            add a material (+ 0/0/0 stock rows at
      //                                loc 1 & active trucks; optional par on loc 1)
      // PATCH  /api/catalog/:id        edit any fields (fix SKU, category, …)
      // DELETE /api/catalog/:id[?hard=1]  soft-delete (is_active=0), or hard
      //                                delete a junk row if it has no usage.
      if (p === "/api/catalog" && request.method === "GET") {
        const q = (url.searchParams.get("q") || "").trim();
        const all = url.searchParams.get("all") === "1";
        const where = [];
        if (!all) where.push("is_active = 1");
        if (q) where.push("(name LIKE ? OR emco_sku LIKE ? OR code LIKE ?)");
        const stmt = env.DB.prepare(
          `SELECT id, name, emco_sku, code, category, bin_location, cost, price, unit, is_active, search_terms, default_min, default_max,
                  purchase_unit, use_unit, conversion_factor, cost_per_use_override, deduct_on_use,
                  ROUND(COALESCE(cost_per_use_override, CASE WHEN conversion_factor>0 THEN cost/conversion_factor END),2) AS cost_per_use
             FROM crm_materials
            ${where.length ? "WHERE " + where.join(" AND ") : ""}
            ORDER BY category, name`
        );
        const like = `%${q}%`;
        const r = await (q ? stmt.bind(like, like, like) : stmt).all();
        return json({ items: r.results || [] });
      }

      if (p === "/api/catalog" && request.method === "POST") {
        const b = await request.json();
        const name = (b.name || "").trim();
        const category = (b.category || "").trim();
        if (!name || !category) return json({ error: "name and category are required" }, 400);
        const par = b.par != null && b.par !== "" ? Number(b.par) : null;

        // Primary write: the catalog row (id is AUTOINCREMENT).
        const numOr = (v, d) => (v != null && v !== "" && Number.isFinite(Number(v)) ? Number(v) : d);
        // One-number par model: a catalog item's default min ALWAYS equals its
        // default max (no 2/10 buffer). Driven by `par`, else default_max/min,
        // else 0 — so anything added stays on the single-par model.
        const tmpl = par != null ? par : numOr(b.default_max != null ? b.default_max : b.default_min, 0);
        const ins = await env.DB.prepare(
          `INSERT INTO crm_materials
             (name, category, cost, price, emco_sku, code, bin_location, unit, subcategory, search_terms, default_min, default_max)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
        ).bind(
          name, category, Number(b.cost) || 0, Number(b.price) || 0,
          b.emco_sku || null, b.code || null, b.bin_location || null,
          b.unit || null, b.subcategory || null, b.search_terms || null,
          tmpl, tmpl
        ).run();
        const id = ins.meta?.last_row_id ?? null;

        // Side effects (non-fatal, reported): 0/0/0 stock rows at loc 1 + active
        // trucks, then optional par on the shop (loc 1) via a count_adjust.
        let stock = { rows_created: 0 };
        try {
          const locs = (await env.DB.prepare(
            `SELECT id, type FROM crm_inventory_locations
              WHERE active = 1 AND type IN ('warehouse','truck')`
          ).all()).results || [];
          await env.DB.batch(locs.map((l) =>
            env.DB.prepare(
              `INSERT INTO crm_inventory_stock (location_id, material_id, on_hand, min_qty, max_qty)
               VALUES (?,?,0,0,0)`
            ).bind(l.id, id)
          ));
          stock.rows_created = locs.length;

          if (par != null && par > 0) {
            const shop = locs.find((l) => l.type === "warehouse");
            if (shop) {
              await env.DB.batch([
                env.DB.prepare(
                  `UPDATE crm_inventory_stock
                      SET on_hand=?, min_qty=?, max_qty=?, last_counted=datetime('now'), modified_at=datetime('now')
                    WHERE location_id=? AND material_id=?`
                ).bind(par, par, par, shop.id, id),
                env.DB.prepare(
                  `INSERT INTO crm_inventory_movements
                     (material_id, location_id, qty_change, reason, reference_id, notes, created_by)
                   VALUES (?,?,?,?,?,?,?)`
                ).bind(id, shop.id, par, "count_adjust", null, "new item par", b.created_by ?? 8),
              ]);
              stock.par_set = par;
            }
          }
        } catch (e) {
          stock.error = String(e.message || e);
        }

        return json({ ok: true, id, name, category, stock });
      }

      const catMatch = p.match(/^\/api\/catalog\/(\d+)$/);
      if (catMatch && request.method === "PATCH") {
        const id = catMatch[1];
        const b = await request.json();
        const fields = ["name","category","cost","price","emco_sku","code","bin_location","unit","subcategory","search_terms","is_active","default_min","default_max",
                        "purchase_unit","use_unit","conversion_factor","cost_per_use_override","deduct_on_use"];
        const numeric = ["cost","price","is_active","default_min","default_max","conversion_factor","deduct_on_use"];
        const sets = []; const binds = [];
        for (const f of fields) {
          if (b[f] === undefined) continue;
          if ((f === "name" || f === "category") && !String(b[f]).trim()) {
            return json({ error: `${f} cannot be empty` }, 400); // NOT NULL columns
          }
          sets.push(`${f} = ?`);
          binds.push(
            // cost_per_use_override is the nullable escape hatch: blank/null clears it.
            f === "cost_per_use_override" ? (b[f] === null || b[f] === "" ? null : Number(b[f]))
              : numeric.includes(f) ? Number(b[f])
              : (b[f] === null ? null : String(b[f]))
          );
        }
        if (!sets.length) return json({ error: "no fields to update" }, 400);
        const cur = await env.DB.prepare(`SELECT id, cost FROM crm_materials WHERE id=?`).bind(id).first();
        if (!cur) return json({ error: "not found" }, 404);

        // Cost FREEZES onto GP at use time, so every cost change must be
        // auditable. When (and ONLY when) cost actually changes, log a
        // crm_material_price_history row in the SAME batch as the update — so
        // cost and its audit trail can never diverge.
        const costChanging = b.cost !== undefined && Number(b.cost) !== (cur.cost ?? 0);
        const updateStmt = env.DB.prepare(
          `UPDATE crm_materials SET ${sets.join(", ")}, updated_at=datetime('now') WHERE id=?`
        ).bind(...binds, id);
        if (costChanging) {
          await env.DB.batch([
            updateStmt,
            env.DB.prepare(
              `INSERT INTO crm_material_price_history
                 (material_id, old_cost, new_cost, source, changed_by)
               VALUES (?,?,?,?,?)`
            ).bind(id, cur.cost ?? null, Number(b.cost), "catalog edit", b.changed_by ?? 8),
          ]);
        } else {
          await updateStmt.run();
        }
        const row = await env.DB.prepare(
          `SELECT id, name, emco_sku, code, category, bin_location, cost, price, unit, is_active, search_terms, default_min, default_max,
                  purchase_unit, use_unit, conversion_factor, cost_per_use_override, deduct_on_use,
                  ROUND(COALESCE(cost_per_use_override, CASE WHEN conversion_factor>0 THEN cost/conversion_factor END),2) AS cost_per_use
             FROM crm_materials WHERE id=?`
        ).bind(id).first();
        return json({ ok: true, item: row, cost_logged: costChanging });
      }

      if (catMatch && request.method === "DELETE") {
        const id = catMatch[1];
        const hard = url.searchParams.get("hard") === "1";
        const exists = await env.DB.prepare(`SELECT id FROM crm_materials WHERE id=?`).bind(id).first();
        if (!exists) return json({ error: "not found" }, 404);
        if (!hard) {
          await env.DB.prepare(
            `UPDATE crm_materials SET is_active=0, updated_at=datetime('now') WHERE id=?`
          ).bind(id).run();
          return json({ ok: true, id: Number(id), mode: "soft" });
        }
        // Hard delete: only for junk with NO logged usage (protect GP history).
        const used = await env.DB.prepare(
          `SELECT COUNT(*) AS n FROM crm_job_materials WHERE material_id=?`
        ).bind(id).first();
        if ((used?.n || 0) > 0) {
          return json({ error: "has job_materials history — use soft delete", job_lines: used.n }, 409);
        }
        await env.DB.batch([
          env.DB.prepare(`DELETE FROM crm_inventory_movements WHERE material_id=?`).bind(id),
          env.DB.prepare(`DELETE FROM crm_inventory_stock WHERE material_id=?`).bind(id),
          env.DB.prepare(`DELETE FROM crm_materials WHERE id=?`).bind(id),
        ]);
        return json({ ok: true, id: Number(id), mode: "hard" });
      }

      // --- 7b. Bulk % cost change by category ----------------------------
      // POST /api/catalog/bulk-price  Body: { category, percent, apply? }
      //   preview (default): returns affected items old->new cost, NO writes.
      //   apply (apply:true): per item, updates cost AND logs price_history
      //     (shared batch_id), atomic per item + non-fatal. Only rows whose
      //     rounded cost actually changes are written.
      if (p === "/api/catalog/bulk-price" && request.method === "POST") {
        const b = await request.json();
        const category = (b.category || "").trim();
        const percent = Number(b.percent);
        const apply = b.apply === true;
        if (!category) return json({ error: "category required" }, 400);
        if (!Number.isFinite(percent)) return json({ error: "percent must be a number" }, 400);
        if (percent <= -100) return json({ error: "percent must be > -100" }, 400);

        const items = (await env.DB.prepare(
          `SELECT id, name, cost FROM crm_materials
            WHERE category = ? AND is_active = 1 ORDER BY name`
        ).bind(category).all()).results || [];
        const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
        const factor = 1 + percent / 100;

        if (!apply) {
          const preview = items.map((it) => {
            const oldc = it.cost ?? 0;
            return { material_id: it.id, name: it.name, old_cost: oldc, new_cost: round2(oldc * factor) };
          });
          return json({
            mode: "preview", category, percent,
            count: preview.length,
            changes: preview.filter((p) => p.new_cost !== p.old_cost).length,
            total_old: round2(preview.reduce((a, p) => a + p.old_cost, 0)),
            total_new: round2(preview.reduce((a, p) => a + p.new_cost, 0)),
            items: preview,
          });
        }

        // APPLY — one batch_id ties the whole run together in price_history.
        const batchId = `bulk-${Date.now()}`;
        const results = [];
        for (const it of items) {
          const oldc = it.cost ?? 0;
          const newc = round2(oldc * factor);
          if (newc === oldc) { results.push({ material_id: it.id, result: "unchanged", old_cost: oldc, new_cost: newc }); continue; }
          try {
            await env.DB.batch([
              env.DB.prepare(`UPDATE crm_materials SET cost=?, updated_at=datetime('now') WHERE id=?`).bind(newc, it.id),
              env.DB.prepare(
                `INSERT INTO crm_material_price_history
                   (material_id, old_cost, new_cost, source, batch_id, changed_by)
                 VALUES (?,?,?,?,?,?)`
              ).bind(it.id, oldc, newc, `bulk ${percent >= 0 ? "+" : ""}${percent}%`, batchId, b.changed_by ?? 8),
            ]);
            results.push({ material_id: it.id, result: "updated", old_cost: oldc, new_cost: newc });
          } catch (e) {
            results.push({ material_id: it.id, result: "failed", error: String(e.message || e) });
          }
        }
        return json({
          mode: "apply", category, percent, batch_id: batchId,
          updated: results.filter((r) => r.result === "updated").length,
          count: items.length, results,
        });
      }

      // --- 8. EMCO reorder cycle (phase 3) -------------------------------
      // Statuses are CHECK-constrained: Draft | Sent | Partial | Received | Cancelled.

      // 8a. GET /api/reorder/suggested — the order list with NO double-ordering.
      //   raw_short      = max_qty - on_hand (shop, loc 1)
      //   already_on_order = SUM(qty_ordered - qty_received) over this material's
      //                      lines on Sent/Partial POs (outstanding on order)
      //   net_need       = raw_short - already_on_order   (only return > 0)
      if (p === "/api/reorder/suggested" && request.method === "GET") {
        const rows = (await env.DB.prepare(
          `SELECT s.material_id, m.name, m.emco_sku, m.cost, s.on_hand, s.max_qty,
                  (s.max_qty - s.on_hand) AS raw_short,
                  COALESCE((
                    SELECT SUM(pi.qty_ordered - pi.qty_received)
                      FROM crm_inventory_po_items pi
                      JOIN crm_inventory_purchase_orders po ON po.id = pi.po_id
                     WHERE pi.material_id = s.material_id
                       AND po.status IN ('Sent','Partial')
                  ), 0) AS already_on_order
             FROM crm_inventory_stock s
             JOIN crm_materials m ON m.id = s.material_id
            WHERE s.location_id = 1 AND s.on_hand < s.max_qty AND m.is_active = 1
              AND m.deduct_on_use = 1   -- cost-only items (pipe, untracked bag) are reordered manually
              -- Hide items dismissed from the reorder, UNTIL the shop row changes
              -- again (a count/receipt bumps modified_at past the dismiss). A
              -- dismiss is a view flag only — it never touches stock.
              AND (s.reorder_dismissed_at IS NULL OR s.modified_at > s.reorder_dismissed_at)
            ORDER BY m.category, m.name`
        ).all()).results || [];
        const items = rows
          .map((r) => ({ ...r, net_need: r.raw_short - (r.already_on_order || 0) }))
          .filter((r) => r.net_need > 0);
        return json({ items });
      }

      // 8a-2. POST /api/reorder/dismiss  body { material_id, undo? }
      //   Hide a material from the suggested reorder list (view flag only — sets
      //   reorder_dismissed_at on the SHOP row, loc 1). It re-surfaces on the next
      //   shop stock change. Touches NO stock: no movement, no on_hand change.
      //   undo:true clears the dismiss (safety valve for a misclick).
      if (p === "/api/reorder/dismiss" && request.method === "POST") {
        const b = await request.json().catch(() => ({}));
        const mid = b.material_id;
        if (mid == null) return json({ error: "material_id required" }, 400);
        const row = await env.DB.prepare(
          `SELECT id FROM crm_inventory_stock WHERE location_id = 1 AND material_id = ?`
        ).bind(mid).first();
        if (!row) return json({ error: "no shop stock row for this material" }, 404);
        // ONLY the dismiss flag is written — on_hand/min/max are never touched.
        await env.DB.prepare(
          `UPDATE crm_inventory_stock
              SET reorder_dismissed_at = ${b.undo ? "NULL" : "datetime('now')"}
            WHERE id = ?`
        ).bind(row.id).run();
        return json({ ok: true, material_id: mid, dismissed: !b.undo });
      }

      // 8b. POST /api/reorder/po — get-or-create the single open Draft PO and
      //   (re)assemble its lines from the body { items:[{material_id, qty_ordered}] }.
      //   unit_cost is frozen from the catalog at assembly time for the PO total.
      if (p === "/api/reorder/po" && request.method === "POST") {
        const b = await request.json();
        const items = Array.isArray(b.items) ? b.items : [];
        let po = await env.DB.prepare(
          `SELECT id FROM crm_inventory_purchase_orders WHERE status='Draft' ORDER BY id DESC LIMIT 1`
        ).first();
        if (!po) {
          const coverStart = await reorderCoverStart(env);   // window start = last order's date
          const ins = await env.DB.prepare(
            `INSERT INTO crm_inventory_purchase_orders (vendor_name, status, created_by, notes) VALUES (?, 'Draft', ?, ?)`
          ).bind(b.vendor_name || "EMCO", b.created_by ?? 8, coverStart).run();
          po = { id: ins.meta?.last_row_id };
        }
        const poId = po.id;
        // Dedupe by material_id (last positive qty wins).
        const byMid = new Map();
        for (const it of items) {
          const q = Number(it.qty_ordered);
          if (it.material_id != null && q > 0) byMid.set(it.material_id, q);
        }
        const mids = [...byMid.keys()];
        const costMap = {};
        for (let i = 0; i < mids.length; i += 100) {
          const chunk = mids.slice(i, i + 100);
          const ph = chunk.map(() => "?").join(",");
          const cr = (await env.DB.prepare(
            `SELECT id, cost, emco_sku FROM crm_materials WHERE id IN (${ph})`
          ).bind(...chunk).all()).results || [];
          for (const c of cr) costMap[c.id] = c;
        }
        // Replace only the AUTO (below-par) lines — manually-added lines persist.
        const stmts = [env.DB.prepare(`DELETE FROM crm_inventory_po_items WHERE po_id=? AND source='auto'`).bind(poId)];
        for (const [mid, qty] of byMid) {
          const cost = costMap[mid]?.cost ?? 0;
          const lineTotal = Math.round(cost * qty * 100) / 100;
          stmts.push(env.DB.prepare(
            `INSERT INTO crm_inventory_po_items
               (po_id, material_id, qty_ordered, qty_received, vendor_part_number, unit_cost, line_total, source)
             VALUES (?,?,?,0,?,?,?,'auto')`
          ).bind(poId, mid, qty, costMap[mid]?.emco_sku ?? null, cost, lineTotal));
        }
        await env.DB.batch(stmts);
        // Total spans ALL lines (auto + persisted manual).
        const totalRow = await env.DB.prepare(`SELECT ROUND(COALESCE(SUM(line_total),0),2) AS total FROM crm_inventory_po_items WHERE po_id=?`).bind(poId).first();
        const total = totalRow?.total ?? 0;
        await env.DB.prepare(`UPDATE crm_inventory_purchase_orders SET total=? WHERE id=?`).bind(total, poId).run();
        const lines = (await env.DB.prepare(
          `SELECT pi.id AS line_id, pi.material_id, m.name, m.emco_sku,
                  pi.qty_ordered, pi.unit_cost, pi.line_total, pi.source
             FROM crm_inventory_po_items pi JOIN crm_materials m ON m.id=pi.material_id
            WHERE pi.po_id=? ORDER BY pi.source DESC, m.name`
        ).bind(poId).all()).results || [];
        return json({ ok: true, po_id: poId, status: "Draft", total, lines, name: await poNameFor(env, poId) });
      }

      // 8b-2. POST /api/reorder/po/add-line  { material_id, qty }
      //   Manually add ANY catalog item to the current Draft PO — NO below-par
      //   requirement (pipe lengths, special orders, anticipated needs). Tagged
      //   source='manual' so it survives the suggested-rebuild. Ordered by the
      //   catalog `cost` (per-LENGTH for pipe). Upserts by material (re-adding
      //   updates the qty); a material already auto-suggested becomes 'manual'.
      if (p === "/api/reorder/po/add-line" && request.method === "POST") {
        const b = await request.json().catch(() => ({}));
        const mid = b.material_id;
        const qty = Math.floor(Number(b.qty) || 0);
        if (mid == null || qty <= 0) return json({ error: "material_id and qty>0 required" }, 400);
        const mat = await env.DB.prepare(`SELECT id, cost, emco_sku FROM crm_materials WHERE id=?`).bind(mid).first();
        if (!mat) return json({ error: "material not found" }, 404);
        let po = await env.DB.prepare(`SELECT id FROM crm_inventory_purchase_orders WHERE status='Draft' ORDER BY id DESC LIMIT 1`).first();
        if (!po) {
          const coverStart = await reorderCoverStart(env);   // window start = last order's date
          const ins = await env.DB.prepare(`INSERT INTO crm_inventory_purchase_orders (vendor_name, status, created_by, notes) VALUES ('EMCO','Draft',?,?)`).bind(b.created_by ?? 8, coverStart).run();
          po = { id: ins.meta?.last_row_id };
        }
        const poId = po.id;
        const cost = mat.cost ?? 0;
        const lineTotal = Math.round(cost * qty * 100) / 100;
        const existing = await env.DB.prepare(`SELECT id FROM crm_inventory_po_items WHERE po_id=? AND material_id=?`).bind(poId, mid).first();
        if (existing) {
          await env.DB.prepare(`UPDATE crm_inventory_po_items SET qty_ordered=?, unit_cost=?, line_total=?, source='manual' WHERE id=?`).bind(qty, cost, lineTotal, existing.id).run();
        } else {
          await env.DB.prepare(`INSERT INTO crm_inventory_po_items (po_id, material_id, qty_ordered, qty_received, vendor_part_number, unit_cost, line_total, source) VALUES (?,?,?,0,?,?,?,'manual')`).bind(poId, mid, qty, mat.emco_sku ?? null, cost, lineTotal).run();
        }
        const totalRow = await env.DB.prepare(`SELECT ROUND(COALESCE(SUM(line_total),0),2) AS total FROM crm_inventory_po_items WHERE po_id=?`).bind(poId).first();
        const total = totalRow?.total ?? 0;
        await env.DB.prepare(`UPDATE crm_inventory_purchase_orders SET total=? WHERE id=?`).bind(total, poId).run();
        const lines = (await env.DB.prepare(
          `SELECT pi.id AS line_id, pi.material_id, m.name, m.emco_sku, pi.qty_ordered, pi.unit_cost, pi.line_total, pi.source
             FROM crm_inventory_po_items pi JOIN crm_materials m ON m.id=pi.material_id WHERE pi.po_id=? ORDER BY pi.source DESC, m.name`
        ).bind(poId).all()).results || [];
        return json({ ok: true, po_id: poId, status: "Draft", total, lines, name: await poNameFor(env, poId) });
      }

      // 8b-3. DELETE /api/reorder/po/line/:lineId — remove ONE line from a DRAFT PO.
      //   A draft is planned-only: nothing ordered or received, so deleting just
      //   removes the row + recomputes the total — ZERO stock movement (works for
      //   both 'auto' and 'manual' lines).
      //   GUARD (load-bearing): status='Draft' ONLY. REFUSE Sent/Received (409).
      //   Received stock moved via a po_receive movement whose reference_id is the
      //   PO id — a PER-PO AGGREGATE, NOT a 1:1 line→movement pointer — so an
      //   ad-hoc reversal here would double-deduct real inventory. Received lines
      //   must be reversed through the audited po_receive-undo, never this route.
      const delLineMatch = p.match(/^\/api\/reorder\/po\/line\/(\d+)$/);
      if (delLineMatch && request.method === "DELETE") {
        const lineId = Number(delLineMatch[1]);
        const line = await env.DB.prepare(
          `SELECT pi.id, pi.po_id, po.status
             FROM crm_inventory_po_items pi
             JOIN crm_inventory_purchase_orders po ON po.id = pi.po_id
            WHERE pi.id = ?`
        ).bind(lineId).first();
        if (!line) return json({ error: "line not found" }, 404);
        if (line.status !== "Draft") {
          return json({ error: `Cannot delete a line on a ${line.status} PO — only Draft lines can be removed. Received stock must be reversed via the receive-undo, never an ad-hoc delete.` }, 409);
        }
        const poId = line.po_id;
        await env.DB.prepare(`DELETE FROM crm_inventory_po_items WHERE id = ?`).bind(lineId).run();
        const totalRow = await env.DB.prepare(`SELECT ROUND(COALESCE(SUM(line_total),0),2) AS total FROM crm_inventory_po_items WHERE po_id=?`).bind(poId).first();
        const total = totalRow?.total ?? 0;
        await env.DB.prepare(`UPDATE crm_inventory_purchase_orders SET total=? WHERE id=?`).bind(total, poId).run();
        const lines = (await env.DB.prepare(
          `SELECT pi.id AS line_id, pi.material_id, m.name, m.emco_sku, pi.qty_ordered, pi.unit_cost, pi.line_total, pi.source
             FROM crm_inventory_po_items pi JOIN crm_materials m ON m.id=pi.material_id WHERE pi.po_id=? ORDER BY pi.source DESC, m.name`
        ).bind(poId).all()).results || [];
        return json({ ok: true, po_id: poId, status: "Draft", total, lines, deleted_line_id: lineId, name: await poNameFor(env, poId) });
      }

      // 8c. POST /api/reorder/po/:id/send — Draft -> Sent, stamp sent_at.
      const sendMatch = p.match(/^\/api\/reorder\/po\/(\d+)\/send$/);
      if (sendMatch && request.method === "POST") {
        const poId = sendMatch[1];
        const po = await env.DB.prepare(`SELECT id, status FROM crm_inventory_purchase_orders WHERE id=?`).bind(poId).first();
        if (!po) return json({ error: "not found" }, 404);
        if (po.status !== "Draft") return json({ error: `PO is ${po.status}; only a Draft can be sent` }, 409);
        const cnt = await env.DB.prepare(`SELECT COUNT(*) AS n FROM crm_inventory_po_items WHERE po_id=?`).bind(poId).first();
        if ((cnt?.n || 0) === 0) return json({ error: "PO has no lines" }, 400);
        await env.DB.prepare(
          `UPDATE crm_inventory_purchase_orders SET status='Sent', sent_at=datetime('now') WHERE id=?`
        ).bind(poId).run();
        return json({ ok: true, po_id: Number(poId), status: "Sent" });
      }

      // 8d. POST /api/reorder/po/:id/receive — body { lines:[{line_id, qty_received}] }
      //   Per line, ATOMIC + non-fatal: add qty_received to the line's running
      //   total AND to shop (loc 1) on_hand via a po_receive movement. Then set
      //   the PO to Received (all lines fulfilled) or Partial (some outstanding).
      const recvMatch = p.match(/^\/api\/reorder\/po\/(\d+)\/receive$/);
      if (recvMatch && request.method === "POST") {
        const poId = recvMatch[1];
        const b = await request.json();
        const receipts = Array.isArray(b.lines) ? b.lines : [];
        const po = await env.DB.prepare(`SELECT id, status FROM crm_inventory_purchase_orders WHERE id=?`).bind(poId).first();
        if (!po) return json({ error: "not found" }, 404);
        if (!["Sent", "Partial"].includes(po.status)) {
          return json({ error: `PO is ${po.status}; only Sent/Partial can be received` }, 409);
        }
        const WAREHOUSE_ID = 1;
        const batchId = crypto.randomUUID();   // one id for this receive action (undo target)
        const results = [];
        for (const rc of receipts) {
          const lineId = rc.line_id;
          const recvQty = Number(rc.qty_received);
          try {
            if (lineId == null) throw new Error("line_id required");
            if (!(recvQty > 0)) throw new Error("qty_received must be > 0");
            const line = await env.DB.prepare(
              `SELECT id, material_id, qty_ordered, qty_received FROM crm_inventory_po_items WHERE id=? AND po_id=?`
            ).bind(lineId, poId).first();
            if (!line) throw new Error("line not found on this PO");
            const srow = await env.DB.prepare(
              `SELECT id, on_hand FROM crm_inventory_stock WHERE location_id=? AND material_id=?`
            ).bind(WAREHOUSE_ID, line.material_id).first();
            if (!srow) throw new Error("no shop stock row");
            const newReceived = (line.qty_received ?? 0) + recvQty;
            const newOnHand = (srow.on_hand ?? 0) + recvQty;
            await env.DB.batch([
              env.DB.prepare(`UPDATE crm_inventory_po_items SET qty_received=? WHERE id=?`).bind(newReceived, line.id),
              env.DB.prepare(
                `UPDATE crm_inventory_stock SET on_hand=?, last_restocked=datetime('now'), modified_at=datetime('now') WHERE id=?`
              ).bind(newOnHand, srow.id),
              env.DB.prepare(
                `INSERT INTO crm_inventory_movements
                   (material_id, location_id, qty_change, reason, reference_id, notes, created_by, batch_id)
                 VALUES (?,?,?,?,?,?,?,?)`
              ).bind(line.material_id, WAREHOUSE_ID, recvQty, "po_receive", Number(poId), `received PO #${poId}`, b.created_by ?? 8, batchId),
            ]);
            results.push({
              line_id: line.id, material_id: line.material_id, received: recvQty,
              qty_received_total: newReceived, qty_ordered: line.qty_ordered,
              outstanding: Math.max(0, line.qty_ordered - newReceived),
            });
          } catch (e) {
            results.push({ line_id: lineId, result: "failed", error: String(e.message || e) });
          }
        }
        // Recompute PO status from the actual line state.
        const allLines = (await env.DB.prepare(
          `SELECT qty_ordered, qty_received FROM crm_inventory_po_items WHERE po_id=?`
        ).bind(poId).all()).results || [];
        const anyOutstanding = allLines.some((l) => (l.qty_received ?? 0) < l.qty_ordered);
        const newStatus = anyOutstanding ? "Partial" : "Received";
        if (newStatus === "Received") {
          await env.DB.prepare(
            `UPDATE crm_inventory_purchase_orders SET status='Received', received_at=datetime('now') WHERE id=?`
          ).bind(poId).run();
        } else {
          await env.DB.prepare(`UPDATE crm_inventory_purchase_orders SET status='Partial' WHERE id=?`).bind(poId).run();
        }
        return json({ ok: true, po_id: Number(poId), status: newStatus, batch_id: batchId, results });
      }

      // 8f. GET /api/reorder/po/current — the open Draft PO with its lines (or null).
      if (p === "/api/reorder/po/current" && request.method === "GET") {
        const po = await env.DB.prepare(
          `SELECT id, status, total, created_at, sent_at, received_at, notes FROM crm_inventory_purchase_orders WHERE status='Draft' ORDER BY id DESC LIMIT 1`
        ).first();
        if (!po) return json({ po: null });
        const lines = (await env.DB.prepare(
          `SELECT pi.id AS line_id, pi.material_id, m.name, m.emco_sku, pi.qty_ordered, pi.unit_cost, pi.line_total, pi.source
             FROM crm_inventory_po_items pi JOIN crm_materials m ON m.id=pi.material_id
            WHERE pi.po_id=? ORDER BY pi.source DESC, m.name`
        ).bind(po.id).all()).results || [];
        return json({ po: { ...po, name: poName(po), lines } });
      }

      // 8g. GET /api/reorder/pos?status=Sent,Partial — PO list (newest first).
      if (p === "/api/reorder/pos" && request.method === "GET") {
        const status = url.searchParams.get("status");
        const arr = status ? status.split(",").map((s) => s.trim()).filter(Boolean) : null;
        const where = arr ? `WHERE status IN (${arr.map(() => "?").join(",")})` : "";
        const stmt = env.DB.prepare(
          `SELECT po.id, po.status, po.total, po.created_at, po.sent_at, po.received_at, po.notes,
                  (SELECT COUNT(*) FROM crm_inventory_po_items WHERE po_id=po.id) AS line_count,
                  (SELECT COUNT(*) FROM crm_inventory_po_items WHERE po_id=po.id AND qty_received < qty_ordered) AS outstanding_lines
             FROM crm_inventory_purchase_orders po ${where}
            ORDER BY po.id DESC`
        );
        const r = await (arr ? stmt.bind(...arr) : stmt).all();
        return json({ pos: (r.results || []).map((po) => ({ ...po, name: poName(po) })) });
      }

      // 8h. GET /api/reorder/po/:id — one PO with ALL its lines (incl. received).
      const poGetMatch = p.match(/^\/api\/reorder\/po\/(\d+)$/);
      if (poGetMatch && request.method === "GET") {
        const id = poGetMatch[1];
        const po = await env.DB.prepare(
          `SELECT id, status, total, created_at, sent_at, received_at, notes FROM crm_inventory_purchase_orders WHERE id=?`
        ).bind(id).first();
        if (!po) return json({ error: "not found" }, 404);
        const lines = (await env.DB.prepare(
          `SELECT pi.id AS line_id, pi.material_id, m.name, m.emco_sku,
                  pi.qty_ordered, pi.qty_received, (pi.qty_ordered - pi.qty_received) AS outstanding,
                  pi.unit_cost, pi.line_total
             FROM crm_inventory_po_items pi JOIN crm_materials m ON m.id=pi.material_id
            WHERE pi.po_id=? ORDER BY m.name`
        ).bind(id).all()).results || [];
        return json({ po: { ...po, name: poName(po), lines } });
      }

      // 8e. GET /api/reorder/backorders — outstanding lines on Sent/Partial POs.
      if (p === "/api/reorder/backorders" && request.method === "GET") {
        const rows = (await env.DB.prepare(
          `SELECT pi.id AS line_id, pi.po_id, pi.material_id, m.name, m.emco_sku,
                  pi.qty_ordered, pi.qty_received,
                  (pi.qty_ordered - pi.qty_received) AS outstanding,
                  po.status, po.sent_at
             FROM crm_inventory_po_items pi
             JOIN crm_inventory_purchase_orders po ON po.id = pi.po_id
             JOIN crm_materials m ON m.id = pi.material_id
            WHERE po.status IN ('Sent','Partial') AND pi.qty_received < pi.qty_ordered
            ORDER BY po.sent_at, m.name`
        ).all()).results || [];
        return json({ items: rows });
      }

      return json({ error: "not found" }, 404);
    } catch (e) {
      return json({ error: String(e.message || e) }, 500);
    }
    };  // end run()

    let resp = await run();
    if (techTok && techTok.refresh && techTok.fresh) {   // refresh-on-use
      resp = new Response(resp.body, resp);
      resp.headers.set("X-TS-Token", techTok.fresh);
    }
    return resp;
  },
};
