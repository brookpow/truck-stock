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
