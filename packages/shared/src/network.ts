// Which XRPL network we talk to. NETWORK=devnet (lending, XLS-65/66) or
// NETWORK=testnet (the original escrow loans). Read lazily: ESM hoists
// imports, so a module-level constant would be evaluated before apps/api
// loads .env.

export type NetworkName = "devnet" | "testnet";

export interface NetworkInfo {
  name: NetworkName;
  wss: string;
  rpc: string;
  faucet: string;
  explorer: string; // base URL, no trailing slash
  lending: boolean; // XLS-65/66 amendments enabled
}

export const NETWORKS: Record<NetworkName, Omit<NetworkInfo, "wss"> & { publicWss: string }> = {
  devnet: {
    name: "devnet",
    publicWss: "wss://s.devnet.rippletest.net:51233",
    rpc: "https://s.devnet.rippletest.net:51234",
    faucet: "https://faucet.devnet.rippletest.net/accounts",
    explorer: "https://devnet.xrpl.org",
    lending: true,
  },
  testnet: {
    name: "testnet",
    publicWss: "wss://s.altnet.rippletest.net:51233",
    rpc: "https://s.altnet.rippletest.net:51234",
    faucet: "https://faucet.altnet.rippletest.net/accounts",
    explorer: "https://testnet.xrpl.org",
    lending: false,
  },
};

export function networkName(): NetworkName {
  const n = (process.env.NETWORK ?? "testnet").trim().toLowerCase();
  if (n !== "devnet" && n !== "testnet") {
    throw new Error(`NETWORK must be devnet or testnet, got "${n}". Mainnet is never used.`);
  }
  return n;
}

// Endpoint for the active network. Quicknode has no devnet, so on devnet only
// DEVNET_WSS can override the public node. On testnet QUICKNODE_WSS wins, then
// XRPL_WSS. Never log the result: Quicknode URLs embed an API token.
export function networkInfo(name: NetworkName = networkName()): NetworkInfo {
  const base = NETWORKS[name];
  const wss =
    name === "devnet"
      ? process.env.DEVNET_WSS || base.publicWss
      : process.env.QUICKNODE_WSS || process.env.XRPL_WSS || base.publicWss;
  const { publicWss: _unused, ...rest } = base;
  return { ...rest, wss };
}

// Safe to print: hides any path or query (where Quicknode puts its token).
export function redactEndpoint(url: string): string {
  try {
    const u = new URL(url);
    return u.pathname.length > 1 || u.search ? `${u.protocol}//${u.host}/<redacted>` : `${u.protocol}//${u.host}`;
  } catch {
    return "<endpoint>";
  }
}

export function txExplorerUrl(hash: string, name: NetworkName = networkName()): string {
  return `${NETWORKS[name].explorer}/transactions/${hash}`;
}

export function accountExplorerUrl(address: string, name: NetworkName = networkName()): string {
  return `${NETWORKS[name].explorer}/accounts/${address}`;
}
