const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const ROOT_DIR = path.resolve(__dirname, "..");
const ENV_PATH = path.join(ROOT_DIR, ".env");
const REMOTE_NAME = "origin";

function loadGitPat() {
  if (!fs.existsSync(ENV_PATH)) return null;
  const lines = fs.readFileSync(ENV_PATH, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const sep = trimmed.indexOf("=");
    if (sep <= 0) continue;
    const key = trimmed.slice(0, sep).trim();
    const value = trimmed.slice(sep + 1).trim();
    if (key === "GIT_PAT" && value) return value;
  }
  return null;
}

function run(description, command, cwd) {
  console.log(`\n[${description}]`);
  try {
    execSync(command, { cwd: cwd || ROOT_DIR, stdio: "inherit", timeout: 300000 });
    console.log(`  ✓ ${description} completed`);
  } catch (err) {
    console.error(`\n  ✗ ${description} FAILED`);
    process.exit(1);
  }
}

console.log("═══════════════════════════════════════════");
console.log("  Agro Dashboard — Data Update");
console.log("═══════════════════════════════════════════");

run("Step 1/4: Scraping KRAMA website", "node scrape_krama.js");
run("Step 2/4: Building SQLite database from Excel", "npm run build:static-db");
run("Step 3/4: Exporting static JSON files", "npm run build:pages");

console.log("\n[Step 4/4: Publishing to GitHub]");
try {
  execSync('git add docs/data/*.json', { cwd: ROOT_DIR, stdio: "pipe" });
  const date = new Date().toISOString().slice(0, 10);
  execSync(`git commit -m "data update ${date}"`, { cwd: ROOT_DIR, stdio: "pipe" });
} catch (err) {
  if (err.message.includes("nothing to commit")) {
    console.log("  — No new data to commit (data unchanged)");
    process.exit(0);
  }
  console.error(`\n  ✗ Git commit failed: ${err.message}`);
  process.exit(1);
}

// Inject PAT into remote URL if available
const gitPat = loadGitPat();
const cleanUrl = execSync(`git remote get-url ${REMOTE_NAME}`, { cwd: ROOT_DIR, stdio: "pipe" }).toString().trim();
let patUrl = null;

if (gitPat) {
  const urlObj = new URL(cleanUrl);
  patUrl = `${urlObj.protocol}//product-TPML:${gitPat}@${urlObj.host}${urlObj.pathname}`;
  execSync(`git remote set-url ${REMOTE_NAME} ${patUrl}`, { cwd: ROOT_DIR, stdio: "pipe" });
  console.log("  ✓ Injected GitHub PAT for push");
}

try {
  execSync("git push", { cwd: ROOT_DIR, stdio: "pipe" });
  console.log("  ✓ Committed and pushed to GitHub");
} catch (err) {
  console.error(`\n  ✗ Git push failed: ${err.message}`);
  console.error("    Check that GIT_PAT in .env has repo scope.");
  process.exit(1);
} finally {
  // Restore clean remote URL
  if (patUrl) {
    execSync(`git remote set-url ${REMOTE_NAME} ${cleanUrl}`, { cwd: ROOT_DIR, stdio: "pipe" });
  }
}

console.log("\n═══════════════════════════════════════════");
console.log("  ✅ Update complete!");
console.log("  GitHub Pages will auto-deploy in ~1 minute.");
console.log("  Refresh the dashboard page after that.");
console.log("═══════════════════════════════════════════");
