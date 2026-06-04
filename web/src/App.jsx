import { useState, useEffect, useRef } from "react";
import { getTechs, getTodaysJobs, searchMaterials, getJobMaterials, deleteMaterial } from "./api";
import { logMaterialResilient, flushQueue, pendingCount, pendingItemsForJob, removeFromQueue, startAutoFlush } from "./syncQueue";

const fmt = (n) => "$" + (Number(n) || 0).toFixed(2);
const STORE_KEY = "ts_tech"; // remembers the logged-in tech on this device

export default function App() {
  const [tech, setTech] = useState(null);

  // Restore "logged in" tech from this device.
  useEffect(() => {
    const saved = localStorage.getItem(STORE_KEY);
    if (saved) {
      try { setTech(JSON.parse(saved)); } catch {}
    }
  }, []);

  // Start the offline-save auto-flush once for the whole app. When the queue
  // drains (or changes), broadcast so the Capture screen can update its
  // pending badge and re-pull the current job's list for anything that synced.
  useEffect(() => {
    startAutoFlush((r) => {
      window.dispatchEvent(new CustomEvent("ts-queue-changed", { detail: r }));
    });
  }, []);

  function chooseTech(t) {
    localStorage.setItem(STORE_KEY, JSON.stringify(t));
    setTech(t);
  }
  function signOut() {
    localStorage.removeItem(STORE_KEY);
    setTech(null);
  }

  if (!tech) return <PickTech onPick={chooseTech} />;
  return <Jobs tech={tech} onSignOut={signOut} />;
}

// ---- Screen 1: pick your name (one time per device) ----------------------
function PickTech({ onPick }) {
  const [techs, setTechs] = useState(null);
  const [err, setErr] = useState(null);

  useEffect(() => {
    getTechs().then(setTechs).catch((e) => setErr(String(e.message || e)));
  }, []);

  return (
    <div style={styles.screen}>
      <h1 style={styles.h1}>Who are you?</h1>
      <p style={styles.sub}>Tap your name. This device will remember you.</p>
      {err && <div style={styles.error}>Couldn't load techs: {err}</div>}
      {!techs && !err && <div style={styles.muted}>Loading…</div>}
      {techs && techs.map((t) => (
        <button key={t.id} style={styles.bigRow} onClick={() => onPick(t)}>
          {t.name}
        </button>
      ))}
    </div>
  );
}

// ---- Screen 2: today's jobs (with manual fallback) -----------------------
function Jobs({ tech, onSignOut }) {
  const [jobs, setJobs] = useState(null);
  const [manual, setManual] = useState(false);
  const [manualId, setManualId] = useState("");
  const [active, setActive] = useState(null); // selected job

  useEffect(() => {
    getTodaysJobs(tech.st_tech_id)
      .then((r) => {
        setJobs(r.jobs || []);
        if (r.fallback === "manual" || (r.jobs || []).length === 0) setManual(true);
      })
      .catch(() => setManual(true));
  }, [tech]);

  function openManual() {
    const id = manualId.trim();
    if (!/^\d+$/.test(id)) {
      alert("Job ID must be the numeric ServiceTitan job number.");
      return;
    }
    setActive({ id: Number(id), num: "JOB-" + id, cust: "Manual entry" });
  }

  if (active) {
    return <Capture tech={tech} job={active} onBack={() => setActive(null)} />;
  }

  return (
    <div style={styles.screen}>
      <div style={styles.topbar}>
        <span style={styles.who}>{tech.name}</span>
        <button style={styles.linkBtn} onClick={onSignOut}>Not you?</button>
      </div>
      <h1 style={styles.h1}>Today's jobs</h1>

      {jobs && jobs.map((j) => (
        <button key={j.id} style={styles.jobRow} onClick={() => setActive(j)}>
          <div style={{ fontWeight: 500, fontSize: 16 }}>{j.cust || j.num}</div>
          <div style={styles.muted}>{j.addr || j.num}</div>
        </button>
      ))}

      {manual && (
        <div style={{ marginTop: 16 }}>
          <p style={styles.sub}>
            Enter the ServiceTitan job number to log materials against it.
          </p>
          <input
            style={styles.input}
            inputMode="numeric"
            placeholder="e.g. 480231"
            value={manualId}
            onChange={(e) => setManualId(e.target.value)}
          />
          <button style={styles.primary} onClick={openManual}>Open job</button>
        </div>
      )}
      {!jobs && !manual && <div style={styles.muted}>Loading jobs…</div>}
    </div>
  );
}

// ---- Screen 3: material capture ------------------------------------------
function Capture({ tech, job, onBack }) {
  const [q, setQ] = useState("");
  const [results, setResults] = useState([]);
  const [items, setItems] = useState([]);
  const [total, setTotal] = useState(0);
  const [saving, setSaving] = useState(false);
  const [deletingId, setDeletingId] = useState(null); // line id currently deleting
  const [pending, setPending] = useState(pendingCount());       // global count (banner)
  const [pendingItems, setPendingItems] = useState([]);         // this job's queued saves
  const [note, setNote] = useState("");                          // transient status note
  const timer = useRef(null);
  const noteTimer = useRef(null);

  // Load already-logged materials for this job (server-confirmed lines).
  function refresh() {
    getJobMaterials(job.id).then((r) => {
      setItems(r.items || []);
      setTotal(r.total_material_cost || 0);
    }).catch(() => {});
  }

  // Recompute the offline view: the banner count + this job's queued items.
  function refreshPendingView() {
    setPending(pendingCount());
    setPendingItems(pendingItemsForJob(job.id));
  }
  useEffect(() => { refresh(); refreshPendingView(); }, [job]);

  // Show a brief note that auto-clears (e.g. "Saved offline…").
  function flashNote(msg) {
    setNote(msg);
    clearTimeout(noteTimer.current);
    noteTimer.current = setTimeout(() => setNote(""), 3000);
  }

  // Manual "sync now" — tapping the banner forces a flush attempt instead of
  // waiting for startAutoFlush's automatic triggers. Updates the pending count
  // from the result and re-pulls the job list for anything that synced.
  const [syncing, setSyncing] = useState(false);
  async function syncNow() {
    if (syncing) return;
    setSyncing(true);
    try {
      const r = await flushQueue();
      refreshPendingView();
      // Broadcast so any future listeners behave the same as on auto-flush.
      window.dispatchEvent(new CustomEvent("ts-queue-changed", { detail: r }));
      if (r.synced > 0) {
        refresh();
        flashNote(`Synced ${r.synced} item${r.synced === 1 ? "" : "s"}`);
      } else if (r.remaining > 0) {
        flashNote("Still offline — will keep trying");
      }
    } finally {
      setSyncing(false);
    }
  }

  // React to the app-level auto-flush: update the pending badge, and if
  // anything actually synced, re-pull this job's list so the items appear.
  useEffect(() => {
    const onQueueChanged = (e) => {
      refreshPendingView();
      if (e.detail && e.detail.synced > 0) refresh();
    };
    window.addEventListener("ts-queue-changed", onQueueChanged);
    return () => window.removeEventListener("ts-queue-changed", onQueueChanged);
  }, [job]);

  // Debounced search.
  useEffect(() => {
    clearTimeout(timer.current);
    if (q.trim().length < 2) { setResults([]); return; }
    timer.current = setTimeout(() => {
      searchMaterials(q).then(setResults).catch(() => setResults([]));
    }, 180);
    return () => clearTimeout(timer.current);
  }, [q]);

  async function add(m) {
    setSaving(true);
    try {
      const res = await logMaterialResilient(job.id, {
        material_id: m.id,
        quantity: 1,
        tech_id: tech.st_tech_id,
        job_number: job.num,
        // Display-only fields (underscore-prefixed). The worker ignores unknown
        // keys, so these ride along only to render the queued item optimistically
        // before it syncs. _cost is the catalog estimate; the server freezes the
        // authoritative cost at flush time.
        _name: m.name,
        _cost: m.cost,
      });
      setQ(""); setResults([]);
      if (res.queued) {
        // Save failed but is safely queued — reassure, don't alarm. The item is
        // shown immediately as a pending row so the tech won't re-log it.
        refreshPendingView();
        flashNote("Saved offline — will sync when back online");
      } else {
        refresh();
      }
    } catch (e) {
      alert("Couldn't save: " + (e.message || e));
    } finally {
      setSaving(false);
    }
  }

  async function remove(it) {
    setDeletingId(it.id);
    try {
      await deleteMaterial(job.id, it.id);
      refresh();
    } catch (e) {
      alert("Couldn't delete: " + (e.message || e));
    } finally {
      setDeletingId(null);
    }
  }

  // Undo a queued (not-yet-synced) item — purely a local-queue delete, no
  // server call, since it never reached the server.
  function removePending(p) {
    removeFromQueue(p);
    refreshPendingView();
  }

  // Estimated cost of queued-but-unsynced items (catalog cost we already have).
  // Folded into the displayed total, but labelled so it's clear it's not yet
  // server-confirmed.
  const pendingEst = pendingItems.reduce(
    (a, p) => a + (Number(p.body._cost) || 0) * (Number(p.body.quantity) || 0),
    0
  );

  return (
    <div style={styles.screen}>
      <div style={styles.topbar}>
        <button style={styles.linkBtn} onClick={onBack}>← jobs</button>
        <span style={styles.who}>{job.cust || job.num}</span>
      </div>

      {pending > 0 && (
        <button
          style={styles.syncBanner}
          onClick={syncNow}
          disabled={syncing}
          aria-label="sync pending items now"
        >
          ⏳ {pending} item{pending === 1 ? "" : "s"} waiting to sync
          {" · "}{syncing ? "syncing…" : "tap to sync now"}
        </button>
      )}
      {note && <div style={styles.note}>{note}</div>}

      <input
        style={styles.input}
        placeholder="Search materials… (try 'copper')"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        autoFocus
      />

      {results.map((m) => (
        <div key={m.id} style={styles.resultRow}>
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={styles.ellip}>{m.name}</div>
            <div style={styles.muted}>{m.category} · {fmt(m.cost)}</div>
          </div>
          <button style={styles.addBtn} disabled={saving} onClick={() => add(m)} aria-label={"add " + m.name}>+</button>
        </div>
      ))}

      <div style={styles.totalBar}>
        <span style={styles.muted}>
          On this job
          {pendingItems.length > 0 && (
            <span style={styles.inclPending}> (incl. {pendingItems.length} pending)</span>
          )}
        </span>
        <span style={{ fontSize: 20, fontWeight: 500 }}>{fmt(total + pendingEst)}</span>
      </div>

      {items.length === 0 && pendingItems.length === 0 && (
        <div style={styles.muted}>No materials logged yet.</div>
      )}

      {/* Optimistic rows: queued offline, not yet on the server. Shown greyed
          with ⏳ so the tech always sees what they logged and won't re-add it.
          No delete button — there's no server line id to delete yet. */}
      {pendingItems.map((p, i) => (
        <div key={"pending-" + p.queued_at + "-" + i} style={styles.pendingRow}>
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={styles.ellip}>
              {p.body._name || ("Material #" + p.body.material_id)}
            </div>
            <div style={styles.muted}>
              ⏳ pending · {fmt(p.body._cost)} × {p.body.quantity} (est.)
            </div>
          </div>
          <button
            style={styles.delBtn}
            onClick={() => removePending(p)}
            aria-label={"remove pending " + (p.body._name || ("material #" + p.body.material_id))}
          >
            ×
          </button>
        </div>
      ))}

      {items.map((it) => (
        <div key={it.id} style={styles.loggedRow}>
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={styles.ellip}>{it.name || ("Material #" + it.material_id)}</div>
            <div style={styles.muted}>{fmt(it.unit_cost)} × {it.quantity} = {fmt(it.total_cost)}</div>
          </div>
          <button
            style={styles.delBtn}
            disabled={deletingId === it.id}
            onClick={() => remove(it)}
            aria-label={"delete " + (it.name || ("material #" + it.material_id))}
          >
            {deletingId === it.id ? "…" : "×"}
          </button>
        </div>
      ))}
    </div>
  );
}

const styles = {
  screen: { maxWidth: 480, margin: "0 auto", padding: 16, fontFamily: "system-ui, sans-serif" },
  h1: { fontSize: 22, fontWeight: 600, margin: "8px 0 4px" },
  sub: { fontSize: 14, color: "#555", margin: "0 0 12px" },
  muted: { fontSize: 13, color: "#777" },
  error: { fontSize: 14, color: "#a32d2d", padding: 8, background: "#fcebeb", borderRadius: 8, margin: "8px 0" },
  topbar: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 },
  who: { fontSize: 14, fontWeight: 500 },
  linkBtn: { background: "none", border: "none", color: "#185fa5", fontSize: 14, padding: 4, cursor: "pointer" },
  bigRow: { display: "block", width: "100%", textAlign: "left", padding: "16px", fontSize: 17, marginBottom: 8, border: "1px solid #ddd", borderRadius: 10, background: "#fff", cursor: "pointer" },
  jobRow: { display: "block", width: "100%", textAlign: "left", padding: "14px", marginBottom: 8, border: "1px solid #ddd", borderRadius: 10, background: "#fff", cursor: "pointer" },
  input: { width: "100%", height: 48, fontSize: 16, padding: "0 12px", boxSizing: "border-box", border: "1px solid #ccc", borderRadius: 10, marginBottom: 10 },
  primary: { width: "100%", height: 48, fontSize: 16, fontWeight: 500, background: "#185fa5", color: "#fff", border: "none", borderRadius: 10, cursor: "pointer" },
  resultRow: { display: "flex", alignItems: "center", justifyContent: "space-between", padding: "10px 12px", marginBottom: 6, border: "1px solid #eee", borderRadius: 10, background: "#fff" },
  addBtn: { width: 44, height: 44, flex: "none", marginLeft: 8, fontSize: 24, lineHeight: "44px", border: "none", borderRadius: 10, background: "#1d9e75", color: "#fff", cursor: "pointer" },
  delBtn: { width: 44, height: 44, flex: "none", marginLeft: 8, fontSize: 24, lineHeight: "44px", border: "none", borderRadius: 10, background: "#c0392b", color: "#fff", cursor: "pointer" },
  totalBar: { display: "flex", justifyContent: "space-between", alignItems: "baseline", borderTop: "1px solid #ddd", paddingTop: 12, marginTop: 12, marginBottom: 8 },
  inclPending: { color: "#8a5a00", fontStyle: "italic" },
  loggedRow: { display: "flex", alignItems: "center", padding: "8px 0", borderBottom: "1px solid #eee" },
  pendingRow: { display: "flex", alignItems: "center", padding: "8px 0", borderBottom: "1px dashed #ddd", opacity: 0.6 },
  syncBanner: { display: "block", width: "100%", textAlign: "left", font: "inherit", fontSize: 13, color: "#8a5a00", background: "#fff5e0", border: "1px solid #f0d68a", borderRadius: 8, padding: "10px", marginBottom: 10, cursor: "pointer" },
  note: { fontSize: 13, color: "#185fa5", background: "#eaf2fb", border: "1px solid #bcd6f2", borderRadius: 8, padding: "8px 10px", marginBottom: 10 },
  ellip: { fontSize: 15, fontWeight: 500, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" },
};
