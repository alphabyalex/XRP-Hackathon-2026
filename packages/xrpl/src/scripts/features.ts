import { checkFeatures, TARGET_FEATURES, LENDING_FEATURES } from "../features.js";
import { disconnectClient } from "../client.js";

async function main() {
  console.log("Checking XRPL features on the active NETWORK...");
  try {
    const report = await checkFeatures();
    console.log(`\nNetwork: ${report.network}  Endpoint: ${report.endpoint}`);
    console.log(`Checked at: ${report.timestamp}\n`);
    console.log("Feature Status Table:");
    console.log("------------------------------------------------------------------");
    console.log(
      "Feature".padEnd(28) +
      "Enabled".padEnd(12) +
      "Supported".padEnd(12) +
      "Vetoed"
    );
    console.log("------------------------------------------------------------------");
    for (const name of [...TARGET_FEATURES, ...LENDING_FEATURES]) {
      const f = report.features[name];
      const enabled = f.enabled ? "YES" : "NO";
      const supported = f.supported ? "YES" : "NO";
      const vetoed = f.vetoed ? String(f.vetoed) : "false";
      console.log(
        name.padEnd(28) +
        enabled.padEnd(12) +
        supported.padEnd(12) +
        vetoed
      );
    }
    console.log("------------------------------------------------------------------\n");

    const allEnabled = TARGET_FEATURES.every((f) => report.features[f]?.enabled);
    if (allEnabled) {
      console.log(`All target features are ENABLED on ${report.network}.`);
    } else {
      console.log("Note: Some features are disabled; fallback pathways will be used.");
    }
    const lending = LENDING_FEATURES.every((f) => report.features[f]?.enabled);
    console.log(lending ? "Lending (XLS-65/66) is available." : "Lending (XLS-65/66) is NOT available on this network. Use NETWORK=devnet.");
  } catch (err) {
    console.error("Failed to check features:", err);
    process.exitCode = 1;
  } finally {
    await disconnectClient();
  }
}

main();
