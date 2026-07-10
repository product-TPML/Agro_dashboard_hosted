# Static Dashboard Database

This folder contains the local static SQLite database used for dashboard development.

## Files

- `agro_dashboard.db`
  Generated SQLite database built from `Agro Dashboard - new data.xlsx`

## Build

```bash
npm run build:static-db
```

The build script recreates the database from the workbook each time.

Rebuild normalization also:

- removes persisted `spices_board` rows where `commodity = Pepper`
- stores `spices_board` prices through `canonical_price` with unit `per KG`
- stores `rubber_board` prices through `canonical_price` with unit `per 100 kg`
- stores `csb_silk` arrivals with unit `Quintal`
- preserves `coffee_board` range rows with unit `50 Kg`

## Core Tables

- `commodities`
- `commodity_mapping`
  Includes perishability and commodity category metadata.
- `districts`
- `markets`
- `market_district_mapping`
- `varieties`
- `grades`
- `units`
- `price_observations`
- `scrape_runs`
- `source_snapshot`

## Read-Focused Views

- `price_observations_flat`
  Denormalized view for dashboard queries

- `latest_price_observations`
  Latest available row per commodity + market + variety + grade

## Notes

- This is a static snapshot database for local dashboard development.
- No insert/update/delete flow is required for the current phase.
- Rebuild from the workbook if the source Excel file changes.
- Commodity category metadata is imported from `scripts/commodity_category_mapping.json`.
- Market-to-district geography is seeded from `scripts/karnataka_market_district_mapping.json`.
- The district mapping is intended for dashboard map interactions and local navigation.
