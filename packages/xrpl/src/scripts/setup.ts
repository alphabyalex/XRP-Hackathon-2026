import { setupNetwork } from "../setup.js";
import { disconnectClient } from "../client.js";

async function main() {
  console.log("Running XRPL setupNetwork CLI script...");
  try {
    const accounts = await setupNetwork();
    console.log("\nSetup complete. Configured accounts:");
    for (const [name, info] of Object.entries(accounts)) {
      if (name.startsWith("_")) continue;
      console.log(`  ${name.padEnd(20)}: ${info.address}`);
    }
  } catch (err) {
    console.error("Setup failed:", err);
    process.exitCode = 1;
  } finally {
    await disconnectClient();
  }
}

main();
