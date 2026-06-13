import { useState, useEffect, useRef } from "react";
import { getTechs, getTodaysJobs, searchMaterials, getJobMaterials, deleteMaterial, patchMaterialQty,
  scanReceipt, savePurchase, saveOverheadPurchase, restockFromShop, getJobPurchases, deletePurchase, patchPurchase,
  getByCategory, createRequest, receiptPhotoUrl } from "./api";
import { logMaterialResilient, flushQueue, pendingCount, pendingItemsForJob, removeFromQueue, startAutoFlush } from "./syncQueue";
import { C, FONT, DISP, SHADOW, BADGE } from "./theme.js";

const fmt = (n) => "$" + (Number(n) || 0).toFixed(2);
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100; // round to cents
const TAX_RATE = 0.12; // PST + GST
// Matched receipt lines carry this in notes; they show under "Receipts", NOT in
// "On this job" (and are excluded from its total) — option A / GP-consistent.
const RECEIPT_NOTE_PREFIX = "receipt purchase #";
const isReceiptLine = (it) => (it.notes || "").startsWith(RECEIPT_NOTE_PREFIX);
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

// ---- Screen 2: today's jobs (current / upcoming + manual fallback) --------
// The endpoint returns one row per job with a per-appointment status. We split
// the on-site (Working) jobs out as "Current" and highlight them; Dispatched
// (en route) + Scheduled fall under "Upcoming". Tapping any job opens Capture.
const STATUS_BADGE = {
  Working:    { label: "On site",   fg: C.greenInk,  bg: C.greenWash },
  Dispatched: { label: "En route",  fg: C.purpleInk, bg: C.purpleWash },
  Scheduled:  { label: "Scheduled", fg: C.ink2,      bg: C.sunk },
  Done:       { label: "Done",      fg: C.amberInk,  bg: C.amberWash },
  Paused:     { label: "Paused",    fg: C.amberInk,  bg: C.amberWash },
};
// Map the worker's job shape onto what Capture expects (id / num / cust),
// carrying status + address + start for the list UI.
const normalizeJob = (j) => ({
  id: j.job_id, num: j.job_number, cust: j.customer,
  addr: j.address, status: j.status, start: j.start_date,
});
const fmtTime = (iso) => {
  try {
    return new Date(iso).toLocaleTimeString("en-US", {
      timeZone: "America/Vancouver", hour: "numeric", minute: "2-digit",
    });
  } catch { return ""; }
};

function JobCard({ job, onTap, current, recent }) {
  const b = STATUS_BADGE[job.status] || STATUS_BADGE.Scheduled;
  const meta = (job.addr || ("Job " + job.num)) + (job.start ? " · " + fmtTime(job.start) : "");
  // On-site job = dark hero card: the one job you're on, readable across a cab.
  if (current) {
    return (
      <button style={styles.heroCard} className="fm-press" onClick={onTap}>
        <div style={styles.heroTop}>
          <span style={styles.heroCust}>{job.cust || ("Job " + job.num)}</span>
          <span style={styles.heroChip}><span style={styles.heroDot} className="fm-glow" />On site</span>
        </div>
        <div style={styles.heroMeta}>{meta}</div>
        <div style={styles.heroAction}>Log materials <span style={{ fontWeight: 800 }}>→</span></div>
      </button>
    );
  }
  return (
    <button style={recent ? styles.jobRowRecent : styles.jobRow} className="fm-press" onClick={onTap}>
      <div style={styles.jobRowTop}>
        <span style={styles.jobCust}>{job.cust || ("Job " + job.num)}</span>
        <span style={{ ...styles.badge, color: b.fg, background: b.bg }}>{b.label}</span>
      </div>
      <div style={styles.muted}>{meta}</div>
      {recent && <div style={styles.recentHint}>tap to add a forgotten material</div>}
    </button>
  );
}

function Jobs({ tech, onSignOut }) {
  const [data, setData] = useState(null);     // { jobs:[normalized], date } | null
  const [manual, setManual] = useState(false);
  const [manualId, setManualId] = useState("");
  const [active, setActive] = useState(null); // selected job
  const [overhead, setOverhead] = useState(false); // off-cycle / overhead purchase (no job)
  const [fromShop, setFromShop] = useState(false); // restock from shop (shop→van transfer)
  const [err, setErr] = useState(false);

  useEffect(() => {
    setData(null); setErr(false);
    getTodaysJobs(tech.st_tech_id)
      .then((r) => {
        const jobs = (r.jobs || []).map(normalizeJob);
        const recent = (r.recent || []).map(normalizeJob);
        setData({ jobs, recent, date: r.date });
        if (r.fallback === "manual" || jobs.length === 0) setManual(true);
      })
      .catch(() => { setData({ jobs: [], recent: [] }); setManual(true); setErr(true); });
  }, [tech]);

  function openManual() {
    const id = manualId.trim();
    if (!/^\d+$/.test(id)) {
      alert("Job ID must be the numeric ServiceTitan job number.");
      return;
    }
    setActive({ id: Number(id), num: id, cust: "Manual entry" });
  }

  if (active) {
    return <Capture tech={tech} job={active} onBack={() => setActive(null)} />;
  }
  if (overhead) {
    // No job: a pseudo-job flagged overhead. ReceiptScan routes the save to
    // /api/overhead/purchases and logs no matched materials.
    return <ReceiptScan tech={tech} job={{ id: 0, num: "off-cycle", cust: "Off-cycle purchase", overhead: true }}
      onDone={() => setOverhead(false)} onCancel={() => setOverhead(false)} />;
  }
  if (fromShop) {
    return <FromShopRestock tech={tech} onBack={() => setFromShop(false)} />;
  }

  const jobs = data ? data.jobs : null;
  const recent = (data && data.recent) || [];
  const working = (jobs || []).filter((j) => j.status === "Working");
  const upcoming = (jobs || []).filter((j) => j.status !== "Working");

  return (
    <div style={styles.screen}>
      <div style={styles.topbar}>
        <span style={styles.who}>{tech.name}</span>
        <button style={styles.linkBtn} onClick={onSignOut}>Not you?</button>
      </div>
      <h1 style={styles.h1}>Today's jobs</h1>

      {!jobs && !err && <div style={styles.muted}>Loading jobs…</div>}

      {working.length > 0 && (
        <>
          <div style={styles.sectionLabel}>Current</div>
          {working.map((j) => <JobCard key={j.id} job={j} current onTap={() => setActive(j)} />)}
        </>
      )}
      {upcoming.length > 0 && (
        <>
          <div style={styles.sectionLabel}>Upcoming</div>
          {upcoming.map((j) => <JobCard key={j.id} job={j} onTap={() => setActive(j)} />)}
        </>
      )}
      {jobs && jobs.length === 0 && !err && (
        <div style={styles.muted}>No jobs assigned to you for today.</div>
      )}
      {err && <div style={styles.error}>Couldn't load today's jobs — enter the job number below.</div>}

      {/* Off-cycle / overhead purchase — a receipt with no job (consumables, shop
          supplies). Reuses the scanner; writes an overhead-flagged purchase. */}
      <button style={styles.actRow} className="fm-press" onClick={() => setOverhead(true)}>
        <span style={{ ...styles.actIco, color: C.amberInk, background: C.amberWash }}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M5 3h11l3 3v15H5z" /><path d="M9 8h6M9 12h6M9 16h4" /></svg>
        </span>
        <span style={styles.actText}>
          <span style={styles.actTitle}>Off-cycle purchase</span>
          <span style={styles.actDesc}>A receipt that's not for a job</span>
        </span>
      </button>
      <button style={styles.actRow} className="fm-press" onClick={() => setFromShop(true)}>
        <span style={{ ...styles.actIco, color: C.greenInk, background: C.greenWash }}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 8l9-5 9 5-9 5z" /><path d="M3 8v8l9 5 9-5V8" /></svg>
        </span>
        <span style={styles.actText}>
          <span style={styles.actTitle}>Restocked from shop</span>
          <span style={styles.actDesc}>Pulled stock to my van</span>
        </span>
      </button>

      {/* Manual entry: auto-shown when there are no jobs / fallback="manual",
          and reachable via the toggle for a job that isn't on the list. */}
      {!manual && jobs && jobs.length > 0 && (
        <button style={styles.manualToggle} onClick={() => setManual(true)}>
          Different job? Enter a number
        </button>
      )}
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

      {/* Recent / finished tier — de-emphasized, below everything. Paused/Done
          jobs from the last 3 days; tap to log a forgotten material. */}
      {recent.length > 0 && (
        <div style={styles.recentSection}>
          <div style={styles.sectionLabel}>Recently finished · last 3 days</div>
          {recent.map((j) => <JobCard key={j.id} job={j} recent onTap={() => setActive(j)} />)}
        </div>
      )}
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
  const [qtySavingId, setQtySavingId] = useState(null); // line id whose qty is saving
  const [pending, setPending] = useState(pendingCount());       // global count (banner)
  const [pendingItems, setPendingItems] = useState([]);         // this job's queued saves
  const [note, setNote] = useState("");                          // transient status note
  const [showReceipt, setShowReceipt] = useState(false);         // receipt-scan sub-screen
  const [purchases, setPurchases] = useState([]);                // saved receipts on this job
  const [categories, setCategories] = useState([]);              // catalog grouped, for browse
  const [openCat, setOpenCat] = useState(null);                  // one category open at a time
  const [showReq, setShowReq] = useState(false);                 // special-request form open
  const [reqDesc, setReqDesc] = useState("");
  const [reqQty, setReqQty] = useState("");
  const [reqNotes, setReqNotes] = useState("");
  const [reqBusy, setReqBusy] = useState(false);
  const timer = useRef(null);
  const noteTimer = useRef(null);

  // Load this job's logged materials (van-used only — receipt-matched lines are
  // excluded here and shown under Receipts) + the saved receipts.
  function refresh() {
    getJobMaterials(job.id).then((r) => {
      const vanItems = (r.items || []).filter((it) => !isReceiptLine(it));
      setItems(vanItems);
      setTotal(vanItems.reduce((a, x) => a + (x.total_cost || 0), 0));
    }).catch(() => {});
    getJobPurchases(job.id).then((r) => setPurchases(r.purchases || [])).catch(() => {});
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

  // Load the catalog grouped by category for the browse (once on mount).
  useEffect(() => { getByCategory().then((d) => setCategories(d.categories || [])).catch(() => {}); }, []);

  // Send a free-text "can't find it" request to the office.
  async function submitRequest() {
    if (!reqDesc.trim()) { alert("Describe the item you need."); return; }
    setReqBusy(true);
    try {
      await createRequest({
        tech_id: tech.st_tech_id, job_id: job.id, description: reqDesc.trim(),
        quantity: Number(reqQty) > 0 ? Number(reqQty) : 1,
        notes: reqNotes.trim() || undefined,
      });
      setReqDesc(""); setReqQty(""); setReqNotes(""); setShowReq(false);
      flashNote("Request sent to the office");
    } catch (e) {
      alert("Couldn't send request: " + (e.message || e));
    } finally {
      setReqBusy(false);
    }
  }

  // Commit a quantity edit from a logged row's numeric input. Online-only:
  // calls PATCH then refreshes. Ignores no-ops; resets the field on bad/failed
  // input so it never shows a value the server didn't accept.
  async function commitQty(it, inputEl) {
    const q = Math.floor(Number(inputEl.value));
    if (!Number.isFinite(q) || q <= 0) { inputEl.value = String(it.quantity); return; }
    if (q === it.quantity) return; // unchanged
    setQtySavingId(it.id);
    try {
      await patchMaterialQty(job.id, it.id, q);
      refresh();
    } catch (e) {
      alert("Couldn't update quantity: " + (e.message || e));
      inputEl.value = String(it.quantity); // revert to last-known-good
    } finally {
      setQtySavingId(null);
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

  // Receipt scanner takes over the screen while active; on save, refresh the
  // job's logged lines (matched receipt items may have been logged) and flash.
  if (showReceipt) {
    return (
      <ReceiptScan
        tech={tech}
        job={job}
        onCancel={() => setShowReceipt(false)}
        onDone={(r) => { setShowReceipt(false); refresh(); flashNote(`Receipt saved${r?.logged_to_materials?.length ? ` · ${r.logged_to_materials.length} logged to job` : ""}`); }}
      />
    );
  }

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

      <button style={styles.scanBtn} onClick={() => setShowReceipt(true)}>
        📷 Scan a receipt (supplier purchase — not off the van)
      </button>

      {results.map((m) => (
        <div key={m.id} style={styles.resultRow}>
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={styles.ellip}>{m.name}</div>
            <div style={styles.muted}>{m.category} · {fmt(m.cost)}</div>
          </div>
          <button style={styles.addBtn} disabled={saving} onClick={() => add(m)} aria-label={"add " + m.name}>+</button>
        </div>
      ))}

      {categories.length > 0 && (
        <div style={styles.browseSection}>
          <div style={styles.browseLabel}>Browse by category</div>
          {categories.map((c) => (
            <div key={c.name} style={styles.catBlock}>
              <button style={styles.catHeader} onClick={() => setOpenCat(openCat === c.name ? null : c.name)}>
                <span>{c.name}</span>
                <span style={styles.muted}>{c.count} {openCat === c.name ? "▾" : "▸"}</span>
              </button>
              {openCat === c.name && c.items.map((m) => (
                <div key={m.id} style={styles.catItemRow}>
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div style={styles.ellip}>{m.name}</div>
                    <div style={styles.muted}>{fmt(m.cost)}</div>
                  </div>
                  <button style={styles.addBtn} disabled={saving} onClick={() => add(m)} aria-label={"add " + m.name}>+</button>
                </div>
              ))}
            </div>
          ))}
        </div>
      )}

      <div style={styles.reqSection}>
        {!showReq ? (
          <button style={styles.reqEntry} onClick={() => setShowReq(true)}>🙋 Request an item / can't find it?</button>
        ) : (
          <div style={styles.reqForm}>
            <input style={styles.input} placeholder="What do you need? e.g. 1/2 brass nipple" value={reqDesc} onChange={(e) => setReqDesc(e.target.value)} autoFocus />
            <div style={styles.reqRow}>
              <span style={styles.muted}>qty</span>
              <input type="text" inputMode="numeric" style={styles.reqQtyInput} value={reqQty} onChange={(e) => setReqQty(e.target.value)} placeholder="1" />
            </div>
            <input style={styles.input} placeholder="notes (optional)" value={reqNotes} onChange={(e) => setReqNotes(e.target.value)} />
            <button style={styles.primary} disabled={reqBusy} onClick={submitRequest}>{reqBusy ? "Sending…" : "Send request to office"}</button>
            <button style={styles.scanBtn} onClick={() => { setShowReq(false); setReqDesc(""); setReqQty(""); setReqNotes(""); }}>cancel</button>
          </div>
        )}
      </div>

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
            <div style={styles.muted}>{fmt(it.unit_cost)} each · {fmt(it.total_cost)}</div>
          </div>
          {/* Quantity editor. Uncontrolled + key includes quantity so the field
              resets to the server value after a successful edit. Numeric keypad
              on phones; commits on blur / Enter. */}
          <input
            key={"qty-" + it.id + "-" + it.quantity}
            type="text"
            inputMode="numeric"
            pattern="[0-9]*"
            defaultValue={it.quantity}
            disabled={qtySavingId === it.id}
            style={styles.qtyInput}
            onFocus={(e) => e.target.select()}
            onBlur={(e) => commitQty(it, e.target)}
            onKeyDown={(e) => { if (e.key === "Enter") e.target.blur(); }}
            aria-label={"quantity for " + (it.name || ("material #" + it.material_id))}
          />
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

      {purchases.length > 0 && (
        <div style={styles.receiptsSection}>
          <div style={styles.receiptsLabel}>Receipts (supplier purchases)</div>
          {purchases.map((pu) => (
            <ReceiptRow key={pu.id} jobId={job.id} purchase={pu} onChanged={refresh} />
          ))}
        </div>
      )}
    </div>
  );
}

// One saved receipt on the capture screen: collapsed summary; expand to its
// matched lines; edit the header (supplier/subtotal/total with tax recompute);
// delete (removes the receipt + its matched lines, no van reversal).
function ReceiptRow({ jobId, purchase, onChanged }) {
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [supplier, setSupplier] = useState(purchase.supplier || "");
  const [subtotal, setSubtotal] = useState(purchase.subtotal != null ? String(purchase.subtotal) : "");
  const [total, setTotal] = useState(purchase.receipt_total != null ? String(purchase.receipt_total) : "");
  const tax = r2((Number(total) || 0) - (Number(subtotal) || 0));
  function onSubtotal(v) { setSubtotal(v); setTotal(String(r2((Number(v) || 0) * (1 + TAX_RATE)))); }
  const lines = purchase.lines || [];

  async function del() {
    if (!confirm(`Delete this receipt (${purchase.supplier} · ${fmt(purchase.receipt_total)})?\nRemoves it and any matched lines it logged. No van stock changes.`)) return;
    setBusy(true);
    try { await deletePurchase(jobId, purchase.id); onChanged(); }
    catch (e) { alert("Delete failed: " + (e.message || e)); setBusy(false); }
  }
  async function saveEdit() {
    setBusy(true);
    try {
      await patchPurchase(jobId, purchase.id, { supplier: supplier.trim(), subtotal: Number(subtotal) || 0, tax, total: Number(total) || 0 });
      setEditing(false); onChanged();
    } catch (e) { alert("Edit failed: " + (e.message || e)); setBusy(false); }
  }

  return (
    <div style={styles.receiptCard}>
      <div style={styles.receiptHead}>
        <button style={styles.receiptToggle} onClick={() => setOpen((o) => !o)}>
          <span style={styles.ellip}>{purchase.supplier || "Receipt"}</span>
          <span style={styles.muted}>
            {fmt(purchase.receipt_total)} · {lines.length} item{lines.length === 1 ? "" : "s"} {open ? "▾" : "▸"}
          </span>
        </button>
        <button style={styles.editBtnSm} disabled={busy} onClick={() => setEditing((e) => !e)}>edit</button>
        <button style={styles.delBtnSm} disabled={busy} onClick={del} aria-label="delete receipt">{busy ? "…" : "×"}</button>
      </div>

      {open && !editing && (
        <div style={styles.receiptBody}>
          <div style={styles.muted}>Subtotal {fmt(purchase.subtotal)} · Tax {fmt(purchase.tax)} · Total {fmt(purchase.receipt_total)}</div>
          {lines.map((ln) => (
            <div key={ln.line_id} style={styles.muted}>· {ln.material || ("#" + ln.material_id)} ×{ln.quantity} ({fmt(ln.total_cost)})</div>
          ))}
          {lines.length === 0 && <div style={styles.muted}>· no matched catalog lines</div>}
          {purchase.has_photo ? (
            <a href={receiptPhotoUrl(purchase.id)} target="_blank" rel="noreferrer">
              <img src={receiptPhotoUrl(purchase.id)} alt="receipt" style={styles.thumb} />
            </a>
          ) : null}
        </div>
      )}

      {editing && (
        <div style={styles.receiptBody}>
          <div style={styles.muted}>Supplier</div>
          <input style={styles.input} value={supplier} onChange={(e) => setSupplier(e.target.value)} />
          <div style={styles.taxRow}><span style={styles.muted}>Subtotal</span><input style={styles.taxInput} inputMode="decimal" value={subtotal} onChange={(e) => onSubtotal(e.target.value)} /></div>
          <div style={styles.taxRow}><span style={styles.muted}>Tax (12%)</span><span style={styles.taxVal}>{fmt(tax)}</span></div>
          <div style={styles.taxRow}><span style={{ fontWeight: 700 }}>Total</span><input style={{ ...styles.taxInput, fontWeight: 700 }} inputMode="decimal" value={total} onChange={(e) => setTotal(e.target.value)} /></div>
          <button style={styles.primary} disabled={busy} onClick={saveEdit}>{busy ? "Saving…" : "Save changes"}</button>
        </div>
      )}
    </div>
  );
}

// Downscale a captured photo (phone cameras are huge) and return RAW base64 —
// keeps the upload small/fast; the receipt text stays legible at ~1600px.
function fileToScaledBase64(file, maxDim = 1600, quality = 0.85) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("couldn't read the photo"));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error("couldn't decode the photo"));
      img.onload = () => {
        const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
        const w = Math.round(img.width * scale), h = Math.round(img.height * scale);
        const c = document.createElement("canvas");
        c.width = w; c.height = h;
        c.getContext("2d").drawImage(img, 0, 0, w, h);
        const dataUrl = c.toDataURL("image/jpeg", quality);
        resolve({ base64: dataUrl.split(",")[1], mediaType: "image/jpeg" });
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

// ---- Receipt scanner: capture -> vision -> review/confirm -> purchases ------
// Photograph a receipt, the worker's vision endpoint extracts supplier + line
// items + catalog matches (writes nothing), the tech confirms/edits which lines
// to log, then we POST to /purchases (writes the receipt; NO van deduction).
function ReceiptScan({ tech, job, onDone, onCancel }) {
  const [phase, setPhase] = useState("capture"); // capture | scanning | review | saving
  const [err, setErr] = useState(null);
  const [supplier, setSupplier] = useState("");
  const [subtotal, setSubtotal] = useState("");
  const [total, setTotal] = useState("");
  const [lines, setLines] = useState([]);
  const [imgB64, setImgB64] = useState(null);            // the downscaled JPEG, reused for R2
  const [imgMedia, setImgMedia] = useState("image/jpeg");

  // Tax line is always derived = total − subtotal (shows 12% by default; if the
  // tech edits the total, tax follows so the three stay consistent).
  const tax = r2((Number(total) || 0) - (Number(subtotal) || 0));
  // Editing subtotal re-derives the total at the standard 12%.
  function onSubtotal(v) { setSubtotal(v); setTotal(String(r2((Number(v) || 0) * (1 + TAX_RATE)))); }

  async function onFile(e) {
    const file = e.target.files && e.target.files[0];
    e.target.value = ""; // let them re-pick the same file
    if (!file) return;
    setErr(null); setPhase("scanning");
    try {
      const { base64, mediaType } = await fileToScaledBase64(file);
      setImgB64(base64); setImgMedia(mediaType);   // keep it to store on save (no second photo)
      const r = await scanReceipt(job.id, base64, mediaType);
      setSupplier(r.supplier || "");
      // The worker already computed subtotal/total per the wholesaler rules
      // (tax-included slips kept as-is; packing slips taxed at 12%). Use them
      // directly — re-deriving would re-tax an already-tax-included total.
      setSubtotal(r.subtotal ? String(r.subtotal) : "");
      setTotal(r.total ? String(r.total) : "");
      setLines((r.items || []).map((it) => ({
        description: it.description || "",
        quantity: String(it.quantity ?? 1),
        unit_cost: String(it.unit_cost ?? 0),
        match: it.match || null,
        log: !!it.match, // default: log the matched lines
      })));
      setPhase("review");
    } catch (e2) {
      // NEVER surface raw vision/error JSON to the tech — show a friendly,
      // actionable failure screen (retry or manual entry) instead.
      console.warn("scan failed:", e2);
      setPhase("failed");
    }
  }

  function setLine(i, patch) { setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l))); }
  function removeLine(i) { setLines((ls) => ls.filter((_, j) => j !== i)); }

  // Fall back to manual entry when the scan can't run (vision busy/unreadable).
  // Keep imgB64 — the PHOTO captured fine; only parsing failed, so the receipt
  // image is still stored on save.
  function startManual() {
    setSupplier(""); setSubtotal(""); setTotal(""); setLines([]);
    setPhase("review");
  }

  async function save() {
    const t = Number(total);
    if (!supplier.trim()) { alert("Enter the supplier."); return; }
    if (!(t > 0)) { alert("Enter the receipt total."); return; }
    setPhase("saving");
    try {
      const body = {
        tech_id: tech.st_tech_id,
        supplier: supplier.trim(),
        subtotal: Number(subtotal) || 0,
        tax,
        total: t,
        image_base64: imgB64 || undefined,   // store the receipt photo in R2 (reuses the scan image)
        media_type: imgMedia,
        description: lines.map((l) => l.description).filter(Boolean).slice(0, 4).join(", "),
        // Overhead has NO job, so it logs NO matched materials.
        items: job.overhead ? [] : lines.map((l) => ({
          description: l.description,
          quantity: Number(l.quantity) || 1,
          unit_cost: Number(l.unit_cost) || 0,
          total: (Number(l.unit_cost) || 0) * (Number(l.quantity) || 1),
          material_id: l.match ? l.match.id : null,
          log_to_materials: l.match ? !!l.log : false,
        })),
      };
      const res = job.overhead ? await saveOverheadPurchase(body) : await savePurchase(job.id, body);
      onDone(res);
    } catch (e) {
      alert("Couldn't save: " + (e.message || e));
      setPhase("review");
    }
  }

  return (
    <div style={styles.screen}>
      <div style={styles.topbar}>
        <button style={styles.linkBtn} onClick={onCancel}>← cancel</button>
        <span style={styles.who}>{job.overhead ? "🧰 Off-cycle purchase" : "Receipt · " + (job.cust || job.num)}</span>
      </div>
      <h1 style={styles.h1}>{job.overhead ? "Off-cycle / overhead purchase" : "Scan a receipt"}</h1>
      {job.overhead && <div style={styles.overheadNote}>Recorded as <b>overhead / consumables</b> — not tied to a job, and touches no inventory (no van deduction, no job materials).</div>}

      {err && <div style={styles.error}>{err}</div>}

      {phase === "capture" && (
        <>
          <p style={styles.sub}>Photograph the receipt or packing slip — <b>fill the frame, get close on the line items and total</b> so the text is sharp. You'll confirm everything before saving.</p>
          <label style={{ ...styles.primary, display: "block", boxSizing: "border-box", textAlign: "center", lineHeight: "48px" }}>
            📷 Photograph the receipt
            <input type="file" accept="image/*" capture="environment" style={{ display: "none" }} onChange={onFile} />
          </label>
        </>
      )}

      {phase === "scanning" && <div style={styles.muted}>Reading the receipt…</div>}

      {phase === "failed" && (
        <div style={styles.failBox}>
          <div style={styles.failTitle}>Couldn't scan the receipt</div>
          <p style={styles.sub}>Scanning's busy right now (or it couldn't read the photo). Try again in a moment, or enter the receipt details by hand — the photo you took is still saved either way.</p>
          <button style={styles.primary} onClick={() => setPhase("capture")}>↻ Try again</button>
          <button style={styles.scanBtn} onClick={startManual}>Enter details manually</button>
        </div>
      )}

      {(phase === "review" || phase === "saving") && (
        <>
          <div style={{ marginBottom: 8 }}>
            <div style={styles.muted}>Supplier</div>
            <input style={styles.input} value={supplier} onChange={(e) => setSupplier(e.target.value)} />
          </div>
          <p style={styles.sub}>{lines.length > 0
            ? <>Confirm each line. <b>Matched</b> items can be logged to the job (tick "log"); un-matched lines stay on the receipt only. Remove anything wrong with ×.</>
            : <>Enter the supplier and total below. (No line items — that's fine; the receipt's saved as a supplier purchase.)</>}</p>

          {lines.map((ln, i) => (
            <div key={i} style={styles.rcptLine}>
              <input style={styles.rcptDesc} value={ln.description} onChange={(e) => setLine(i, { description: e.target.value })} />
              <div style={styles.rcptRow2}>
                <span style={styles.muted}>qty</span>
                <input type="text" inputMode="numeric" style={styles.rcptNum} value={ln.quantity} onChange={(e) => setLine(i, { quantity: e.target.value })} />
                <span style={styles.muted}>$</span>
                <input type="text" inputMode="decimal" style={styles.rcptNum} value={ln.unit_cost} onChange={(e) => setLine(i, { unit_cost: e.target.value })} />
                {ln.match ? (
                  <label style={styles.rcptMatch}>
                    <input type="checkbox" checked={ln.log} onChange={(e) => setLine(i, { log: e.target.checked })} /> log: {ln.match.name}
                  </label>
                ) : (
                  <span style={styles.rcptFree}>not in catalog</span>
                )}
                <button style={styles.rcptDel} onClick={() => removeLine(i)} aria-label="remove line">×</button>
              </div>
            </div>
          ))}

          <div style={styles.taxBox}>
            <div style={styles.taxRow}>
              <span style={styles.muted}>Subtotal</span>
              <input type="text" inputMode="decimal" style={styles.taxInput} value={subtotal} onChange={(e) => onSubtotal(e.target.value)} />
            </div>
            <div style={styles.taxRow}>
              <span style={styles.muted}>Tax (12% PST+GST)</span>
              <span style={styles.taxVal}>{fmt(tax)}</span>
            </div>
            <div style={{ ...styles.taxRow, borderTop: "1px solid #ddd", paddingTop: 8, marginTop: 4 }}>
              <span style={{ fontWeight: 700 }}>Total</span>
              <input type="text" inputMode="decimal" style={{ ...styles.taxInput, fontWeight: 700 }} value={total} onChange={(e) => setTotal(e.target.value)} />
            </div>
          </div>

          <button style={styles.primary} disabled={phase === "saving"} onClick={save}>
            {phase === "saving" ? "Saving…" : "Save purchase"}
          </button>
          <button style={styles.scanBtn} onClick={() => setPhase("capture")}>↺ retake photo</button>
        </>
      )}
    </div>
  );
}

// ---- From-shop restock: pull stock from the shop to the tech's van -------
function FromShopRestock({ tech, onBack }) {
  const [q, setQ] = useState("");
  const [results, setResults] = useState([]);
  const [cart, setCart] = useState([]);          // [{ material_id, name, qty }]
  const [categories, setCategories] = useState([]);
  const [openCat, setOpenCat] = useState(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(null);        // per-item results after submit
  const timer = useRef(null);

  useEffect(() => {
    clearTimeout(timer.current);
    if (q.trim().length < 2) { setResults([]); return; }
    timer.current = setTimeout(() => searchMaterials(q).then(setResults).catch(() => setResults([])), 180);
    return () => clearTimeout(timer.current);
  }, [q]);
  useEffect(() => { getByCategory().then((r) => setCategories(r.categories || [])).catch(() => {}); }, []);

  function addToCart(m) {
    setCart((c) => {
      const ex = c.find((x) => x.material_id === m.id);
      if (ex) return c.map((x) => (x.material_id === m.id ? { ...x, qty: x.qty + 1 } : x));
      return [...c, { material_id: m.id, name: m.name, qty: 1 }];
    });
    setQ(""); setResults([]);
  }
  const setQty = (mid, qty) => setCart((c) => c.map((x) => (x.material_id === mid ? { ...x, qty: Math.max(1, qty) } : x)));
  const removeItem = (mid) => setCart((c) => c.filter((x) => x.material_id !== mid));

  async function submit() {
    if (!cart.length) return;
    setBusy(true);
    try {
      const r = await restockFromShop(tech.st_tech_id, cart.map((x) => ({ material_id: x.material_id, quantity: x.qty })));
      const names = Object.fromEntries(cart.map((x) => [x.material_id, x.name]));
      setDone((r.results || []).map((x) => ({ ...x, name: names[x.material_id] || ("#" + x.material_id) })));
      setCart([]);
    } catch (e) {
      alert("Couldn't restock: " + (e.message || e));
    } finally { setBusy(false); }
  }

  if (done) {
    return (
      <div style={styles.screen}>
        <div style={styles.topbar}>
          <button style={styles.linkBtn} onClick={onBack}>← home</button>
          <span style={styles.who}>📦 Restocked from shop</span>
        </div>
        <h1 style={styles.h1}>Pulled to your van</h1>
        {done.map((x) =>
          x.result === "pulled_shop" && x.shop_shortfall ? (
            <div key={x.material_id} style={styles.fsWarn}>⚠ {x.quantity} × {x.name} — pulled, but the shop went short {x.shop_shortfall}. Flagged for the office.</div>
          ) : x.result === "pulled_shop" ? (
            <div key={x.material_id} style={styles.fsOk}>✓ {x.quantity} × {x.name} → your van</div>
          ) : x.result === "shop_untracked" ? (
            <div key={x.material_id} style={styles.fsBad}>✗ {x.name} — the shop doesn't track this item; nothing moved.</div>
          ) : (
            <div key={x.material_id} style={styles.fsBad}>✗ {x.name} — couldn't pull ({x.error || x.result}).</div>
          )
        )}
        <button style={{ ...styles.primary, marginTop: 14 }} onClick={onBack}>Done</button>
      </div>
    );
  }

  const totalQty = cart.reduce((a, x) => a + x.qty, 0);
  return (
    <div style={styles.screen}>
      <div style={styles.topbar}>
        <button style={styles.linkBtn} onClick={onBack}>← cancel</button>
        <span style={styles.who}>📦 Restocked from shop</span>
      </div>
      <h1 style={styles.h1}>Restock from shop</h1>
      <p style={styles.sub}>Pick what you grabbed from the shop. This moves stock <b>shop → your van</b> — no job, no purchase.</p>

      <input style={styles.input} placeholder="Search the catalog…" value={q} onChange={(e) => setQ(e.target.value)} />
      {results.map((m) => (
        <button key={m.id} style={{ ...styles.resultRow, cursor: "pointer", width: "100%" }} onClick={() => addToCart(m)}>
          <span>{m.name}</span><span style={styles.muted}>add +</span>
        </button>
      ))}

      {q.trim().length < 2 && (
        <div style={{ marginTop: 8 }}>
          {categories.map((cat) => (
            <div key={cat.name}>
              <button style={styles.catRow} onClick={() => setOpenCat((o) => (o === cat.name ? null : cat.name))}>
                {cat.name} <span style={styles.muted}>({cat.count}) {openCat === cat.name ? "▾" : "▸"}</span>
              </button>
              {openCat === cat.name && cat.items.map((m) => (
                <button key={m.id} style={{ ...styles.resultRow, cursor: "pointer", width: "100%" }} onClick={() => addToCart(m)}>
                  <span>{m.name}</span><span style={styles.muted}>add +</span>
                </button>
              ))}
            </div>
          ))}
        </div>
      )}

      {cart.length > 0 && (
        <div style={styles.fsCart}>
          <div style={styles.sectionLabel}>Grabbed · {cart.length} item{cart.length === 1 ? "" : "s"}</div>
          {cart.map((x) => (
            <div key={x.material_id} style={styles.fsCartRow}>
              <span style={styles.fsCartName}>{x.name}</span>
              <button style={styles.qtyBtn} onClick={() => setQty(x.material_id, x.qty - 1)}>−</button>
              <span style={styles.fsQty}>{x.qty}</span>
              <button style={styles.qtyBtn} onClick={() => setQty(x.material_id, x.qty + 1)}>+</button>
              <button style={styles.linkBtn} onClick={() => removeItem(x.material_id)}>×</button>
            </div>
          ))}
          <button style={{ ...styles.primary, marginTop: 10 }} disabled={busy} onClick={submit}>{busy ? "Moving…" : `Move ${totalQty} to my van`}</button>
        </div>
      )}
    </div>
  );
}

const card = { background: C.surface, borderRadius: 16, boxShadow: SHADOW.e1, border: "none" };
const ctl = { border: `1px solid ${C.hair}`, borderRadius: 12, background: C.surface, boxSizing: "border-box", color: C.ink };
const styles = {
  screen: { maxWidth: 480, margin: "0 auto", padding: 16, fontFamily: FONT, color: C.ink },
  h1: { fontFamily: DISP, fontSize: 27, fontWeight: 800, letterSpacing: "-.035em", margin: "8px 0 6px", color: C.ink },
  sub: { fontSize: 14, color: C.ink3, margin: "0 0 12px" },
  muted: { fontSize: 13.5, color: C.ink3 },
  error: { fontSize: 14, color: C.redInk, padding: "10px 12px", background: C.redWash, borderRadius: 12, margin: "8px 0" },
  failBox: { textAlign: "center", padding: "18px 8px" },
  failTitle: { fontFamily: DISP, fontSize: 19, fontWeight: 700, color: C.redInk, marginBottom: 8 },
  topbar: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 },
  who: { fontSize: 14, fontWeight: 600, color: C.ink2 },
  linkBtn: { background: "none", border: "none", color: C.blue, fontSize: 14, padding: 6, cursor: "pointer", fontWeight: 600 },
  bigRow: { ...card, display: "block", width: "100%", textAlign: "left", padding: "18px", fontFamily: DISP, fontSize: 18, fontWeight: 700, letterSpacing: "-.02em", color: C.ink, marginBottom: 10, borderRadius: 16, cursor: "pointer" },
  jobRow: { ...card, display: "block", width: "100%", textAlign: "left", padding: "15px 16px", marginBottom: 11, borderRadius: 18, cursor: "pointer" },
  jobRowTop: { display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 },
  jobCust: { fontFamily: DISP, fontWeight: 700, fontSize: 17, letterSpacing: "-.02em", flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: C.ink },
  badge: { fontSize: 12, fontWeight: 600, padding: "4px 10px", borderRadius: 999, whiteSpace: "nowrap", flex: "none" },
  sectionLabel: { fontSize: 11, fontWeight: 700, color: C.ink3, textTransform: "uppercase", letterSpacing: "0.08em", margin: "20px 4px 9px" },
  jobRowRecent: { ...card, display: "block", width: "100%", textAlign: "left", padding: "13px 15px", marginBottom: 9, borderRadius: 15, cursor: "pointer", opacity: 0.75 },
  recentSection: { marginTop: 24, paddingTop: 8, borderTop: `1px solid ${C.hair}` },
  recentHint: { fontSize: 12, color: C.amberInk, marginTop: 4 },
  // on-site hero — the one job you're on, readable across a cab
  heroCard: { display: "block", width: "100%", textAlign: "left", border: "none", cursor: "pointer", borderRadius: 22, padding: 18, marginBottom: 12, color: "#fff", background: "linear-gradient(155deg,#212430 0%,#14151A 62%)", boxShadow: SHADOW.e2 },
  heroTop: { display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 },
  heroCust: { fontFamily: DISP, fontWeight: 700, fontSize: 21, letterSpacing: "-.02em", color: "#fff", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  heroChip: { display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12, fontWeight: 600, padding: "5px 11px", borderRadius: 999, background: "rgba(255,255,255,.12)", color: "#7BE6A8", flex: "none" },
  heroDot: { width: 7, height: 7, borderRadius: 999, background: "#34C759", display: "inline-block", flex: "none" },
  heroMeta: { color: "#AEB1BB", fontSize: 13.5, marginTop: 6 },
  heroAction: { marginTop: 15, height: 50, borderRadius: 14, background: "#fff", color: C.ink, fontWeight: 700, fontSize: 15.5, display: "flex", alignItems: "center", justifyContent: "center", gap: 8 },
  // action rows (off-cycle / from-shop)
  actRow: { ...card, display: "flex", alignItems: "center", gap: 13, width: "100%", textAlign: "left", cursor: "pointer", marginTop: 11, padding: "15px 16px", borderRadius: 16 },
  actIco: { width: 42, height: 42, borderRadius: 12, flex: "none", display: "grid", placeItems: "center" },
  actText: { display: "flex", flexDirection: "column", minWidth: 0 },
  actTitle: { fontWeight: 700, fontSize: 14.5, color: C.ink },
  actDesc: { fontSize: 12, color: C.ink3, marginTop: 1 },
  manualToggle: { background: "none", border: "none", color: C.blue, fontSize: 14, padding: "12px 0", marginTop: 6, cursor: "pointer", textAlign: "left", display: "block", fontWeight: 600 },
  overheadNote: { fontSize: 13, color: C.amberInk, background: C.amberWash, borderRadius: 12, padding: "10px 12px", margin: "0 0 12px" },
  input: { ...ctl, width: "100%", height: 52, fontSize: 16, padding: "0 14px", marginBottom: 10 },
  primary: { width: "100%", height: 52, fontSize: 16, fontWeight: 700, background: C.ink, color: "#fff", border: "none", borderRadius: 14, cursor: "pointer" },
  scanBtn: { ...card, display: "block", width: "100%", boxSizing: "border-box", height: 50, fontSize: 15, fontWeight: 600, color: C.ink, border: `1px solid ${C.hair}`, borderRadius: 14, cursor: "pointer", marginBottom: 12, textAlign: "center" },
  rcptLine: { ...card, borderRadius: 14, padding: "10px 12px", marginBottom: 8 },
  rcptDesc: { ...ctl, width: "100%", height: 40, fontSize: 15, padding: "0 10px", marginBottom: 6 },
  rcptRow2: { display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" },
  rcptNum: { ...ctl, width: 58, height: 36, fontSize: 14, textAlign: "right", padding: "0 8px", borderRadius: 10 },
  rcptMatch: { fontSize: 13, color: C.greenInk, display: "flex", alignItems: "center", gap: 4, flex: 1, minWidth: 60 },
  rcptFree: { fontSize: 13, color: C.ink3, fontStyle: "italic", flex: 1 },
  rcptDel: { width: 34, height: 34, flex: "none", marginLeft: "auto", fontSize: 18, lineHeight: "34px", border: "none", borderRadius: 9, background: C.redWash, color: C.redInk, cursor: "pointer", padding: 0 },
  resultRow: { ...card, display: "flex", alignItems: "center", justifyContent: "space-between", padding: "12px 14px", marginBottom: 8, borderRadius: 14 },
  catRow: { ...card, display: "block", width: "100%", textAlign: "left", padding: "14px", marginBottom: 8, borderRadius: 14, fontSize: 15, fontWeight: 500, color: C.ink, cursor: "pointer" },
  fsCart: { ...card, marginTop: 16, padding: "14px", borderRadius: 16 },
  fsCartRow: { display: "flex", alignItems: "center", gap: 8, padding: "8px 0", borderBottom: `1px solid ${C.hair}` },
  fsCartName: { flex: 1, fontSize: 15, color: C.ink },
  qtyBtn: { width: 40, height: 40, fontSize: 20, fontWeight: 600, border: `1px solid ${C.hair}`, borderRadius: 11, background: C.surface, color: C.ink, cursor: "pointer" },
  fsQty: { minWidth: 30, textAlign: "center", fontSize: 16, fontWeight: 700, color: C.ink },
  fsOk: { fontSize: 15, color: C.greenInk, padding: "10px 12px", background: C.greenWash, borderRadius: 10, marginBottom: 6 },
  fsWarn: { fontSize: 14, color: C.amberInk, padding: "10px 12px", background: C.amberWash, borderRadius: 10, marginBottom: 6 },
  fsBad: { fontSize: 14, color: C.redInk, padding: "10px 12px", background: C.redWash, borderRadius: 10, marginBottom: 6 },
  addBtn: { width: 48, height: 48, flex: "none", marginLeft: 8, fontSize: 26, lineHeight: "48px", border: "none", borderRadius: 13, background: C.blue, color: "#fff", cursor: "pointer" },
  browseSection: { marginTop: 10 },
  browseLabel: { fontSize: 11, fontWeight: 700, color: C.ink3, textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 8 },
  catBlock: { marginBottom: 6 },
  catHeader: { ...card, display: "flex", justifyContent: "space-between", alignItems: "center", width: "100%", padding: "14px", borderRadius: 14, cursor: "pointer", fontSize: 15, fontWeight: 600, color: C.ink, boxSizing: "border-box" },
  catItemRow: { display: "flex", alignItems: "center", justifyContent: "space-between", padding: "10px 10px 10px 18px", marginLeft: 8, borderLeft: `2px solid ${C.hair}` },
  reqSection: { marginTop: 14 },
  reqEntry: { width: "100%", padding: "14px", border: `1.5px dashed ${C.hair}`, borderRadius: 14, background: C.surface, cursor: "pointer", fontSize: 15, fontWeight: 600, color: C.blue, boxSizing: "border-box" },
  reqForm: { ...card, borderRadius: 16, padding: 14 },
  reqRow: { display: "flex", alignItems: "center", gap: 8, marginBottom: 10 },
  reqQtyInput: { ...ctl, width: 70, height: 48, fontSize: 16, textAlign: "center", borderRadius: 12 },
  delBtn: { width: 48, height: 48, flex: "none", marginLeft: 8, fontSize: 24, lineHeight: "48px", border: "none", borderRadius: 13, background: C.redWash, color: C.redInk, cursor: "pointer" },
  taxBox: { ...card, borderRadius: 14, padding: "10px 12px", margin: "10px 0" },
  taxRow: { display: "flex", justifyContent: "space-between", alignItems: "center", padding: "3px 0" },
  taxInput: { ...ctl, width: 96, height: 38, fontSize: 15, textAlign: "right", padding: "0 8px", borderRadius: 10 },
  taxVal: { fontSize: 15, color: C.ink },
  receiptsSection: { marginTop: 16 },
  receiptsLabel: { fontSize: 11, fontWeight: 700, color: C.amberInk, textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 8 },
  receiptCard: { ...card, borderLeft: `4px solid ${C.amber}`, marginBottom: 8 },
  receiptHead: { display: "flex", alignItems: "center", padding: "10px 12px", gap: 6 },
  receiptToggle: { flex: 1, minWidth: 0, display: "flex", flexDirection: "column", alignItems: "flex-start", gap: 2, background: "none", border: "none", textAlign: "left", cursor: "pointer", padding: 0 },
  receiptBody: { padding: "0 12px 12px", display: "flex", flexDirection: "column", gap: 5 },
  thumb: { marginTop: 6, width: 120, height: 120, objectFit: "cover", borderRadius: 12, border: `1px solid ${C.hair}`, cursor: "pointer" },
  editBtnSm: { flex: "none", height: 34, fontSize: 13, fontWeight: 600, padding: "0 12px", border: `1px solid ${C.hair}`, borderRadius: 9, background: C.surface, color: C.ink, cursor: "pointer" },
  delBtnSm: { width: 34, height: 34, flex: "none", fontSize: 18, lineHeight: "34px", border: "none", borderRadius: 9, background: C.redWash, color: C.redInk, cursor: "pointer", padding: 0 },
  qtyInput: { ...ctl, width: 54, height: 48, flex: "none", marginLeft: 8, fontSize: 16, textAlign: "center", padding: "0 4px", borderRadius: 12 },
  totalBar: { display: "flex", justifyContent: "space-between", alignItems: "baseline", borderTop: `1px solid ${C.hair}`, paddingTop: 12, marginTop: 12, marginBottom: 8 },
  inclPending: { color: C.amberInk, fontStyle: "italic" },
  loggedRow: { display: "flex", alignItems: "center", padding: "10px 0", borderBottom: `1px solid ${C.hair}` },
  pendingRow: { display: "flex", alignItems: "center", padding: "10px 0", borderBottom: `1px dashed ${C.hair}`, opacity: 0.55 },
  syncBanner: { display: "block", width: "100%", textAlign: "left", font: "inherit", fontSize: 13, fontWeight: 600, color: C.amberInk, background: C.amberWash, borderRadius: 12, padding: "11px 12px", marginBottom: 10, cursor: "pointer", border: "none" },
  note: { fontSize: 13, fontWeight: 500, color: C.blueInk, background: C.blueWash, borderRadius: 12, padding: "10px 12px", marginBottom: 10 },
  ellip: { fontSize: 15, fontWeight: 500, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", color: C.ink },
};
