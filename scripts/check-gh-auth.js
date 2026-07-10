const { execSync } = require("child_process");

try {
  execSync("gh auth status", { stdio: "pipe", timeout: 10000 });
  console.log("✓ GitHub authentication: OK");
} catch {
  console.log("\n⚠  GitHub authentication not configured.");
  console.log("   To publish data updates, you need to authenticate once:");
  console.log("\n   Run this in your terminal:");
  console.log("     gh auth login");
  console.log("\n   Follow the browser prompt to sign in.");
  console.log("   After that, 'npm run update-data' will work automatically.\n");
}
