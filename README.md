# Truck Stock — material capture (critical path to GP)

Standalone Cloudflare Worker + Pages app. Shares `ad-attribution-db` with
AdTrack, the CRM tables, and GP-tracker. It does NOT define new tables — the
inventory tables already exist (built earlier in the CRM project). This app
reads `crm_materials` (catalog, has cost) and writes `crm_job_materials`
(per-job usage), which is exactly what GP-tracker's truck-stock path reads.

## Why this is small
The hard part (19 inventory tables, 2 populated cost catalogs) is already built.
The ONLY missing piece is capture — getting a row into `crm_job_materials` when a
tech uses a material. That's the entire critical path to real gross profit:

  search catalog  →  pick item + qty  →  save to crm_job_materials (cost frozen)

Stock deduction, restock lists, warehouse pull lists, and POs come AFTER this
works. None of them block GP.

## Endpoints (this build)
- `GET  /api/techs` — tech roster for the name picker (reads crm_techs) — VERIFY columns
- `GET  /api/techs/jobs?st_tech_id=` — today's jobs for a tech (ST-fed; PLACEHOLDER returns empty → app falls back to manual job-id entry)
- `GET  /api/materials/search?q=elbow` — search-as-you-type over crm_materials
- `POST /api/jobs/:jobId/materials` — log used material (freezes catalog cost)
- `GET  /api/jobs/:jobId/materials` — list a job's logged materials + total

## VERIFY before deploy — crm_techs columns
The /api/techs endpoint assumes crm_techs has `id`, `name`, `st_tech_id`, and
`is_active`. Confirm with:

```
npx wrangler d1 execute ad-attribution-db --remote --command \
 "SELECT name FROM pragma_table_info('crm_techs');"
```

Fix the column names in `src/index.js` (the /api/techs query) to match. If the
ServiceTitan tech id lives under a different column name, update both that query
and the front-end's use of `st_tech_id`.

## The tech mobile app (web/)
A Vite + React mobile web app. Techs open it in a phone browser and "Add to Home
Screen" — works identically on iPhone, iPad, Android, no app store needed.

Flow: pick your name once (remembered on the device) → today's jobs (or manual
ST job-number entry) → search materials → tap + to log. Each logged material
POSTs to crm_job_materials with cost frozen, tied to the numeric job id and the
tech's ST id.

```bash
cd web
npm install
echo 'VITE_API=https://truck-stock-worker.tiny-truth-e86a.workers.dev' > .env
npm run dev        # local preview at localhost:5173
npm run build      # production build -> dist/
npx wrangler pages deploy dist --project-name=truck-stock --commit-dirty=true
```

### Why manual job entry is the safe default
The "today's jobs" ServiceTitan pull is the one genuinely new/uncertain piece
(needs ST appointment query tuned to your data). Until it's wired, the app falls
back to entering the numeric ST job number by hand — fully usable today, and the
numeric-only validation prevents the silent GP-miss bug (non-numeric job ids
never match GP-tracker's join).


## Schema — confirmed
This worker is written against the verified real schema:
- `crm_materials` (26 cols): search uses `name`, `code`, `emco_sku`, and the
  dedicated `search_terms` field; filtered to `is_active = 1`. Cost = `cost`.
- `crm_job_materials` (12 cols): insert writes `job_id, job_number, material_id,
  quantity, unit_cost, total_cost, tech_id, truck_location_id, notes, is_prepull`.

`is_prepull` distinguishes materials pulled for a job vs actually consumed — the
capture screen can expose this later. No column edits needed.

## Setup
```bash
cd worker
npm init -y
npm install wrangler --save-dev
npx wrangler deploy
```
(No schema to load — tables already exist. No ST secrets needed — this app
doesn't call ServiceTitan; it only reads/writes D1.)

## Prove the critical path
1. Search: `GET /api/materials/search?q=copper` → should return real catalog rows.
2. Log one: `POST /api/jobs/TESTJOB1/materials` with `{"material_id": <real id>, "quantity": 2}`.
3. Read back: `GET /api/jobs/TESTJOB1/materials` → shows the line + total cost.
4. Flip GP-tracker's `wrangler.toml` to `MATERIAL_COST_SOURCE = "truckstock"`,
   redeploy it, and that test job's material cost now flows into the GP report.

That last step is the whole point: the moment real capture data exists, GP goes
live with no further code changes.

## Next, after capture is proven (not in this build)
- Stock deduction from `crm_inventory_stock` on save
- Per-tech van quick-pick (stocked items first)
- Restock list when a van item falls below minimum
- Warehouse pull list + purchase orders (tables already exist: crm_inventory_*)
- The tech-facing mobile capture UI (web/ — search-as-you-type screen)
