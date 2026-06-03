import { useState, useEffect, useRef } from "react";
import { getTechs, getTodaysJobs, searchMaterials, getJobMaterials, logMaterial, deleteMaterial } from "./api";

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
  const timer = useRef(null);

  // Load already-logged materials for this job.
  function refresh() {
    getJobMaterials(job.id).then((r) => {
      setItems(r.items || []);
      setTotal(r.total_material_cost || 0);
    }).catch(() => {});
  }
  useEffect(refresh, [job]);

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
      await logMaterial(job.id, {
        material_id: m.id,
        quantity: 1,
        tech_id: tech.st_tech_id,
        job_number: job.num,
      });
      setQ(""); setResults([]);
      refresh();
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

  return (
    <div style={styles.screen}>
      <div style={styles.topbar}>
        <button style={styles.linkBtn} onClick={onBack}>← jobs</button>
        <span style={styles.who}>{job.cust || job.num}</span>
      </div>

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
        <span style={styles.muted}>On this job</span>
        <span style={{ fontSize: 20, fontWeight: 500 }}>{fmt(total)}</span>
      </div>

      {items.length === 0 && <div style={styles.muted}>No materials logged yet.</div>}
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
  loggedRow: { display: "flex", alignItems: "center", padding: "8px 0", borderBottom: "1px solid #eee" },
  ellip: { fontSize: 15, fontWeight: 500, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" },
};
