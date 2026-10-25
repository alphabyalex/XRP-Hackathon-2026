// npm run account:reset -- <wallet address>: give a wallet a fresh Moonshift
// account (starting balance, no loan history), the same action as "Reset
// account for wallet" on /admin/router. Needs the api running. Prints the
// old and new account addresses only.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const API = process.env.API_URL || "http://localhost:4000";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
function envValue(name) {
  if (process.env[name]) return process.env[name];
  const file = path.join(ROOT, ".env");
  if (!fs.existsSync(file)) return undefined;
  const m = new RegExp(`^[ \t]*${name}[ \t]*=[ \t]*(.*)$`, "m").exec(fs.readFileSync(file, "utf8"));
  return m ? m[1].trim().replace(/^["']|["']$/g, "") : undefined;
}
// Same default npm run demo gives the api when .env has none.
const INTERNAL_KEY = envValue("INTERNAL_API_KEY") || "moonshift-local-demo-key";

const wallet = process.argv[2];
if (!/^r[1-9A-HJ-NP-Za-km-z]{24,34}$/.test(wallet ?? "")) {
  console.error("usage: npm run account:reset -- <wallet address>");
  process.exit(2);
}
const res = await fetch(`${API}/operator/accounts/reset`, {
  method: "POST",
  headers: { "Content-Type": "application/json", "X-MS-Internal-Key": INTERNAL_KEY },
  body: JSON.stringify({ wallet }),
});
const out = await res.json().catch(() => ({}));
if (!res.ok) {
  console.error(`reset refused (${res.status}): ${out.error?.message ?? "unknown error"}`);
  process.exit(1);
}
console.log(`wallet ${out.wallet}: account ${out.previousAccount} retired, now ${out.account} (${out.setupMs} ms)`);
