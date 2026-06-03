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
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
});

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null, { headers: cors() });
    const url = new URL(request.url);
    const p = url.pathname;

    try {
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
        await env.DB.prepare(
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

        return json({ ok: true, unit_cost: unitCost, total_cost: totalCost });
      }

      // --- 3. List materials logged on a job ------------------------------
      if (saveMatch && request.method === "GET") {
        const jobId = saveMatch[1];
        const r = await env.DB.prepare(
          `SELECT jm.id, jm.material_id, jm.quantity, jm.unit_cost, jm.total_cost,
                  jm.notes, jm.is_prepull, m.name, m.code, m.unit
             FROM crm_job_materials jm
             LEFT JOIN crm_materials m ON m.id = jm.material_id
            WHERE jm.job_id = ?
            ORDER BY jm.id DESC`
        ).bind(jobId).all();
        const rows = r.results || [];
        const total = rows.reduce((a, x) => a + (x.total_cost || 0), 0);
        return json({ job_id: jobId, items: rows, total_material_cost: total });
      }

      return json({ error: "not found" }, 404);
    } catch (e) {
      return json({ error: String(e.message || e) }, 500);
    }
  },
};
