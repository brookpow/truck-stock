// All calls to the truck-stock worker. One place to change the base URL.
const API = import.meta.env.VITE_API || "https://truck-stock-worker.tiny-truth-e86a.workers.dev";

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
