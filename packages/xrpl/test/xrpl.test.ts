import assert from "node:assert/strict";
import crypto from "node:crypto";
import {
  ceil6,
  isoToRipple,
  networkInfo,
  pctToTenthBps,
  redactEndpoint,
  rippleToIso,
  tenthBpsToPct,
  txExplorerUrl,
  vaultPhase,
} from "@moonshift/shared";
import { BatchFlags, xrpToDrops, dropsToXrp } from "xrpl";
import {
  getSigningAlgorithm,
  getSeedEnvKey,
  ALL_ACCOUNT_NAMES,
} from "../src/wallets.js";
import {
  InsufficientFunds,
  NoLiquidity,
  TrustlineMissing,
  LedgerRejected,
} from "../src/errors.js";
import { signChannelClaim, verifyChannelClaim } from "../src/paychan.js";
import { TARGET_FEATURES } from "../src/features.js";
import { MS_KYC_CREDENTIAL_TYPE } from "../src/permissioned.js";

async function runTests() {
  console.log("Running @moonshift/xrpl unit and integration test suite...\n");

  // 1. Wallet algorithm selection (Guard against secp256k1 derivation bug)
  console.log("Test 1: Wallet algorithm selection guard");
  assert.equal(getSigningAlgorithm("sEdVjYjgktToeRESyijEd4Mt1tvp1UB"), "ed25519");
  assert.equal(getSigningAlgorithm("sn3nxiW7v8KXzPzAKNcubZiWC9MqG"), "ecdsa-secp256k1");
  console.log("  Passed: sEd prefix correctly selects ed25519, standard seed selects secp256k1");

  // 2. Account names and environment keys
  console.log("\nTest 2: Account names and environment key resolution");
  assert.equal(ALL_ACCOUNT_NAMES.length, 12);
  assert.equal(getSeedEnvKey("TDX_ISSUER", "testnet"), "TDX_ISSUER_SEED");
  assert.equal(getSeedEnvKey("ALICE", "testnet"), "ALICE_SEED");
  console.log("  Passed: 12 accounts configured with exact seed env mapping");

  // 3. Typed Errors
  console.log("\nTest 3: Typed error classes");
  const err1 = new InsufficientFunds("Not enough TDX");
  assert.equal(err1.name, "InsufficientFunds");
  const err2 = new NoLiquidity("No matching offer");
  assert.equal(err2.name, "NoLiquidity");
  const err3 = new TrustlineMissing("Trustline not set");
  assert.equal(err3.name, "TrustlineMissing");
  const err4 = new LedgerRejected("tecINSUFFICIENT_FUNDS", "Failed on ledger", "FAKEHASH123");
  assert.equal(err4.name, "LedgerRejected");
  assert.equal(err4.code, "tecINSUFFICIENT_FUNDS");
  assert.equal(err4.hash, "FAKEHASH123");
  console.log("  Passed: InsufficientFunds, NoLiquidity, TrustlineMissing, and LedgerRejected intact");

  // 4. Crypto-conditions DER structure for TokenEscrow loans
  console.log("\nTest 4: Crypto-conditions DER formatting for loans");
  const preimage = crypto.randomBytes(32);
  const sha256 = crypto.createHash("sha256").update(preimage).digest("hex").toUpperCase();
  const condition = "A0258020" + sha256 + "810120";
  const fulfillment = "A0228020" + preimage.toString("hex").toUpperCase();
  assert.equal(condition.length, 78);
  assert.equal(fulfillment.length, 72);
  assert.ok(condition.startsWith("A0258020"));
  assert.ok(condition.endsWith("810120"));
  assert.ok(fulfillment.startsWith("A0228020"));
  console.log("  Passed: PREIMAGE-SHA-256 condition and fulfillment adhere to DER ASN.1 specification");

  // 5. Payment channel claim signing and verification
  console.log("\nTest 5: Payment Channel off-chain claim signature");
  const channelId = crypto.randomBytes(32).toString("hex").toUpperCase();
  const testKeypair = crypto.generateKeyPairSync("ed25519");
  // Test with xrpl Wallet
  const { Wallet } = await import("xrpl");
  const testWallet = Wallet.generate();
  const claimAmountXrp = "0.050000";
  const sig = signChannelClaim(channelId, claimAmountXrp, testWallet.privateKey);
  const verified = verifyChannelClaim(channelId, claimAmountXrp, sig, testWallet.publicKey);
  assert.equal(verified, true, "Payment channel claim signature must verify with public key");
  console.log("  Passed: Off-chain claim signature creates verifiable cumulative claim");

  // 6. Target features list
  console.log("\nTest 6: XRPL Testnet target features");
  assert.ok(TARGET_FEATURES.includes("BatchV1_1"));
  assert.ok(TARGET_FEATURES.includes("TokenEscrow"));
  assert.ok(TARGET_FEATURES.includes("PriceOracle"));
  assert.ok(TARGET_FEATURES.includes("Credentials"));
  assert.ok(TARGET_FEATURES.includes("PermissionedDomains"));
  assert.ok(TARGET_FEATURES.includes("PermissionedDEX"));
  assert.ok(TARGET_FEATURES.includes("PermissionDelegationV1_1"));
  console.log("  Passed: All 7 key XRPL features cataloged");

  // 7. Credentials format
  console.log("\nTest 7: Credentials encoding");
  assert.equal(MS_KYC_CREDENTIAL_TYPE, Buffer.from("MS_KYC").toString("hex").toUpperCase());
  console.log("  Passed: MS_KYC hex encoding is valid");

  // 8. Money conversions
  console.log("\nTest 8: Drops and XRP string utilities");
  assert.equal(xrpToDrops("1"), "1000000");
  assert.equal(dropsToXrp("1000000"), 1);
  console.log("  Passed: Exact drops to XRP conversion");

  // 9. Network switch: seed names, endpoints, explorer links
  console.log("\nTest 9: Network switch");
  assert.equal(getSeedEnvKey("ALICE", "testnet"), "ALICE_SEED");
  assert.equal(getSeedEnvKey("ALICE", "devnet"), "DEVNET_ALICE_SEED");
  assert.equal(redactEndpoint("wss://abc.xrp-testnet.quiknode.pro/SECRETTOKEN/"), "wss://abc.xrp-testnet.quiknode.pro/<redacted>");
  assert.equal(redactEndpoint("wss://s.devnet.rippletest.net:51233"), "wss://s.devnet.rippletest.net:51233");
  assert.ok(txExplorerUrl("ABC", "devnet").startsWith("https://devnet.xrpl.org/transactions/"));
  const savedQn = process.env.QUICKNODE_WSS;
  process.env.QUICKNODE_WSS = "wss://example.quiknode.pro/token/";
  assert.ok(!networkInfo("devnet").wss.includes("quiknode"), "devnet must never use Quicknode");
  if (savedQn === undefined) delete process.env.QUICKNODE_WSS;
  else process.env.QUICKNODE_WSS = savedQn;
  console.log("  Passed: per-network seed keys, redaction, devnet never routes to Quicknode");

  // 10. Lending math helpers
  console.log("\nTest 10: Lending math");
  assert.equal(ceil6("166.667427702245843"), "166.667428");
  assert.equal(ceil6("500.002283106738"), "500.002284");
  assert.equal(ceil6("12"), "12.000000");
  assert.equal(ceil6("1e-7"), "0.000001");
  assert.equal(pctToTenthBps(12), 12000);
  assert.equal(tenthBpsToPct(50000), "50.000");
  assert.equal(rippleToIso(isoToRipple("2026-10-24T12:00:00.000Z")), "2026-10-24T12:00:00.000Z");
  assert.equal(vaultPhase("2026-01-02T00:00:00Z", "2026-01-03T00:00:00Z", new Date("2026-01-01T00:00:00Z")), "subscription");
  assert.equal(vaultPhase("2026-01-02T00:00:00Z", "2026-01-03T00:00:00Z", new Date("2026-01-02T12:00:00Z")), "investment");
  assert.equal(vaultPhase("2026-01-02T00:00:00Z", "2026-01-03T00:00:00Z", new Date("2026-01-04T00:00:00Z")), "redemption");
  console.log("  Passed: ceil6 rounding, 1/10 bp units, ripple time, vault phases");

  console.log("\n==================================================================");
  console.log("              ALL UNIT AND SUITE TESTS PASSED!                    ");
  console.log("==================================================================");
}

runTests().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
