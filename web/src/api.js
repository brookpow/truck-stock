// All calls to the truck-stock worker. One place to change the base URL.
const API = import.meta.env.VITE_API || "https://truck-stock-worker.tiny-truth-e86a.workers.dev";

// ── Phase 2 tech auth (T1). The tech token is attached to every worker call via a
// global fetch wrapper. Refresh-on-use: the worker may return X-TS-Token (a fresh
// 30d token) which we swap in. On 401/423 we drop the token so the app bounces to
// login. In T1 nothing is enforced server-side, so an un-logged-in device still
// works (writes fall back to the client tech_id) — this just layers identity on. ──
const TOKEN_KEY = "ts_tech_token";
export const getTechToken = () => localStorage.getItem(TOKEN_KEY);
export const setTechToken = (t) => (t ? localStorage.setItem(TOKEN_KEY, t) : localStorage.removeItem(TOKEN_KEY));
let onAuthLost = null;
export const setOnAuthLost = (fn) => (onAuthLost = fn);

const _fetch = window.fetch.bind(window);
window.fetch = async (url, opts = {}) => {
  const isApi = typeof url === "string" && url.startsWith(API);
  const isLogin = isApi && (url.endsWith("/api/auth/tech-login") || url.endsWith("/api/auth/tech-list"));
  const tok = getTechToken();
  if (isApi && tok && !isLogin) opts = { ...opts, headers: { ...(opts.headers || {}), Authorization: "Bearer " + tok } };
  const res = await _fetch(url, opts);
  if (isApi) {
    const fresh = res.headers.get("X-TS-Token");
    if (fresh) setTechToken(fresh);                       // refresh-on-use
    if ((res.status === 401 || res.status === 423) && tok && !isLogin) { setTechToken(null); if (onAuthLost) onAuthLost(res.status); }
  }
  return res;
};

// Active techs WITH a PIN set (the name picker).
export async function techList() {
  const r = await fetch(`${API}/api/auth/tech-list`);
  if (!r.ok) throw new Error("tech-list " + r.status);
  return r.json(); // { techs: [{st_tech_id, name}] }
}

// PIN login -> stores the token, returns the tech. Throws with a friendly message
// on bad PIN (attempts_left) / lockout (423) / throttle (429).
export async function techLogin(techId, pin) {
  const r = await fetch(`${API}/api/auth/tech-login`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tech_id: techId, pin }),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok || !d.token) {
    if (r.status === 423) throw new Error("Too many wrong PINs — locked for a few minutes. Ask the office to reset it.");
    if (r.status === 429) throw new Error("Too many attempts right now — wait a minute and try again.");
    if (d.attempts_left != null) throw new Error(`Wrong PIN — ${d.attempts_left} tr${d.attempts_left === 1 ? "y" : "ies"} left.`);
    throw new Error(d.error || ("login " + r.status));
  }
  setTechToken(d.token);
  return d.tech; // { st_tech_id, name }
}

export async function getTechs() {
  const r = await fetch(`${API}/api/techs`);
  if (!r.ok) throw new Error("techs " + r.status);
  return r.json();
}

export async function getTodaysJobs(stTechId) {
  const r = await fetch(`${API}/api/techs/jobs?st_tech_id=${encodeURIComponent(stTechId)}`);
  if (!r.ok) throw new Error("jobs " + r.status);
  return r.json(); // { jobs: [...], fallback?: "manual" }
}

export async function searchMaterials(q) {
  if (!q || q.trim().length < 2) return [];
  const r = await fetch(`${API}/api/materials/search?q=${encodeURIComponent(q.trim())}`);
  if (!r.ok) throw new Error("search " + r.status);
  return r.json();
}

export async function getJobMaterials(jobId) {
  const r = await fetch(`${API}/api/jobs/${encodeURIComponent(jobId)}/materials`);
  if (!r.ok) throw new Error("list " + r.status);
  return r.json(); // { items, total_material_cost }
}

export async function logMaterial(jobId, body) {
  // body: { material_id, quantity, tech_id, job_number?, notes?, is_prepull? }
  const r = await fetch(`${API}/api/jobs/${encodeURIComponent(jobId)}/materials`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error("log " + r.status);
  return r.json();
}

// Online-only for v1. Kept a plain call (like deleteMaterial) so a future
// offline version can route qty edits through syncQueue without changing this
// contract. Returns { ok, quantity, unit_cost, total_cost, stock }.
export async function patchMaterialQty(jobId, lineId, quantity) {
  const r = await fetch(
    `${API}/api/jobs/${encodeURIComponent(jobId)}/materials/${encodeURIComponent(lineId)}`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ quantity }),
    }
  );
  if (!r.ok) throw new Error("qty " + r.status);
  return r.json();
}

export async function deleteMaterial(jobId, lineId) {
  // Hard delete of one logged line. The worker scope-checks that lineId
  // belongs to jobId and 404s otherwise (deleting nothing).
  const r = await fetch(
    `${API}/api/jobs/${encodeURIComponent(jobId)}/materials/${encodeURIComponent(lineId)}`,
    { method: "DELETE" }
  );
  if (!r.ok) throw new Error("delete " + r.status);
  return r.json();
}

// READ-ONLY vision scan of a receipt image. imageBase64 is the RAW base64 (no
// "data:" prefix). Returns { ok, supplier, items:[{description, quantity,
// unit_cost, total, match}], subtotal, tax, total }. Writes nothing — the tech
// confirms via savePurchase.
export async function scanReceipt(jobId, imageBase64, mediaType) {
  const r = await fetch(`${API}/api/jobs/${encodeURIComponent(jobId)}/scan-receipt`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ image_base64: imageBase64, media_type: mediaType }),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.message || d.error || ("scan " + r.status));
  return d;
}

// Commit the confirmed receipt: writes ONE crm_job_purchases row + (for each
// matched line the tech flagged) a crm_job_materials line. NO van deduction.
// body: { tech_id, supplier, total, description?, items:[{description, quantity,
//   unit_cost, total, material_id?, log_to_materials?}] }
export async function savePurchase(jobId, body) {
  const r = await fetch(`${API}/api/jobs/${encodeURIComponent(jobId)}/purchases`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || ("purchase " + r.status));
  return d;
}

// Off-cycle / overhead purchase (NO job). Writes is_overhead=1 / job_id=0; no
// matched lines, no van deduction — structurally a receipt minus the job.
export async function saveOverheadPurchase(body) {
  const r = await fetch(`${API}/api/overhead/purchases`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || ("overhead " + r.status));
  return d;
}

// Tech-initiated restock FROM SHOP — pure shop→van inventory transfer (no job,
// no purchase). items: [{ material_id, quantity }]. Worker resolves the van from
// st_tech_id. Returns { van_id, van_name, results:[{material_id, result,
// quantity, shop_shortfall?}] }.
export async function restockFromShop(stTechId, items) {
  const r = await fetch(`${API}/api/restock/from-shop`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ st_tech_id: stTechId, items }),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || ("restock " + r.status));
  return d;
}

// GET a job's saved receipts -> { purchases:[{ id, supplier, subtotal, tax,
// receipt_total, created_at, lines:[matched materials] }] }.
export async function getJobPurchases(jobId) {
  const r = await fetch(`${API}/api/jobs/${encodeURIComponent(jobId)}/purchases`);
  if (!r.ok) throw new Error("purchases " + r.status);
  return r.json();
}

// DELETE a receipt — removes the purchase + the matched lines it created (no van
// reversal; nothing was deducted).
export async function deletePurchase(jobId, id) {
  const r = await fetch(`${API}/api/jobs/${encodeURIComponent(jobId)}/purchases/${encodeURIComponent(id)}`, { method: "DELETE" });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || ("delete " + r.status));
  return d;
}

// PATCH a receipt header — { supplier?, subtotal?, tax?, total? }.
export async function patchPurchase(jobId, id, body) {
  const r = await fetch(`${API}/api/jobs/${encodeURIComponent(jobId)}/purchases/${encodeURIComponent(id)}`, {
    method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || ("edit " + r.status));
  return d;
}

// Catalog grouped by category for browse -> { categories:[{ name, count, items:[{id,name,cost}] }] }.
export async function getByCategory() {
  const r = await fetch(`${API}/api/materials/by-category`);
  if (!r.ok) throw new Error("by-category " + r.status);
  return r.json();
}

// Special request -> writes crm_inventory_requests (no cost, no stock change).
// body: { tech_id, description, quantity?, notes?, job_id? }
export async function createRequest(body) {
  const r = await fetch(`${API}/api/requests`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || ("request " + r.status));
  return d;
}

// Worker route that serves a receipt's photo from R2 (private). Use as <img src>.
export function receiptPhotoUrl(id) {
  return `${API}/api/purchases/${encodeURIComponent(id)}/photo`;
}

// ── Cycle counts (Start Count) ──────────────────────────────────────────────
// Start a count session + snapshot. Tech counts its own van → pass techId (the
// worker resolves the van). scope: 'full' | 'categories' (+ categories[]).
export async function startCount({ locationId, techId, actorId, scope, categories }) {
  const r = await fetch(`${API}/api/counts`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ location_id: locationId ?? null, tech_id: techId ?? null, actor_id: actorId ?? null, scope, categories }),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || ("count " + r.status));
  return d; // { count_id, location_name, scope, items:[...] }
}
export async function getCurrentCount({ locationId, techId }) {
  const qs = locationId != null ? `location_id=${encodeURIComponent(locationId)}` : `tech_id=${encodeURIComponent(techId)}`;
  const r = await fetch(`${API}/api/counts/current?${qs}`);
  if (!r.ok) throw new Error("count " + r.status);
  return (await r.json()).count; // { id, items, scope, scope_detail, created_at } | null
}
export async function saveCountItems(countId, items) {
  const r = await fetch(`${API}/api/counts/${encodeURIComponent(countId)}/items`, {
    method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ items }),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || ("count-save " + r.status));
  return d;
}
export async function finishCount(countId, actorId) {
  const r = await fetch(`${API}/api/counts/${encodeURIComponent(countId)}/finish`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ actor_id: actorId }),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || ("count-finish " + r.status));
  return d; // { applied, order, name, started_at, finished_at }
}
export async function discardCount(countId) {
  const r = await fetch(`${API}/api/counts/${encodeURIComponent(countId)}/discard`, { method: "POST" });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || ("count-discard " + r.status));
  return d;
}
export async function commitCountPull(countId, actorId, name, lines) {
  const r = await fetch(`${API}/api/counts/${encodeURIComponent(countId)}/commit-pull`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ actor_id: actorId, name, lines }),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || ("commit-pull " + r.status));
  return d;
}
