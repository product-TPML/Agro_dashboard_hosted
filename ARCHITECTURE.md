# Architecture — Agro Dashboard (Table Version)

## Purpose

A bilingual (English/Kannada) dashboard for browsing Karnataka APMC agricultural commodity prices. Users search by commodity, market, or variety and see latest prices, price history charts, and district-level map navigation.

---

## High-Level Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│                         DATA PIPELINE                            │
│                                                                  │
│  Agro Dashboard - new data.xlsx                                  │
│         │                                                        │
│         ▼                                                        │
│  scripts/build_static_db.js                                      │
│         │                                                        │
│         ▼                                                        │
│  data/agro_dashboard.db  (SQLite)                                │
│         │                                                        │
│         ├─────────────────────────────────────────────────┐       │
│         ▼                                                 ▼       │
│  local-dashboard/server.js                    scripts/build_     │
│  (Node HTTP server on :3180)                  pages_site.js       │
│         │                                                 │       │
│         ▼                                                 ▼       │
│  local-dashboard/public/ ← JSON API             docs/             │
│  Browser SPA fetches data                     (GitHub Pages)     │
│  from /api/* endpoints                        Pre-built static   │
│                                               JSON + HTML/CSS    │
└──────────────────────────────────────────────────────────────────┘
```

The project has **two active deployment modes** sharing the same data source:

1. **Local dev server** — Node HTTP server, JSON API, live SQLite reads
2. **Static export** — pre-built JSON files in `docs/` for GitHub Pages (no server needed)

And one **legacy pipeline** (scrape → Google Sheets → Apps Script dashboard) kept for reference only.

---

## Data Flow

### Active: Workbook → SQLite → Dashboard

```
┌──────────────┐     ┌──────────────────┐     ┌──────────────────────┐
│  Excel       │────▶│  build_static_db │────▶│  agro_dashboard.db   │
│  Workbook    │     │  (sheet→SQLite)  │     │  SQLite (read-only)  │
│  3 sheets    │     │  + validates     │     │  11 tables + 2 views │
│  (prices,    │     │  + geography     │     │  ~20K price rows     │
│   mapping,   │     │  + dim tables    │     │  133 commodities     │
│   runs)      │     └──────────────────┘     │  163 markets         │
└──────────────┘                              └──────────┬───────────┘
                                                         │
                                              ┌──────────┴───────────┐
                                              │                      │
                                  ┌───────────▼──────┐    ┌─────────▼─────────┐
                                  │  server.js       │    │ build_pages_site  │
                                  │  Node HTTP API   │    │ (SQLite→JSON)     │
                                  │  :3180           │    │                   │
                                  └───────────┬──────┘    └─────────┬─────────┘
                                              │                      │
                                  ┌───────────▼──────┐    ┌─────────▼─────────┐
                                  │  public/         │    │ docs/             │
                                  │  app.js SPA      │    │ static HTML/CSS/  │
                                  │  fetches /api/*  │    │ JS + data/*.json  │
                                  └──────────────────┘    └───────────────────┘
```

**Build commands:**

| Step | Command | What it does |
|------|---------|-------------|
| 1 | `npm run build:static-db` | Reads Excel → creates/overwrites `data/agro_dashboard.db` |
| 2 | `npm run build:pages` | Reads DB → writes `public/data/*.json` + mirrors into `docs/` |
| 3 | `npm run dashboard:local` | Starts Node HTTP server on port 3180 |

### Legacy: KRAMA Scrape → Google Sheets → Apps Script (reference only)

```
krama.karnataka.gov.in  (ASP.NET WebForms)
         │
         ▼
  scrape_krama.js
  - Direct HTTP POST (fallback, often fails due to ViewState)
  - Playwright browser automation (primary)
         │
         ▼
  Google Sheets API v4
  (prices sheet + runs sheet)
         │
         ▼
  appscript/Code.gs
  (Google Apps Script dashboard)

  ── Kept only as reference, not active ──
```

---

## Component Breakdown

### 1. Database Layer — `data/agro_dashboard.db`

**Schema** (normalized, 11 tables + 2 views):

```
commodities ─────────────────┐
commodity_mapping ───────────┤
markets ─────────┐           │
districts ──────┐│           │
market_district ─┤│──────────┤
varieties ──────┤│           │
grades ─────────┤├──────────┤
units ──────────┤│          │
                 ▼▼          ▼
           price_observations
           (20,041 rows, May 2026)
                 │
                 ▼
           price_observations_flat  (VIEW — denormalized)
                 │
                 ▼
           latest_price_observations  (VIEW — latest per combo)
```

Two read views exist for the dashboard:
- `price_observations_flat` — all rows with commodity/market/district/variety/grade names joined in
- `latest_price_observations` — latest row per `commodity + market + variety + grade`

### 2. Server Layer — `local-dashboard/server.js`

Built with Node.js `http` module (zero framework dependencies). `better-sqlite3` for fast synchronous SQLite reads.

**API endpoints:**

| Endpoint | Purpose |
|----------|---------|
| `GET /api/search?q=...` | Prioritized search results (commodity > market > variety) |
| `GET /api/search-index` | Raw catalog for client-side bilingual search matching |
| `GET /api/context?type=...` | Table rows for a locked context (commodity/market/variety) |
| `GET /api/map` | District → market mapping for home-screen map |
| `GET /api/health` | Server + DB health check |
| `GET /*` | Static file serving from `public/` |

Search uses prefix-first `indexOf` matching with sort priority: match position → string length → alphabetical.

### 3. Frontend SPA — `local-dashboard/public/app.js`

Single-file vanilla JS SPA (~3300 lines). No framework.

**Key subsystems:**

| Subsystem | Lines | Responsibility |
|-----------|-------|---------------|
| `boot()` | Entry | Load translations, search index, map SVG, map data, observations |
| Routing | `parseRoute()` / `buildRouteUrl()` | URL-based routing (`?view=table&type=commodity&commodity=Tomato`) |
| Search | `search()` / `buildLocalizedSearchResults()` | Client-side bilingual (en/kn) search with debounced input |
| Table | `getRowsForCurrentView()` | Filter base rows → deduplicate to latest per group → sort |
| History | `getHistoryRows()` | Fetch time-windowed history (7d perishable / 30d non-perishable) |
| Render | `render()` | Full SPA re-render: home, table, sticky header, filter modal |
| Chart | `renderChart()` | SVG line chart (min/max/modal) with hover tooltip + date selector |
| Filters | `renderFilterModal()` | Staged cascading multi-select filter popup with search + chips |
| Map | `wireMapInteractions()` / `bindMapGestures()` | SVG district map: pan, pinch-zoom, district click, market pins |
| Locale | `translateEntity()` / `getStoredLocale()` | English/Kannada toggle persisted in localStorage |

**State machine** — a single `state` object drives all rendering:

```
state = {
  route, query, suggestions,          // Navigation
  context, allRows, baseRows,         // Data
  filters, filterDrafts,              // Filter state (staged)
  isFilterModalOpen, showFilterHint,  // UI state
  expandedRowKey, activeChartDate,    // History chart
  locale, translations,               // Bilingual
  searchIndex,                        // Local search catalog
  mapSvgMarkup, mapDistricts,         // Map
  cachedVisibleRows,                  // Render cache
}
```

### 4. Build Scripts — `scripts/`

| Script | Purpose |
|--------|---------|
| `build_static_db.js` | Reads `Agro Dashboard - new data.xlsx`, seeds SQLite DB with schema + validation |
| `build_pages_site.js` | Reads SQLite DB, writes 4 JSON files (`observations.json`, `search-index.json`, `map-data.json`, `metadata.json`) → `public/data/` + mirrors `public/` → `docs/` |
| `karnataka_market_district_mapping.json` | 31 districts, 163 market→district assignments (static geography) |

### 5. Static Site — `docs/`

GitHub Pages output: mirrors `local-dashboard/public/` with pre-built data files so no server is needed.

```
docs/
├── index.html           (entry)
├── app.js               (same SPA but reads localStorage data instead of /api/*)
├── styles.css
├── karnataka-geo.svg    (district outline map)
├── translations.json    (bilingual labels)
├── .nojekyll
└── data/
    ├── observations.json    (all 20K price rows)
    ├── search-index.json    (commodity/market/variety catalog)
    ├── map-data.json        (district → markets)
    └── metadata.json        (row counts, generated timestamp)
```

The static version differs architecturally from the server version:
- Server mode: app.js fetches from `/api/*` endpoints at runtime
- Static mode: app.js loads `data/*.json` files from localStorage on boot — all data is pre-bundled

### 6. GitHub Actions — `.github/workflows/`

| Workflow | Trigger | What it does |
|----------|---------|-------------|
| `scrape.yml` | Scheduled / manual | Runs `scrape_krama.js` to fetch KRAMA data |
| `deploy-pages.yml` | Push to main | Deploys `docs/` to GitHub Pages |

---

## UI/UX Architecture

### Screens

```
┌─────────────┐     ┌─────────────────┐     ┌─────────────────┐
│  Home       │────▶│  Search Results  │────▶│  Row Expansion  │
│  + search   │     │  (filterable     │     │  (inline chart)  │
│  + map      │     │   results table) │     │                  │
│  + toggle   │     │  + filter modal  │     │  (history panel) │
│    locale   │     │  + price deltas  │     │                  │
└─────────────┘     └─────────────────┘     └─────────────────┘
       │
       ▼
┌─────────────┐
│  Market     │
│  Pin Click  │  (routes to market table)
└─────────────┘
```

### Search-first navigation

Primary navigation is search. District map is secondary (discovery). Search results prioritized: commodity → market → variety. Each search type locks different context and exposes different filter columns in the results table.

### Results table

- Latest row only per `commodity + market + variety + grade`
- Sorted by market name
- Context-aware identity columns (first column changes based on what was searched)
- Price deltas shown as green/red indicators below each price
- Row click → inline SVG chart with 7/30 day history window

---

## Technology Stack

| Layer | Technology | Version |
|-------|-----------|---------|
| Database | SQLite via `better-sqlite3` | ^12.10.0 |
| Excel parsing | `xlsx` (SheetJS) | ^0.18.5 |
| Browser automation (legacy) | Playwright | ^1.60.0 |
| PDF parsing (legacy) | `pdf-parse` | ^2.4.5 |
| Server | Node.js `http` module (zero deps) | built-in |
| Frontend | Vanilla JS, CSS custom properties | — |
| Map | Inline SVG with pointer/touch gestures | — |
| Translations | JSON bilingual dict (en/kn) | — |
| Static export | Custom Node.js script | — |
| CI/CD | GitHub Actions | — |
| Desktop EXE (legacy) | `postject` | ^1.0.0-alpha.6 |

Notable: the server has **zero framework dependencies** — no Express, no routing library. Just `http.createServer` and manual URL parsing.

---

## Key Architectural Decisions

| Decision | Why |
|----------|-----|
| SQLite over Google Sheets | Eliminates network dependency, faster reads, simpler local dev |
| Static JSON export for Pages | GitHub Pages doesn't support server-side APIs; all data is pre-bundled |
| Vanilla JS over framework | Zero build step, no transpilation, direct deploy to GitHub Pages |
| Single-file SPA | Simpler than module bundling for a static site without a build tool |
| Normalized DB + denormalized views | Normalized for data integrity, views for dashboard read performance |
| Staged filter state | Filter changes aren't applied until "Apply" — avoids expensive re-renders during multi-select |
| Excel workbook as source of truth | Human-editable, auditable, single rebuild command |

---

## Production Plan: One-Command Data Update via GitHub Pages

### Goal

A non-technical user runs **one command** — everything else is automatic. Scrape, build, and publish updated data to the live dashboard. No git commands, no cloud consoles, no manual file uploads.

### How it works

The dashboard (app + data) is hosted on **GitHub Pages** — already configured. The CMS embeds an `<iframe>` pointing to the Pages URL. When data needs updating, the user runs one command locally, and the script auto-commits and pushes the new data to GitHub. Pages deploys automatically.

**No new accounts. No billing. No cloud setup.** Just GitHub, which is already in use.

### One-Command Flow

```
┌─────────────────────────────────────────────────────────────────────────┐
│                        PRODUCTION FLOW                                   │
│                                                                         │
│  user double-clicks update.bat                                           │
│         │                                                               │
│         ▼                                                               │
│    ┌─────────────────────────────────────────────────────┐              │
│    │  Step 1: scrape_krama.js                            │              │
│    │  (fetches latest prices from KRAMA website)         │              │
│    └──────────────────────┬──────────────────────────────┘              │
│                           ▼                                             │
│    ┌─────────────────────────────────────────────────────┐              │
│    │  Step 2: build_static_db.js                         │              │
│    │  (Excel workbook → SQLite database)                 │              │
│    └──────────────────────┬──────────────────────────────┘              │
│                           ▼                                             │
│    ┌─────────────────────────────────────────────────────┐              │
│    │  Step 3: build_pages_site.js                        │              │
│    │  (SQLite → docs/data/*.json files)                  │              │
│    └──────────────────────┬──────────────────────────────┘              │
│                           ▼                                             │
│    ┌─────────────────────────────────────────────────────┐              │
│    │  Step 4: git add + commit + push                    │              │
│    │  (stages only docs/data/*.json, pushes to main)     │              │
│    └──────────────────────┬──────────────────────────────┘              │
│                           ▼                                             │
│    ┌─────────────────────────────────────────────────────┐              │
│    │  Step 5: GitHub Actions auto-deploys                │              │
│    │  (deploy-pages.yml deploys docs/ to Pages)          │              │
│    └──────────────────────┬──────────────────────────────┘              │
│                           ▼                                             │
│    ┌─────────────────────────────────────────────────────┐              │
│    │  ✅ Done! Wait ~1 min for deploy. Refresh page.     │              │
│    └─────────────────────────────────────────────────────┘              │
│                                                                         │
│  GitHub Pages (dashboard + data)            CMS (WordPress)             │
│  ┌─────────────────────────────────┐       ┌────────────────────┐      │
│  │ index.html, app.js, styles.css │       │ <iframe src="..."  │      │
│  │ map SVG, translations.json     │◄──────│   width="100%"     │      │
│  │ data/*.json (4 files)          │       │   height="800">    │      │
│  └─────────────────────────────────┘       └────────────────────┘      │
│                                                                         │
│  Everything served from one domain — no CORS, no cross-origin issues.  │
└─────────────────────────────────────────────────────────────────────────┘
```

### What the user sees

```
C:\> npm run update-data

[1/4] Scraping KRAMA website...
      ✓ 45 commodity prices fetched

[2/4] Rebuilding database from Excel...
      ✓ 20,041 price rows imported

[3/4] Exporting static files...
      ✓ docs/data/observations.json
      ✓ docs/data/search-index.json
      ✓ docs/data/map-data.json
      ✓ docs/data/metadata.json

[4/4] Publishing to GitHub...
      ✓ Committed data update
      ✓ Pushed to GitHub

✅ Update complete! GitHub Pages will auto-deploy in about 1 minute.
   Refresh the CMS dashboard page after that.
```

### What stays the same

- **`app.js`** — unchanged. It loads `data/observations.json` as a relative URL from the same domain GitHub Pages serves. No URL changes needed.
- **`build_pages_site.js`** — unchanged. It already writes to `docs/data/` which is the Pages deploy directory.
- **`deploy-pages.yml`** — unchanged. Already watches push to main and deploys `docs/`.

### What changes from current code

1. **`scripts/update-data.js`** — **new file** (~30 lines). Orchestrates the steps: run scrape, build DB, build pages, then git commit & push.

2. **`package.json`** — add a script: `"update-data": "node scripts/update-data.js"` and a helper: `"postinstall": "node scripts/check-gh-auth.js"`

3. **`scripts/check-gh-auth.js`** — **new file** (~10 lines). Checks that `gh auth status` works on first install so the user isn't surprised by auth failures later.

4. **`update.bat`** — **new file** (3 lines). Double-click shortcut: `cd /d "%~dp0" && npm run update-data`

5. **CMS** — one-time embed: add `<iframe src="https://<user>.github.io/Agro_dashboard_hosted/" width="100%" height="800">` to a WordPress page.

### One-time setup: GitHub authentication

The script needs to push to GitHub. One-time setup:

```bash
# Option A: GitHub CLI (recommended)
gh auth login
# Follow the browser prompt — done.

# Option B: Git credential manager (already works if you've pushed before)
# Just run: git push
# If it prompts for credentials, enter them once — Windows remembers.
```

The `check-gh-auth.js` script verifies this on `npm install` and tells the user if they need to run `gh auth login`.

### Data frequency vs git history

| Update frequency | Annual commits | Size per commit | Total annual growth |
|-----------------|----------------|-----------------|-------------------|
| Weekly | ~52 | ~4 MB | ~200 MB |
| Monthly | ~12 | ~4 MB | ~48 MB |

For weekly updates: ~200 MB/year added to git history. GitHub recommends repos under 5 GB. This is fine for years. If it ever becomes a concern, switch to a separate `data` branch or orphan the history.

### Alternative paths considered

| Option | Why not chosen |
|--------|---------------|
| Cloudflare R2 | Required billing account (credit card) |
| Separate data repo | More complex, same cost as single repo |
| Surge.sh | Another account to manage, deployment URL changes |
| Workers + D1 | Requires Node server rewrite, cold start latency, complex setup |
