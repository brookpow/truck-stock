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
- `GET  /api/materials/search?q=elbow` — search-as-you-type over crm_materials
- `POST /api/jobs/:jobId/materials` — log used material (freezes catalog cost)
- `GET  /api/jobs/:jobId/materials` — list a job's logged materials + total

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
