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

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...cors() },
  });

const cors = () => ({
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,PATCH,DELETE,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
});

// Pacific (America/Vancouver) calendar day as UTC bounds, DST-correct.
// crm_st_appointments.start_date is stored UTC ISO ("2026-06-09T15:00:00Z");
// a tech's "today" is the Pacific day, so we return [midnight, next-midnight)
// Pacific expressed in UTC for a simple range filter on start_date.
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

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null, { headers: cors() });
    const url = new URL(request.url);
    const p = url.pathname;

    try {
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
        const recentStart = new Date(Date.parse(start) - 3 * 86400000)
          .toISOString().replace(/\.\d{3}Z$/, "Z");                 // today's Pacific midnight, -3 days
        const addr =
          `TRIM(COALESCE(c.address_street,'') ||
                CASE WHEN c.address_city IS NOT NULL THEN ', ' || c.address_city ELSE '' END)`;
        const [activeRes, recentRes] = await env.DB.batch([
          // ACTIVE — today, active appointment status, job not finished.
          env.DB.prepare(
            `SELECT aa.job_id, j.job_number, j.status AS job_status, c.name AS customer,
                    ${addr} AS address,
                    MIN(CASE ap.status WHEN 'Working' THEN 1 WHEN 'Dispatched' THEN 2
                                       WHEN 'Scheduled' THEN 3 ELSE 4 END) AS status_rank,
                    MIN(ap.start_date) AS start_date,
                    COUNT(DISTINCT aa.appointment_id) AS appt_count
               FROM crm_st_appointment_assignments aa
               JOIN crm_st_appointments ap ON ap.id = aa.appointment_id
               JOIN crm_st_jobs j           ON j.id = aa.job_id
               LEFT JOIN crm_st_customers c ON c.id = j.customer_id
              WHERE aa.technician_id = ?1
                AND ap.status IN ('Working','Dispatched','Scheduled')
                AND ((ap.start_date >= ?2 AND ap.start_date < ?3) OR ap.status = 'Working')
                AND j.status NOT IN ('Completed','Canceled')
                AND LOWER(j.status) != 'paused'
              GROUP BY aa.job_id, j.job_number, j.status, c.name, c.address_street, c.address_city
              ORDER BY status_rank, start_date`
          ).bind(tid, start, end),
          // RECENT — finished (Completed/paused) jobs visited in the last 3 days.
          env.DB.prepare(
            `SELECT aa.job_id, j.job_number, j.status AS job_status, c.name AS customer,
                    ${addr} AS address,
                    MAX(ap.start_date) AS start_date,
                    COUNT(DISTINCT aa.appointment_id) AS appt_count
               FROM crm_st_appointment_assignments aa
               JOIN crm_st_appointments ap ON ap.id = aa.appointment_id
               JOIN crm_st_jobs j           ON j.id = aa.job_id
               LEFT JOIN crm_st_customers c ON c.id = j.customer_id
              WHERE aa.technician_id = ?1
                AND (j.status = 'Completed' OR LOWER(j.status) = 'paused')
                AND ap.start_date >= ?2
              GROUP BY aa.job_id, j.job_number, j.status, c.name, c.address_street, c.address_city
              ORDER BY start_date DESC`
          ).bind(tid, recentStart),
        ]);
        const RANK = { 1: "Working", 2: "Dispatched", 3: "Scheduled" };
        const jobs = (activeRes.results || []).map((row) => ({
          job_id: row.job_id, job_number: row.job_number, customer: row.customer,
          address: row.address || null, status: RANK[row.status_rank] || "Scheduled",
          start_date: row.start_date, appt_count: row.appt_count, job_status: row.job_status,
        }));
        const recent = (recentRes.results || []).map((row) => ({
          job_id: row.job_id, job_number: row.job_number, customer: row.customer,
          address: row.address || null,
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
          `SELECT id, code, emco_sku, name, cost, price, unit, category, search_terms
             FROM crm_materials
            WHERE is_active = 1
              AND (name LIKE ? OR code LIKE ? OR emco_sku LIKE ? OR search_terms LIKE ?)
            ORDER BY name
            LIMIT 25`
        ).bind(like, like, like, like).all();
        return json(r.results || []);
      }

      // --- 2. Log a used material to a job --------------------------------
      // Body: { material_id, quantity, tech_id?, truck_location_id?, job_number? }
      // Cost is FROZEN here: we read the catalog cost now and write it onto the
      // job line, so historical GP stays true even if catalog prices change later.
      const saveMatch = p.match(/^\/api\/jobs\/([^/]+)\/materials$/);
      if (saveMatch && request.method === "POST") {
        const jobId = saveMatch[1];
        const b = await request.json();
        if (!b.material_id || !b.quantity) {
          return json({ error: "material_id and quantity are required" }, 400);
        }
        // Freeze cost from catalog at time of use.
        const mat = await env.DB.prepare(
          `SELECT cost FROM crm_materials WHERE id = ?`
        ).bind(b.material_id).first();
        const unitCost = mat ? (mat.cost ?? 0) : 0;
        const totalCost = unitCost * b.quantity;

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
        // We deduct only from the logging tech's own van.
        let stock = { deducted: false, reason: "no_van_for_tech" };
        try {
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
                  jm.notes, jm.is_prepull, jm.tech_id, m.name, m.code, m.unit,
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
                     (material_id, location_id, qty_change, reason, reference_id, notes, created_by)
                   VALUES (?,?,?,?,?,?,?)`
                ).bind(
                  row.material_id,
                  locId,                 // the ORIGINAL deduction's location
                  restoreQty,            // positive — compensating movement
                  "manual",
                  row.id,                // reference back to the deleted line id
                  `usage_reversed; line ${row.id}`,
                  row.tech_id ?? null
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
                       (material_id, location_id, qty_change, reason, reference_id, notes, created_by)
                     VALUES (?,?,?,?,?,?,?)`
                  ).bind(
                    row.material_id, locId, -delta, "manual", row.id,
                    `qty edit: line ${row.id} ${oldQty}->${newQty}`, row.tech_id ?? null
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
            ORDER BY m.name`
        ).bind(locationId).all();
        return json({ location_id: Number(locationId) || locationId, items: r.results || [] });
      }

      // --- 5. Confirm a van restock --------------------------------------
      // POST /api/restock/:locationId/confirm
      // Body: { items: [{ material_id, pulled_qty, shop_out }], created_by? }
      //
      // Per item, ATOMIC and NON-FATAL:
      //   pulled_qty > 0 : move stock shop(loc 1) -> van in ONE env.DB.batch —
      //     van.on_hand += pulled_qty (+ transfer_in movement, + last_restocked)
      //     warehouse.on_hand -= pulled_qty (+ transfer_out movement, may go <0)
      //     Both movement legs share one reference_id so the transfer is linkable.
      //   else shop_out  : NO stock change. Seed a crm_inventory_requests row
      //     (type 'shop_reorder') for the shortfall (max_qty - on_hand) to feed
      //     the future EMCO reorder list.
      //   else           : skipped (neither pulled nor shop_out).
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

        const results = [];
        for (let i = 0; i < items.length; i++) {
          const it = items[i] || {};
          const mid = it.material_id;
          const pulled = Number(it.pulled_qty) || 0;
          try {
            if (mid == null) throw new Error("material_id required");

            if (pulled > 0) {
              // Need the van row AND the warehouse row to move stock between them.
              const vanRow = await env.DB.prepare(
                `SELECT id, on_hand FROM crm_inventory_stock
                  WHERE location_id = ? AND material_id = ?`
              ).bind(locationId, mid).first();
              const whRow = await env.DB.prepare(
                `SELECT id, on_hand FROM crm_inventory_stock
                  WHERE location_id = ? AND material_id = ?`
              ).bind(WAREHOUSE_ID, mid).first();
              if (!vanRow) throw new Error("no van stock row");
              if (!whRow) throw new Error("no warehouse stock row");

              const vanAfter = (vanRow.on_hand ?? 0) + pulled;
              const whAfter = (whRow.on_hand ?? 0) - pulled; // may go negative
              const ref = refBase + i; // shared by both legs of THIS pull

              // One atomic batch: both stock rows + both ledger legs move
              // together, or none do.
              await env.DB.batch([
                env.DB.prepare(
                  `UPDATE crm_inventory_stock
                      SET on_hand = ?, last_restocked = datetime('now'),
                          modified_at = datetime('now')
                    WHERE id = ?`
                ).bind(vanAfter, vanRow.id),
                env.DB.prepare(
                  `INSERT INTO crm_inventory_movements
                     (material_id, location_id, qty_change, reason, reference_id, notes, created_by)
                   VALUES (?,?,?,?,?,?,?)`
                ).bind(mid, locationId, pulled, "transfer_in", ref, "restock pull (shop->van)", operator),
                env.DB.prepare(
                  `UPDATE crm_inventory_stock
                      SET on_hand = ?, modified_at = datetime('now')
                    WHERE id = ?`
                ).bind(whAfter, whRow.id),
                env.DB.prepare(
                  `INSERT INTO crm_inventory_movements
                     (material_id, location_id, qty_change, reason, reference_id, notes, created_by)
                   VALUES (?,?,?,?,?,?,?)`
                ).bind(mid, WAREHOUSE_ID, -pulled, "transfer_out", ref, "restock pull (shop->van)", operator),
              ]);
              results.push({ material_id: mid, result: "restocked" });
            } else if (it.shop_out) {
              // No stock change — seed a reorder request for the shortfall.
              const vanRow = await env.DB.prepare(
                `SELECT on_hand, max_qty FROM crm_inventory_stock
                  WHERE location_id = ? AND material_id = ?`
              ).bind(locationId, mid).first();
              if (!vanRow) throw new Error("no van stock row");
              const shortfall = (vanRow.max_qty ?? 0) - (vanRow.on_hand ?? 0);
              if (shortfall <= 0) {
                // Already at/above par — nothing to reorder, don't seed a request.
                results.push({ material_id: mid, result: "skipped", reason: "at_or_above_par" });
              } else {
                await env.DB.prepare(
                  `INSERT INTO crm_inventory_requests
                     (material_id, quantity, truck_location_id, requested_by,
                      status, type, notes)
                   VALUES (?,?,?,?,?,?,?)`
                ).bind(
                  mid, shortfall, locationId, operator,
                  "pending", "shop_reorder", "shop out during restock"
                ).run();
                results.push({ material_id: mid, result: "shop_reorder", quantity: shortfall });
              }
            } else {
              results.push({ material_id: mid, result: "skipped", reason: "not_requested" });
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

        return json({ location_id: Number(locationId) || locationId, results, on_hand });
      }

      // --- 6a. Shop (warehouse) stock — full dump for count/levels views --
      // GET /api/shop/stock -> every loc-1 stock row joined to the catalog,
      // ordered by category then name so the UI can group by category. Feeds
      // both the physical count screen and the min/max levels screen.
      if (p === "/api/shop/stock" && request.method === "GET") {
        const r = await env.DB.prepare(
          `SELECT s.material_id, m.name, m.emco_sku, m.category, m.bin_location,
                  s.on_hand, s.min_qty, s.max_qty, s.last_counted
             FROM crm_inventory_stock s
             JOIN crm_materials m ON m.id = s.material_id
            WHERE s.location_id = 1
            ORDER BY m.category, m.name`
        ).all();
        return json({ location_id: 1, items: r.results || [] });
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
        const OFFICE_OPERATOR = 8; // crm_users.id — Warehouse Manager
        const operator = body.created_by ?? OFFICE_OPERATOR;
        const WAREHOUSE_ID = 1;
        const num = (v) => (v != null && v !== "" ? Number(v) : undefined);

        const results = [];
        for (const it of items) {
          const mid = it.material_id;
          try {
            if (mid == null) throw new Error("material_id required");
            const row = await env.DB.prepare(
              `SELECT id, on_hand, min_qty, max_qty FROM crm_inventory_stock
                WHERE location_id = ? AND material_id = ?`
            ).bind(WAREHOUSE_ID, mid).first();
            if (!row) throw new Error("no shop stock row");

            const countVal = num(it.on_hand);          // undefined if not counting
            const hasCount = countVal !== undefined;
            const newMin = num(it.min_qty) ?? row.min_qty;
            const newMax = num(it.max_qty) ?? row.max_qty;
            const newOnHand = hasCount ? countVal : (row.on_hand ?? 0);
            if (hasCount && !Number.isFinite(newOnHand)) throw new Error("on_hand not a number");
            if (!Number.isFinite(newMin) || !Number.isFinite(newMax)) throw new Error("min/max not a number");

            const delta = newOnHand - (row.on_hand ?? 0);
            const countChanged = hasCount && delta !== 0;       // movement only when it moved
            const minMaxChanged = newMin !== row.min_qty || newMax !== row.max_qty;

            if (!hasCount && !minMaxChanged) {
              results.push({ material_id: mid, result: "unchanged",
                on_hand: row.on_hand, min_qty: row.min_qty, max_qty: row.max_qty });
              continue;
            }

            // One UPDATE carries on_hand + thresholds (+ last_counted when a
            // count was taken, even if the value confirmed unchanged).
            const stamp = hasCount ? ", last_counted = datetime('now')" : "";
            const upd = env.DB.prepare(
              `UPDATE crm_inventory_stock
                  SET on_hand = ?, min_qty = ?, max_qty = ?${stamp},
                      modified_at = datetime('now')
                WHERE id = ?`
            ).bind(newOnHand, newMin, newMax, row.id);

            if (countChanged) {
              await env.DB.batch([
                upd,
                env.DB.prepare(
                  `INSERT INTO crm_inventory_movements
                     (material_id, location_id, qty_change, reason, reference_id, notes, created_by)
                   VALUES (?,?,?,?,?,?,?)`
                ).bind(mid, WAREHOUSE_ID, delta, "count_adjust", null, "shop count", operator),
              ]);
            } else {
              await upd.run();
            }

            results.push({
              material_id: mid,
              result: hasCount ? "counted" : "updated",
              delta: countChanged ? delta : 0,
              on_hand: newOnHand, min_qty: newMin, max_qty: newMax,
            });
          } catch (e) {
            results.push({ material_id: mid, result: "failed", error: String(e.message || e) });
          }
        }

        return json({ location_id: WAREHOUSE_ID, results });
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
          `SELECT id, name, emco_sku, code, category, bin_location, cost, price, unit, is_active, search_terms, default_min, default_max
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
        const ins = await env.DB.prepare(
          `INSERT INTO crm_materials
             (name, category, cost, price, emco_sku, code, bin_location, unit, subcategory, search_terms, default_min, default_max)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
        ).bind(
          name, category, Number(b.cost) || 0, Number(b.price) || 0,
          b.emco_sku || null, b.code || null, b.bin_location || null,
          b.unit || null, b.subcategory || null, b.search_terms || null,
          numOr(b.default_min, 2), numOr(b.default_max, 10)
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
        const fields = ["name","category","cost","price","emco_sku","code","bin_location","unit","subcategory","search_terms","is_active","default_min","default_max"];
        const sets = []; const binds = [];
        for (const f of fields) {
          if (b[f] === undefined) continue;
          if ((f === "name" || f === "category") && !String(b[f]).trim()) {
            return json({ error: `${f} cannot be empty` }, 400); // NOT NULL columns
          }
          sets.push(`${f} = ?`);
          binds.push(
            ["cost","price","is_active","default_min","default_max"].includes(f) ? Number(b[f])
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
          `SELECT id, name, emco_sku, code, category, bin_location, cost, price, unit, is_active, search_terms, default_min, default_max
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
            ORDER BY m.category, m.name`
        ).all()).results || [];
        const items = rows
          .map((r) => ({ ...r, net_need: r.raw_short - (r.already_on_order || 0) }))
          .filter((r) => r.net_need > 0);
        return json({ items });
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
          const ins = await env.DB.prepare(
            `INSERT INTO crm_inventory_purchase_orders (vendor_name, status, created_by) VALUES (?, 'Draft', ?)`
          ).bind(b.vendor_name || "EMCO", b.created_by ?? 8).run();
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
        const stmts = [env.DB.prepare(`DELETE FROM crm_inventory_po_items WHERE po_id=?`).bind(poId)];
        let total = 0;
        for (const [mid, qty] of byMid) {
          const cost = costMap[mid]?.cost ?? 0;
          const lineTotal = Math.round(cost * qty * 100) / 100;
          total += lineTotal;
          stmts.push(env.DB.prepare(
            `INSERT INTO crm_inventory_po_items
               (po_id, material_id, qty_ordered, qty_received, vendor_part_number, unit_cost, line_total)
             VALUES (?,?,?,0,?,?,?)`
          ).bind(poId, mid, qty, costMap[mid]?.emco_sku ?? null, cost, lineTotal));
        }
        total = Math.round(total * 100) / 100;
        stmts.push(env.DB.prepare(`UPDATE crm_inventory_purchase_orders SET total=? WHERE id=?`).bind(total, poId));
        await env.DB.batch(stmts);
        const lines = (await env.DB.prepare(
          `SELECT pi.id AS line_id, pi.material_id, m.name, m.emco_sku,
                  pi.qty_ordered, pi.unit_cost, pi.line_total
             FROM crm_inventory_po_items pi JOIN crm_materials m ON m.id=pi.material_id
            WHERE pi.po_id=? ORDER BY m.name`
        ).bind(poId).all()).results || [];
        return json({ ok: true, po_id: poId, status: "Draft", total, lines });
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
                   (material_id, location_id, qty_change, reason, reference_id, notes, created_by)
                 VALUES (?,?,?,?,?,?,?)`
              ).bind(line.material_id, WAREHOUSE_ID, recvQty, "po_receive", Number(poId), `received PO #${poId}`, b.created_by ?? 8),
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
        return json({ ok: true, po_id: Number(poId), status: newStatus, results });
      }

      // 8f. GET /api/reorder/po/current — the open Draft PO with its lines (or null).
      if (p === "/api/reorder/po/current" && request.method === "GET") {
        const po = await env.DB.prepare(
          `SELECT id, status, total, created_at FROM crm_inventory_purchase_orders WHERE status='Draft' ORDER BY id DESC LIMIT 1`
        ).first();
        if (!po) return json({ po: null });
        const lines = (await env.DB.prepare(
          `SELECT pi.id AS line_id, pi.material_id, m.name, m.emco_sku, pi.qty_ordered, pi.unit_cost, pi.line_total
             FROM crm_inventory_po_items pi JOIN crm_materials m ON m.id=pi.material_id
            WHERE pi.po_id=? ORDER BY m.name`
        ).bind(po.id).all()).results || [];
        return json({ po: { ...po, lines } });
      }

      // 8g. GET /api/reorder/pos?status=Sent,Partial — PO list (newest first).
      if (p === "/api/reorder/pos" && request.method === "GET") {
        const status = url.searchParams.get("status");
        const arr = status ? status.split(",").map((s) => s.trim()).filter(Boolean) : null;
        const where = arr ? `WHERE status IN (${arr.map(() => "?").join(",")})` : "";
        const stmt = env.DB.prepare(
          `SELECT po.id, po.status, po.total, po.created_at, po.sent_at, po.received_at,
                  (SELECT COUNT(*) FROM crm_inventory_po_items WHERE po_id=po.id) AS line_count,
                  (SELECT COUNT(*) FROM crm_inventory_po_items WHERE po_id=po.id AND qty_received < qty_ordered) AS outstanding_lines
             FROM crm_inventory_purchase_orders po ${where}
            ORDER BY po.id DESC`
        );
        const r = await (arr ? stmt.bind(...arr) : stmt).all();
        return json({ pos: r.results || [] });
      }

      // 8h. GET /api/reorder/po/:id — one PO with ALL its lines (incl. received).
      const poGetMatch = p.match(/^\/api\/reorder\/po\/(\d+)$/);
      if (poGetMatch && request.method === "GET") {
        const id = poGetMatch[1];
        const po = await env.DB.prepare(
          `SELECT id, status, total, created_at, sent_at, received_at FROM crm_inventory_purchase_orders WHERE id=?`
        ).bind(id).first();
        if (!po) return json({ error: "not found" }, 404);
        const lines = (await env.DB.prepare(
          `SELECT pi.id AS line_id, pi.material_id, m.name, m.emco_sku,
                  pi.qty_ordered, pi.qty_received, (pi.qty_ordered - pi.qty_received) AS outstanding,
                  pi.unit_cost, pi.line_total
             FROM crm_inventory_po_items pi JOIN crm_materials m ON m.id=pi.material_id
            WHERE pi.po_id=? ORDER BY m.name`
        ).bind(id).all()).results || [];
        return json({ po: { ...po, lines } });
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
  },
};
