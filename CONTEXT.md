# Commodity Dashboard Context

## Purpose

This repo is currently being used to build a **local commodity dashboard** backed by a **local SQLite database**, plus a **desktop-friendly local scraper** that can write directly into that database.

The active goals are:

- use the current May-June 2026 workbook snapshot as the development dataset
- serve a local dashboard without Google Sheets dependencies
- keep the workbook-to-DB rebuild flow for baseline data
- route active scraper output into the local DB instead of Google Sheets by default
- support multiple scraper sources behind one UI entry point
- implement the search-first dashboard flow from the wireframes

This repo is **not** operating as a hosted live sync pipeline right now, but it **does** support local scraper writes into the SQLite DB.

## Current Source of Truth

The current baseline source workbook is:

- `Agro Dashboard - new data.xlsx`

That workbook is converted into the local SQLite database:

- `data/agro_dashboard.db`

The same database is also updated by the local scraper UI/CLI for supported live sources:

- `krama`
- `necc_egg`
- `csb_silk`
- `rubber_board`
- `spices_board`
- `coffee_board`

Rebuild command:

- `npm run build:static-db`

## Current Architecture

Current development shape:

- `Agro Dashboard - new data.xlsx` -> `data/agro_dashboard.db` -> `local-dashboard/server.js` -> browser UI
- `Agro Dashboard - new data.xlsx` -> `data/agro_dashboard.db` -> `scripts/build_pages_site.js` -> `docs/` static site
- `scripts/commodity_category_mapping.json` -> `data/agro_dashboard.db` -> category-aware home UI and API payloads
- `scrape_krama.js` -> `data/agro_dashboard.db` -> dashboard/API/static export reads
- `Launch Commodity Scraper.vbs` -> `scrape_krama.js` -> local DB + local run logs

Current runtime commands:

- `npm run build:static-db`
- `npm run dashboard:local`
- `npm run build:pages`

The local dashboard is served at:

- `http://127.0.0.1:3180`

The static GitHub Pages-style build is generated into:

- `docs/`

## Active Assumptions

The workbook snapshot remains the baseline dataset for rebuilds, but the active local DB is no longer strictly read-only.

That means:

- workbook rebuild still recreates the DB structure from the Excel snapshot
- scraper runs can insert or update rows in `price_observations`
- scraper runs write execution metadata into `scrape_runs`
- local log/json/csv outputs are written into repo-local output folders per run
- no automatic retention pruning currently exists in the DB layer
- no deletes
- no live Google Sheets sync

If the workbook changes, the database can still be rebuilt from scratch. The rebuild script is also designed to preserve compatible existing DB rows when rebuilding over an existing local DB.

## Main Files

- `CONTEXT.md`
  Current project context.

- `Agro Dashboard - new data.xlsx`
  Static workbook snapshot used to seed the DB.

- `data/agro_dashboard.db`
  Active local SQLite database for dashboard development.

- `data/README.md`
  Short notes on schema and rebuild usage.

- `scripts/build_static_db.js`
  Recreates the SQLite database from the workbook and preserves compatible existing DB rows during rebuild.

- `scripts/commodity_category_mapping.json`
  Source file for commodity category metadata used to group commodities into the home-screen category rails.

- `scripts/karnataka_market_district_mapping.json`
  Source file for district metadata and market-to-district geography used by the local DB.

- `local-dashboard/server.js`
  Local Node HTTP server and JSON API for the dashboard.

- `local-dashboard/public/index.html`
  HTML entry point for the local dashboard.

- `local-dashboard/public/styles.css`
  Dashboard styling.

- `local-dashboard/public/app.js`
  Client-side dashboard logic, routing, search, category rails, source-aware custom filter dropdowns, card rendering, inline history, and map interactions.

- `local-dashboard/public/translations.json`
  Unified translation source for UI copy plus commodity, market, and variety labels in English and Kannada, with English fallback when Kannada entries are blank or missing.

- `package.json`
  Contains both `build:static-db` and `dashboard:local`.

- `scrape_krama.js`
  Active local scraper entry point. Supports multiple sources, direct SQLite writes, run logging, and the desktop UI flow.

- `Launch Commodity Scraper.vbs`
  Double-click launcher for the scraper UI so non-terminal users can run scraping locally.

- `scripts/build_krama_exe.ps1`
  Packaging helper that prepares the scraper distribution, including the launcher.

- `appscript/`
  Legacy Google Apps Script dashboard and mapping UI. Kept only as reference.

## Database Model

The SQLite database is normalized for clean reads.

### Core tables

- `commodities`
- `commodity_mapping`
- `districts`
- `markets`
- `market_district_mapping`
- `varieties`
- `grades`
- `units`
- `price_observations`
- `scrape_runs`
- `source_snapshot`

### Read-focused views

- `price_observations_flat`
  Denormalized view for dashboard reads

- `latest_price_observations`
  Latest available row per `source_id + commodity + market + district + variety + grade`

## Imported Dataset Summary

Current workbook-seeded snapshot:

- `price_observations`: 34,503 rows
- `commodity_mapping`: 135 rows
- `districts`: 31 rows
- `market_district_mapping`: 164 rows
- `scrape_runs`: 64 rows
- 137 commodities
- 164 markets
- 251 varieties
- 6 grades
- report dates from `2026-05-02` through `2026-06-19`

## Data Semantics

The workbook includes three logical datasets:

- `prices`
- `commodity_mapping`
- `runs`

They were mapped into SQLite as:

- `prices` -> `price_observations` plus dimension tables
- `commodity_mapping` -> `commodity_mapping`
- `runs` -> `scrape_runs`
- district geography -> `districts` and `market_district_mapping`

Active row-level fields used in the dashboard:

1. `row_key`
2. `report_date`
3. `heading`
4. `commodity`
5. `perishability`
6. `market`
7. `variety`
8. `grade`
9. `arrivals`
10. `unit`
11. `min_price`
12. `max_price`
13. `modal_price`
14. `scraped_at`

Additional active row-level fields now used for multi-source support:

15. `source_id`
16. `canonical_price`
17. `canonical_price_unit`
18. `price_100_pieces`
19. `price_1_piece`
20. `price_1_tray`

The flattened read view now also includes:

1. `district`
2. `district_slug`
3. `category`

### Multi-source DB semantics

The local DB now supports source-aware rows and scraper-run logging.

Current write behavior:

- `row_key` is unique
- scraper writes use upsert behavior on `row_key`
- duplicate incoming rows do not create duplicate records; they update the existing record for that same `row_key`
- `scrape_runs` stores one row per execution attempt, including source/sink metadata and output file paths

Current source ids:

- `krama`
- `necc_egg`
- `legacy` is retained for older imported run records where needed

Current sink ids:

- `sqlite_local`
- `google_sheets` remains as legacy/backward-compatible sink support, but local DB is the default active path

### Commodity metadata

Commodity metadata is now split across two active sources:

- workbook `commodity_mapping`
  provides perishability and update timestamps

- `scripts/commodity_category_mapping.json`
  provides one category for every commodity in the static dataset

Current category values:

- `fruits`
- `vegetables`
- `nuts_and_seeds`
- `grains_and_pulses`
- `miscellaneous`

## Implemented Dashboard Flow

The current dashboard follows the wireframe direction as a **search-first flow**.

### Home screen

The home screen currently includes:

- global search bar
- horizontally scrollable category rail
- horizontally scrollable commodity rail for the selected category
- interactive Karnataka district map

Search remains the primary navigation path. The category browser and district map now act as secondary discovery paths from the same landing screen.

`Egg` is intentionally excluded from the home category rails right now and is reachable through search/results flows instead.

### Home category rail behavior

The home screen now includes a category-first browsing layer below the search bar and above the district map.

Current behavior:

- first category is preselected on load
- category chips scroll horizontally
- the selected category stays in view when changed
- commodity chips for the active category scroll horizontally in a second rail
- commodity count is shown as a fixed label above the commodity rail
- tapping a commodity chip routes directly to the existing commodity results view
- category labels are localized for English and Kannada
- commodity labels in the rail use the existing translation system
- category and commodity chips both include lightweight icons
- commodities with `commodity = Egg` are excluded from the home category rail payload

Current layout details:

- the selected category chip carries the main visual emphasis
- the commodity rail is intentionally lighter and does not repeat the selected category title
- the commodity rail shows a fixed commodity-count label above the scroller
- horizontal scrolling is isolated to the two rails and should not expand page-level width

### Search behavior

The global search supports:

- commodity search
- market search
- variety search

Search result priority:

1. commodity
2. market
3. variety

Search result labeling:

- `Tomato (Commodity)`
- `Mysuru (Market)`
- `Local (Tomato)`

Variety results are always shown in the form:

- `Variety (Commodity)`

### Results page behavior

There is one shared results view with pre-applied context.

Default layout behavior:

- desktop opens results in `table` view by default
- mobile opens results in `cards` view by default
- users can still switch layouts manually after arrival

#### Commodity search

- locked heading: commodity
- filters: only available values from market, variety

#### Market search

- locked heading: market
- filters: only available values from commodity, variety

#### Variety search

- locked headings: commodity and variety
- filter: only available values from market

### Filters

Filters are cascading.

That means:

- only valid combinations are shown
- impossible combinations are not available in dropdowns

The current filter UI on the results page uses a floating filter action button instead of always-visible inline controls.

Clicking that button opens a popup with:

- only the filters relevant to the current table context
- a `Tap to Select` trigger button per filter field that expands a scrollable option list
- multi-select option list — tapping an option toggles it immediately
- the option list stays expanded after each selection and only collapses when the trigger is tapped again
- selected values shown as removable chips above the trigger, hidden when nothing is selected
- no placeholder chips when nothing is selected
- top-of-page overlay positioning instead of a bottom sheet
- background page scroll locked while the popup is open
- explicit `Apply Filters`
- `Clear Filters`

The results page now also shows active selected-filter chips outside the popup, directly below the cards/table toggle.

Filter chip visual style:

- chips inside the popup and outside the popup use the same warm orange-red color scheme
- outside chips include `cursor: pointer` and a hover state to signal interactivity
- the chip color is intentionally distinct from the green-tinted commodity and category chips used elsewhere

Current filter interaction behavior:

- staged option toggles inside the popup still wait for `Apply Filters`
- removing a selected chip inside the popup immediately applies that single removal while keeping the popup open
- removing a selected chip from the outside chip row immediately applies that single removal and refreshes results
- closing the popup without applying discards all staged draft selections

### Geography layer

The local DB now includes a district geography layer used by the home-screen map.

Current structure:

- `districts`
  current Karnataka district list used by the local dashboard

- `market_district_mapping`
  one market-to-district assignment for each market in the static dataset

This mapping now supports:

- district click -> market pins for that district
- market pin click -> route to the market table

Most mappings follow district/taluk geography directly. A small number of market names were normalized or inferred because the workbook uses abbreviated or inconsistent labels, for example:

- `ENDI` -> treated as `Indi` in Vijayapura district
- `YARAHALLI` -> mapped to the APMC yard reference in H. D. Kote taluk, Mysuru district

### Results card behavior

The current results surface shows:

- the latest row only for each exact `commodity + market + variety + grade` combination after applying the selected context and active filters
- results sorted by `market`
- one full-width card per result on both mobile and desktop
- context-aware primary headings inside each card:
  - market search -> commodity is primary
  - commodity search -> market is primary
  - variety search -> market is primary, with variety and grade grouped below
- grouped card sections for:
  - identity
  - prices
  - arrivals / units
  - price updates

Card content currently includes:

- a single top-line anchor value only, with no extra `Market` / `Commodity` label above it
- `Arrivals And Units`
- price labels with rupee units:
  - `Max Price (Rs.)`
  - `Min Price (Rs.)`
  - `Modal Price (Rs.)`
- a single `Price Updates` block with:
  - `Latest`
  - `Previous`

Current card layout details:

- the anchor value on the first line is shown alone as the strongest card heading
- `Variety` and `Grade` sit beneath that heading
- `Arrivals And Units` is rendered as a compact two-column row:
  - field label on the left
  - value right-aligned on the same row
- `Price Updates` shows `Latest` and `Previous` side by side
- the results view header uses `Showing Results For` plus larger locked context chips

For `necc_egg` rows, card rendering is source-aware:

- there is no arrivals/units display when those values are null
- blank variety/grade values are not shown
- the primary displayed market rows currently expected are `Bengaluru` and `Mysuru`
- price labels become:
  - `Price (100 pieces)`
  - `Price (1 piece)`
  - `Price (1 tray)`
- calculated prices are surfaced as float values

The results UI also currently uses:

- tighter mobile padding than the earlier prototype
- only locked context chips at the top of the results view, with no duplicate black heading text
- a top-left `Home` button beside the language toggle area
- desktop-first `table` default with mobile-first `cards` default on first arrival
- a floating filter action button with an onboarding hint animation
- an outside active-filter chip row below the cards/table toggle

For each result card, the price block also shows the absolute change from the previous comparable update for the exact:

- `commodity + market + variety + grade`

Delta behavior:

- increase -> green rising indicator with `+value`
- decrease -> red falling indicator with `-value`
- no change -> `0`
- no earlier comparable row -> `No earlier update`

Both date values use `DD-MM-YYYY`.

### Card expansion

Clicking `See Price History` expands an **inline history panel inside the card** for the exact:

- `source_id + commodity + market + variety + grade`

The history panel shows:

- min price
- max price
- modal price
- fixed visual mapping:
  - max price -> `#1E3A8A` solid line
  - min price -> `#C2410C` solid line
  - modal price -> `#CC9900` dotted line
- point markers for each plotted date
- latest date active by default when the chart opens
- hover/tap selection for any plotted date
- a compact selected-date summary block below the graph
- x-axis dates in `DD-MM`
- selected-date displays in `DD-MM-YYYY`
- horizontal scrolling isolated to the graph area only
- a small note above the graph telling users to scroll horizontally to see all dates

For `necc_egg` rows:

- the chart shows a single canonical line only
- the canonical line reflects the `100 pieces` price
- there is no min/max/modal triple-series rendering for egg rows

Current interaction details:

- the chart no longer eagerly selects points on `touchstart`
- mobile horizontal swipes are now interpreted as scroll first, making dense charts easier to navigate
- chart horizontal scroll position is preserved while the same card stays expanded
- chart horizontal scroll resets only on first expansion or after collapse and reopen
- the selected-point summary below the graph is arranged as:
  - `Max` left aligned
  - `Min` right aligned
  - `Modal` centered on the next row

When multiple series overlap, all three remain visible. The chart draws `max` last so it stays visually strongest without hiding `min` or `modal`.

### Hardcoded history windows

History window is determined by perishability and is not user-selectable:

- perishable -> last 7 days
- non-perishable -> last 30 days

## Current API Surface

The local server currently exposes:

- `/api/health`
- `/api/map`
- `/api/categories`
- `/api/search?q=...`
- `/api/search-index`
- `/api/context?type=commodity&commodity=...`
- `/api/context?type=market&market=...`
- `/api/context?type=variety&commodity=...&variety=...`

### API responsibilities

- `/api/search`
  returns prioritized search results

- `/api/search-index`
  returns the raw commodity, market, and variety catalog used for client-side bilingual search matching

- `/api/categories`
  returns fixed-order category buckets with localized-UI-friendly ids, labels, counts, and commodity lists for the home-screen browsing rails

- `/api/map`
  returns district-level market mapping for the home-screen map

- `/api/context`
  returns table context metadata and all matching rows for the selected search type, including source-aware price fields

- `/api/health`
  simple server + DB health check

## Current UI Status

Implemented and working:

- local server
- static Pages build generated into `docs/`
- home screen
- search suggestion flow
- home-screen category rail
- home-screen commodity rail for the active category
- fixed commodity-count label above the commodity rail
- direct commodity-route navigation from the home category browser
- route into shared results page
- locked context headings
- cascading filters
- top-anchored popup-based custom filter dropdown menus on mobile and desktop
- floating filter action button on the table screen
- top-anchored popup-based multi-select filters with tap-to-expand dropdowns, removable chips, explicit apply, and clear actions
- background scroll lock while the filter popup is open
- outside active-filter chip row below the results layout toggle
- immediate auto-apply when removing a selected filter chip from inside or outside the popup
- latest-row-only results cards
- card price deltas against the previous comparable update
- inline card expansion
- inline price history chart
- selected-point chart summary values
- interactive district map on the home screen
- district click-to-zoom using SVG `viewBox` focus
- manual map panning inside the map container
- touch pinch-to-zoom and wheel-based zoom adjustments on the map
- mobile pinch-to-zoom inside the map container
- desktop wheel-based zoom inside the map container without requiring a prior button click
- district-scoped market pins rendered inside the selected district
- market pin click -> market table route
- mobile-friendly stacked layout for home and results pages
- tighter mobile padding on cards and controls for the results screen
- chart horizontal scroll preserved when selecting a different chart point
- local district and market geography used by the home-screen map
- English/Kannada toggle persisted in browser storage
- unified translation JSON for screen copy plus entity labels, with English fallback when Kannada UI entries are not yet filled
- translated commodity, market, and variety labels across suggestions, headings, filters, table cells, history titles, map market labels, and home commodity chips
- translated category labels across the home category rail
- bilingual search matching so Kannada and English input both resolve while results render in the active language

Not implemented yet:

- additional summary widgets
- movers / top-changes module
- production packaging for the local dashboard

## Known Decisions

### Chosen

- use SQLite as the active datastore
- use the workbook as the rebuild source
- use the local DB as the default scraper sink
- use a repo-side JSON file as the source of truth for commodity categories
- keep the workbook snapshot as baseline seed data
- build a local Node-served HTML dashboard
- generate a GitHub Pages-friendly static build from the same source UI
- make search the primary navigation path
- add category-first browsing as a secondary home-screen discovery path
- keep row history inline in the results cards
- use the local district map as a secondary navigation path from home
- make the scraper source-pluggable behind a single UI

### Not chosen

- live Google Sheets reads
- write-through editing in the local app
- direct Excel reads from the browser
- giant JSON as the primary source of truth
- full historical row rendering as the primary results-card behavior

## Historical Context

This repo originally supported a different workflow:

- scrape KRAMA data
- write to Google Sheets
- manage perishability through Apps Script
- serve a dashboard from Apps Script HTML

That older workflow still exists in the codebase as reference, but it is **not the active architecture now**.

Reference-only files from that workflow:

- `scripts/backfill_perishability.js`
- `appscript/Code.gs`
- `appscript/CommodityMapping.html`
- `appscript/Dashboard.html`

`scrape_krama.js` is no longer reference-only. It has been repurposed into the active local scraper entry point and now supports multiple sources plus local DB writes.

## Operational Notes

- rebuild the DB whenever the workbook changes:
  - `npm run build:static-db`

- start the local dashboard server with:
  - `npm run dashboard:local`

- launch the scraper UI locally with:
  - double-click `Launch Commodity Scraper.vbs`

- run the scraper from terminal if needed:
  - `node scrape_krama.js`

- build the static Pages bundle with:
  - `npm run build:pages`

- DB path:
  - `data/agro_dashboard.db`

- commodity category mapping path:
  - `scripts/commodity_category_mapping.json`

- for simple row reads, prefer:
  - `price_observations_flat`

- for latest-row-per-entry reads, prefer:
  - `latest_price_observations`

- for duplicate handling:
  - inspect `row_key` uniqueness in `price_observations`

- for scraper execution auditing:
  - inspect `scrape_runs`

## Current Map Notes

The active home-screen map now uses:

- `local-dashboard/public/karnataka-geo.svg`

That SVG is now sourced from a better district map asset copied from the locally cloned `karnataka-budget-expectations` repo.

The map now supports:

- district click
- district zoom
- manual panning inside the map viewport
- touch pinch zoom and touch drag inside the map viewport
- desktop wheel zoom inside the map viewport
- desktop mouse drag panning once zoomed in
- market-pin generation from `market_district_mapping`
- in-SVG labeled market markers placed from district geometry sampling
- market pin click -> market table navigation
- direct district-path click handling on the integrated SVG asset
- in-map top-right zoom in / zoom out controls
- an in-map reset `×` control that only appears after the map leaves its default viewport, whether by district selection or manual zoom

Current source limitation:

- the current SVG source contains `30` districts, not `31`
- `Ramanagara` is present
- `Vijayanagara` is not present in the current SVG source, even though it exists in the local DB

## Current Scraper Scope

The scraper is now structured for incremental multi-source expansion.

Currently implemented sources:

- `krama`
- `necc_egg`
- `csb_silk`
- `rubber_board`
- `spices_board`
- `coffee_board`

Current `necc_egg` scope:

- scrapes the Daily Rate Sheet for the selected month and year
- reads the selected report date from the displayed day columns
- writes rows for Karnataka markets:
  - `Bengaluru`
  - `Mysuru`
- stores:
  - `price_100_pieces` from source data
  - `price_1_piece` as derived float
  - `price_1_tray` as derived float
- stores `arrivals`, `unit`, `variety`, and `grade` as null when source data is not present

Current `csb_silk` scope:

- fetches the current official Central Silk Board prices page:
  - `https://csb.gov.in/Statistics/silk-prices`
- does not support historical selection or backfill from the scraper UI
- uses a source-specific scraper UI flow with no date selector:
  - the user just triggers `Fetch Today's Data`
- scrapes the current HTML table directly from the page
- writes one row per market entry under each silk goods group
- stores:
  - `commodity = Silk`
  - `variety` from the source `Goods` label
  - `market` from the source nested table row
  - `report_date` from the row-level source `Date`
  - `min_price` from `Min`
  - `max_price` from `Max`
  - `modal_price` from `Average`
  - `arrivals` from `Quantity`
- stores `grade` and `unit` as null / empty when source data is not present
- stores missing `Quantity` as null, for example on `Raw Silk (Filature)`
- classifies `Silk` as:
  - `perishability = non-perishable`
  - `category = miscellaneous`
- market names are normalized to uppercase before DB writes
- currently normalizes the obvious market-name variant before uppercasing:
  - `Ramanagaram` -> `RAMANAGARA`

Current `rubber_board` scope:

- posts the selected date directly to the official Rubber Board daily market price form:
  - `https://rubberboard.gov.in/indianPrices`
- supports a single-date fetch from the scraper UI
- internally submits the selected date as both:
  - `txtFromDate`
  - `txtToDate`
- loops through official grade ids for:
  - `RSS4`
  - `RSS5`
  - `ISNR20`
  - `Latex (60%)`
- writes rows only for target markets:
  - `KOTTAYAM`
  - `KOCHI`
- stores:
  - `commodity = Rubber`
  - `variety` from the selected official grade
  - `report_date` from the row-level source date
  - `modal_price` from the INR price per 100 kg
- stores `arrivals`, `unit`, `grade`, `min_price`, and `max_price` as null / empty because the source does not provide them in this flow
- classifies `Rubber` as:
  - `perishability = non-perishable`
  - `category = miscellaneous`

Current `spices_board` scope:

- fetches the selected date directly from the official Spices Board current market price page:
  - `https://www.indianspices.com/marketing/price/domestic/current-market-price.html`
- supports a single-date fetch from the scraper UI
- internally sends the selected date as both:
  - `dateFrom`
  - `dateTo`
- always fixes the official state filter to:
  - `KERALA`
- parses only rows for the target market:
  - `Cochin`
- writes one row per displayed spice-grade row for that date
- stores:
  - `commodity` from the source `Spice` column
  - `market = Cochin`
  - `report_date` from the row-level source date
  - `grade` from the source `Grade` column
  - `modal_price` from the source `Avg` column
- stores `variety`, `arrivals`, `unit`, `min_price`, and `max_price` as null / empty because they are not used in this source flow
- stores source grade `-` as blank
- classifies all inserted rows as:
  - `perishability = non-perishable`
  - `category = miscellaneous`

Current `coffee_board` scope:

- downloads the dated daily report PDF from the official Coffee Board archive flow:
  - `https://coffeeboard.gov.in/Market_Info_Archives.aspx`
- supports a single-date fetch from the scraper UI
- resolves the selected date through the official archive month page and date link before downloading the PDF
- parses only the source section:
  - `Raw Coffee Price (Karnataka)`
- writes four rows per day for the fixed raw-coffee varieties:
  - `Arabica Parchment`
  - `Arabica Cherry`
  - `Robusta Parchment`
  - `Robusta Cherry`
- stores:
  - `commodity = Coffee`
  - `market = Karnataka`
  - `variety` from the source raw coffee type label
  - `report_date` from the PDF section date
  - `min_price` and `max_price` from the source range values
  - `unit = 50 Kg`
- stores `grade`, `arrivals`, and `modal_price` as null / empty because they are not present in this source section
- classifies all inserted rows as:
  - `perishability = non-perishable`
  - `category = miscellaneous`

## Immediate Next Step

The next practical work is to continue refining the local dashboard UI, validate the multi-source scraper UX with editorial users, and add additional scraper sources behind the same source-selection screen as needed.
