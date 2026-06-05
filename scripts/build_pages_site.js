const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");

const ROOT_DIR = path.resolve(__dirname, "..");
const DB_PATH = path.join(ROOT_DIR, "data", "agro_dashboard.db");
const PUBLIC_DIR = path.join(ROOT_DIR, "local-dashboard", "public");
const PUBLIC_DATA_DIR = path.join(PUBLIC_DIR, "data");
const DOCS_DIR = path.join(ROOT_DIR, "docs");

function main() {
  ensureDatabaseExists();
  const db = new Database(DB_PATH, { readonly: true, fileMustExist: true });

  try {
    const observations = db.prepare(`
      SELECT
        row_key,
        report_date,
        commodity,
        perishability,
        market,
        variety,
        grade,
        arrivals,
        unit,
        min_price,
        max_price,
        modal_price
      FROM price_observations_flat
      ORDER BY report_date ASC, commodity ASC, market ASC, variety ASC, grade ASC
    `).all().map((row) => ({
      rowKey: row.row_key,
      reportDate: row.report_date,
      commodity: row.commodity,
      perishability: row.perishability,
      market: row.market,
      variety: row.variety,
      grade: row.grade,
      arrivals: row.arrivals,
      unit: row.unit,
      minPrice: row.min_price,
      maxPrice: row.max_price,
      modalPrice: row.modal_price,
    }));

    const searchIndex = {
      commodities: db.prepare("SELECT name FROM commodities ORDER BY name ASC").all().map((row) => row.name),
      markets: db.prepare("SELECT name FROM markets ORDER BY name ASC").all().map((row) => row.name),
      varieties: db.prepare(`
        SELECT DISTINCT commodity, variety
        FROM price_observations_flat
        ORDER BY variety ASC, commodity ASC
      `).all().map((row) => ({
        commodity: row.commodity,
        variety: row.variety,
      })),
    };

    const mapData = {
      districts: buildMapDistricts(db),
    };

    const metadata = {
      generatedAt: new Date().toISOString(),
      observations: observations.length,
      commodities: searchIndex.commodities.length,
      markets: searchIndex.markets.length,
      varieties: searchIndex.varieties.length,
    };

    fs.mkdirSync(PUBLIC_DATA_DIR, { recursive: true });
    writeJson(path.join(PUBLIC_DATA_DIR, "observations.json"), observations);
    writeJson(path.join(PUBLIC_DATA_DIR, "search-index.json"), searchIndex);
    writeJson(path.join(PUBLIC_DATA_DIR, "map-data.json"), mapData);
    writeJson(path.join(PUBLIC_DATA_DIR, "metadata.json"), metadata);

    rebuildDocs();

    console.log(`Built GitHub Pages site in ${DOCS_DIR}`);
  } finally {
    db.close();
  }
}

function ensureDatabaseExists() {
  if (!fs.existsSync(DB_PATH)) {
    throw new Error(`Database not found: ${DB_PATH}`);
  }
}

function buildMapDistricts(db) {
  const rows = db.prepare(`
    SELECT
      d.name AS district_name,
      d.slug AS district_slug,
      m.name AS market_name
    FROM districts d
    LEFT JOIN market_district_mapping mdm ON mdm.district_id = d.id
    LEFT JOIN markets m ON m.id = mdm.market_id
    ORDER BY d.name ASC, m.name ASC
  `).all();

  const grouped = new Map();
  rows.forEach((row) => {
    if (!grouped.has(row.district_slug)) {
      grouped.set(row.district_slug, {
        district: row.district_name,
        districtSlug: row.district_slug,
        markets: [],
      });
    }

    if (row.market_name) {
      grouped.get(row.district_slug).markets.push({ market: row.market_name });
    }
  });

  return [...grouped.values()];
}

function rebuildDocs() {
  fs.rmSync(DOCS_DIR, { recursive: true, force: true });
  copyDirectory(PUBLIC_DIR, DOCS_DIR);
  fs.writeFileSync(path.join(DOCS_DIR, ".nojekyll"), "", "utf8");
}

function copyDirectory(sourceDir, targetDir) {
  fs.mkdirSync(targetDir, { recursive: true });
  const entries = fs.readdirSync(sourceDir, { withFileTypes: true });

  entries.forEach((entry) => {
    const sourcePath = path.join(sourceDir, entry.name);
    const targetPath = path.join(targetDir, entry.name);

    if (entry.isDirectory()) {
      copyDirectory(sourcePath, targetPath);
      return;
    }

    fs.copyFileSync(sourcePath, targetPath);
  });
}

function writeJson(filePath, payload) {
  fs.writeFileSync(filePath, `${JSON.stringify(payload)}\n`, "utf8");
}

main();
