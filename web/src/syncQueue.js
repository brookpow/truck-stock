// Offline-tolerant save queue for material logging.
//
// Why this exists: techs work in basements with spotty signal. If a "log
// material" POST fails because the network blipped, we must NOT lose it. This
// holds failed saves in localStorage and retries them automatically when the
// network returns, with a visible "waiting to sync" count in the UI.
//
// Scope (deliberately small): this only queues the MATERIAL-LOG write. Search
// and job lists still need live network (they're reads; if offline, the tech
// works from cached catalog / manual entry). This is the cheap, reliable
// approach for "rarely fully offline" — not a full offline-first sync engine.

const QUEUE_KEY = "ts_pending_logs";
const API = import.meta.env.VITE_API || "https://truck-stock-worker.tiny-truth-e86a.workers.dev";

function readQueue() {
  try { return JSON.parse(localStorage.getItem(QUEUE_KEY) || "[]"); }
  catch { return []; }
}
function writeQueue(q) {
  localStorage.setItem(QUEUE_KEY, JSON.stringify(q));
}

export function pendingCount() {
  return readQueue().length;
}

// Queued (not-yet-synced) saves for one job, in the order they were logged.
// Used to render those items optimistically so the tech sees what they logged
// before it syncs (prevents re-logging duplicates).
export function pendingItemsForJob(jobId) {
  return readQueue().filter((it) => String(it.jobId) === String(jobId));
}

// Remove one queued (not-yet-synced) item. Safe because it never hit the
// server — undoing a mistaken offline log is purely a local-queue delete, no
// API call. Matches on queued_at + jobId + material_id; queued_at is set per
// tap so it uniquely identifies the entry (removes the first match).
export function removeFromQueue(item) {
  const q = readQueue();
  const idx = q.findIndex(
    (it) =>
      it.queued_at === item.queued_at &&
      String(it.jobId) === String(item.jobId) &&
      it.body?.material_id === item.body?.material_id
  );
  if (idx !== -1) q.splice(idx, 1);
  writeQueue(q);
  return { removed: idx !== -1, remaining: q.length };
}

// Try to POST one material log. On success returns the server result.
// On failure, enqueues it and rethrows so the caller can show "queued".
export async function logMaterialResilient(jobId, body) {
  const payload = { jobId, body, queued_at: Date.now() };
  try {
    const r = await fetch(`${API}/api/jobs/${encodeURIComponent(jobId)}/materials`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error("log " + r.status);
    return { ok: true, result: await r.json() };
  } catch (e) {
    const q = readQueue();
    q.push(payload);
    writeQueue(q);
    return { ok: false, queued: true, error: String(e.message || e) };
  }
}

// Attempt to flush the queue. Returns how many synced. Safe to call often
// (on app focus, on network 'online' event, on a timer).
export async function flushQueue() {
  let q = readQueue();
  if (q.length === 0) return { synced: 0, remaining: 0 };
  const stillPending = [];
  let synced = 0;
  for (const item of q) {
    try {
      const r = await fetch(`${API}/api/jobs/${encodeURIComponent(item.jobId)}/materials`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(item.body),
      });
      if (!r.ok) throw new Error("retry " + r.status);
      synced++;
    } catch {
      stillPending.push(item); // keep for next attempt
    }
  }
  writeQueue(stillPending);
  return { synced, remaining: stillPending.length };
}

// Wire automatic flushing: when the browser regains connectivity, and when the
// app is refocused (tech comes back into signal and reopens the app).
export function startAutoFlush(onChange) {
  const run = () => flushQueue().then((r) => onChange && onChange(r));
  window.addEventListener("online", run);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") run();
  });
  // Also try every 30s while open, in case 'online' doesn't fire.
  setInterval(run, 30000);
  run(); // attempt once on load
}
