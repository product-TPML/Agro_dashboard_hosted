const { execSync } = require("child_process");
const path = require("path");

const ROOT_DIR = path.resolve(__dirname, "..");

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
  execSync("git push", { cwd: ROOT_DIR, stdio: "pipe" });
  console.log("  ✓ Committed and pushed to GitHub");
} catch (err) {
  if (err.message.includes("nothing to commit")) {
    console.log("  — No new data to commit (data unchanged)");
  } else if (err.message.includes("could not read Username")) {
    console.error("\n  ✗ Git push failed: not authenticated.");
    console.error("    Run once: gh auth login");
    process.exit(1);
  } else {
    console.error(`\n  ✗ Git push failed: ${err.message}`);
    console.error("    Check your GitHub authentication and try again.");
    process.exit(1);
  }
}

console.log("\n═══════════════════════════════════════════");
console.log("  ✅ Update complete!");
console.log("  GitHub Pages will auto-deploy in ~1 minute.");
console.log("  Refresh the dashboard page after that.");
console.log("═══════════════════════════════════════════");
