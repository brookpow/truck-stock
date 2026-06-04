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
  "Access-Control-Allow-Methods": "GET,POST,DELETE,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
});

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

      // --- 0b. Today's jobs for a tech (ServiceTitan-fed) -----------------
      // PLACEHOLDER: the real version calls the ServiceTitan appointments API
      // by st_tech_id for today. That requires ST secrets + the appointment
      // query, which we tune against real data. For now this returns an empty
      // list so the app falls back to manual job-id entry and stays usable.
      if (p === "/api/techs/jobs" && request.method === "GET") {
        // const stTechId = url.searchParams.get("st_tech_id");
        // TODO: fetch ST appointments for stTechId, today, map to jobs.
        return json({ jobs: [], fallback: "manual" });
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
            `SELECT location_id, qty_change FROM crm_inventory_movements
              WHERE reference_id = ? AND reason = 'job_usage'
              ORDER BY id DESC LIMIT 1`
          ).bind(row.id).first();

          if (!orig) {
            stock = { reversed: false, reason: "no_deduction_found" };
          } else {
            const locId = orig.location_id;
            const restoreQty = -orig.qty_change; // qty_change was negative
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

      return json({ error: "not found" }, 404);
    } catch (e) {
      return json({ error: String(e.message || e) }, 500);
    }
  },
};
