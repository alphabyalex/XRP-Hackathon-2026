import { redactEndpoint, networkName } from "@moonshift/shared";
import { getClient, disconnectClient } from "./client.js";

export interface FeatureStatus {
  name: string;
  enabled: boolean;
  supported: boolean;
  vetoed?: boolean | string;
}

export interface FeatureReport {
  timestamp: string;
  network: string;
  endpoint: string; // redacted, safe to print
  features: Record<string, FeatureStatus>;
}

export const TARGET_FEATURES = [
  "BatchV1_1",
  "TokenEscrow",
  "Credentials",
  "PermissionedDomains",
  "PermissionedDEX",
  "PermissionDelegationV1_1",
  "PriceOracle",
] as const;

// Lending stack (XLS-65 vault, XLS-66 loans). Enabled on devnet only today.
export const LENDING_FEATURES = [
  "LendingProtocol",
  "LendingProtocolV1_1",
  "SingleAssetVault",
  "MPTokensV1",
] as const;

export async function checkFeatures(): Promise<FeatureReport> {
  const client = await getClient();
  const res = await client.request({ command: "feature" });

  const rawFeatures = res.result.features as Record<string, any>;
  const report: Record<string, FeatureStatus> = {};

  for (const target of [...TARGET_FEATURES, ...LENDING_FEATURES]) {
    let found: FeatureStatus | null = null;
    for (const [id, f] of Object.entries(rawFeatures)) {
      if (f.name && f.name.toLowerCase() === target.toLowerCase()) {
        found = {
          name: f.name,
          enabled: Boolean(f.enabled),
          supported: Boolean(f.supported),
          vetoed: f.vetoed,
        };
        break;
      }
    }

    if (found) {
      report[target] = found;
    } else {
      report[target] = {
        name: target,
        enabled: false,
        supported: false,
      };
    }
  }

  return {
    timestamp: new Date().toISOString(),
    network: networkName(),
    endpoint: redactEndpoint(client.url),
    features: report,
  };
}
