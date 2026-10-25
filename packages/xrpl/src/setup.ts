import {
  Wallet,
  dropsToXrp,
  type AccountSet,
  type TrustSet,
  type Payment,
  type OfferCreate,
} from "xrpl";
import type { AccountName, AccountsFile, GpuId } from "@moonshift/shared";
import { GPUS, networkInfo, networkName, treasuryOf, vaultPhase } from "@moonshift/shared";
import { getClient, submitTx } from "./client.js";
import {
  ALL_ACCOUNT_NAMES,
  getAccountWallet,
  getSeedEnvKey,
  loadAccountsJson,
  saveAccountsJson,
  appendOrUpdateEnvSeeds,
  loadWalletFromSeed,
  getAccountAddress,
} from "./wallets.js";
import { publishOracle } from "./oracle.js";
import { createRound, pruneRounds } from "./lending.js";

const DEFAULT_RIPPLE_FLAG = 8; // asfDefaultRipple
const ALLOW_TRUSTLINE_LOCKING_FLAG = 17; // asfAllowTrustLineLocking

const LSF_DEFAULT_RIPPLE = 0x00800000;
const LSF_ALLOW_TRUSTLINE_LOCKING = 0x40000000;

export async function setupNetwork(): Promise<AccountsFile> {
  const client = await getClient();
  const net = networkInfo();
  console.log(`Starting setupNetwork on ${net.name} (idempotent, safe to rerun)...`);

  // Step 1: Ensure all wallets exist and have enough XRP (>= 50) on this network
  const wallets: Record<AccountName, Wallet> = {} as any;
  const newSeedsToSave: Partial<Record<AccountName, string>> = {};

  for (const name of ALL_ACCOUNT_NAMES) {
    const envKey = getSeedEnvKey(name);
    let seed = process.env[envKey];

    let wallet: Wallet;
    if (seed) {
      wallet = loadWalletFromSeed(seed);
      let balance = 0;
      try {
        const xrp = await client.getXrpBalance(wallet.address);
        balance = Number(xrp);
      } catch {
        // Account may not be funded yet
        balance = 0;
      }

      if (balance < 50) {
        console.log(`Funding existing ${name} (${wallet.address}) with balance ${balance} XRP...`);
        try {
          await client.fundWallet(wallet);
        } catch (e) {
          console.warn(`Faucet top-up for ${name} failed or delayed:`, (e as Error).message);
        }
      }
    } else {
      console.log(`Generating and funding new ${net.name} wallet for ${name}...`);
      const fundResult = await client.fundWallet();
      wallet = fundResult.wallet;
      seed = wallet.seed;
      if (seed) {
        newSeedsToSave[name] = seed;
      }
    }

    wallets[name] = wallet;
  }

  if (Object.keys(newSeedsToSave).length > 0) {
    console.log(`Saving ${Object.keys(newSeedsToSave).length} new seeds to .env...`);
    appendOrUpdateEnvSeeds(newSeedsToSave);
  }

  // Record public addresses in contracts/accounts.testnet.json
  const accountsFile: AccountsFile = {};
  for (const name of ALL_ACCOUNT_NAMES) {
    accountsFile[name] = { address: wallets[name].address };
  }
  saveAccountsJson(accountsFile);
  console.log(`Updated contracts/accounts.${net.name}.json with public addresses.`);

  const tdxIssuer = wallets.TDX_ISSUER;
  const shareIssuer = wallets.SHARE_ISSUER;
  const contractIssuer = wallets.CONTRACT_ISSUER;

  // Step 2: Set flags on issuers
  // TDX_ISSUER: asfDefaultRipple + asfAllowTrustLineLocking
  await ensureIssuerFlags(tdxIssuer, [DEFAULT_RIPPLE_FLAG, ALLOW_TRUSTLINE_LOCKING_FLAG], "TDX_ISSUER");

  // SHARE_ISSUER: asfDefaultRipple + asfAllowTrustLineLocking
  await ensureIssuerFlags(shareIssuer, [DEFAULT_RIPPLE_FLAG, ALLOW_TRUSTLINE_LOCKING_FLAG], "SHARE_ISSUER");

  // CONTRACT_ISSUER: asfDefaultRipple
  await ensureIssuerFlags(contractIssuer, [DEFAULT_RIPPLE_FLAG], "CONTRACT_ISSUER");

  // Every registry GPU has its own treasury: its shares, its revenue, its dividends.
  const treasuries = GPUS.map((g) => treasuryOf(g.id));

  // Step 3: Establish trustlines
  // All non-issuers trust TDX
  const nonIssuers: AccountName[] = [
    ...treasuries,
    "PROTOCOL_FEES",
    "LENDING_POOL",
    "ORACLE",
    "ALICE",
    "BOB",
    "CAROL",
    "DEV",
  ];

  // Different accounts never share a sequence, so run them in parallel.
  await Promise.all(nonIssuers.map((acct) => ensureTrustline(wallets[acct], "TDX", tdxIssuer.address, "1000000000", acct)));

  // Each treasury trusts its own GPU's shares; LENDING_POOL (collateral), CAROL (market maker bids),
  // the personas and DEV trust every GPU's shares.
  await Promise.all(
    GPUS.map((g) => ensureTrustline(wallets[treasuryOf(g.id)], g.shareCode, shareIssuer.address, "1000000000", treasuryOf(g.id)))
  );
  const shareTrustees: AccountName[] = ["LENDING_POOL", "ALICE", "BOB", "CAROL", "DEV"];

  await Promise.all(
    shareTrustees.map(async (acct) => {
      for (const g of GPUS) await ensureTrustline(wallets[acct], g.shareCode, shareIssuer.address, "1000000000", acct);
    })
  );

  // Treasuries, personas and DEV trust HRA and HRB
  const contractTrustees: AccountName[] = [
    "TREASURY_GPU_A",
    "TREASURY_GPU_B",
    "ALICE",
    "BOB",
    "CAROL",
    "DEV",
  ];

  await Promise.all(
    contractTrustees.map(async (acct) => {
      await ensureTrustline(wallets[acct], "HRA", contractIssuer.address, "1000000000", acct);
      await ensureTrustline(wallets[acct], "HRB", contractIssuer.address, "1000000000", acct);
    })
  );

  // Step 4: Issue tokens
  // 1,000 shares of each GPU to its own treasury (GPA to TREASURY_GPU_A, ..., GPH to TREASURY_GPU_H),
  // once: a treasury that sold shares is never topped back up (that would mint new shares and dilute holders).
  for (const g of GPUS) await ensureSharesIssued(shareIssuer, wallets[treasuryOf(g.id)], g.shareCode, String(g.sharesTotal), treasuryOf(g.id));

  // 200 HRA and 200 HRB to treasuries
  await ensureTokenSupply(contractIssuer, wallets.TREASURY_GPU_A, "HRA", "200", "TREASURY_GPU_A");
  await ensureTokenSupply(contractIssuer, wallets.TREASURY_GPU_B, "HRB", "200", "TREASURY_GPU_B");

  // TDX float: lenders BOB and CAROL 60,000, borrowers ALICE and DEV 15,000,
  // LENDING_POOL 10,000 (topped up to these, never above)
  const tdxTargets: [AccountName, string][] = [
    ["ALICE", "15000"],
    ["BOB", "60000"],
    ["CAROL", "60000"],
    ["DEV", "15000"],
    ["LENDING_POOL", "10000"],
  ];
  for (const [acct, target] of tdxTargets) {
    await ensureTokenSupply(tdxIssuer, wallets[acct], "TDX", target, acct);
  }

  // Step 5: Initial DEX Sell Offers
  // Shares: start at 5.000000 TDX per share
  // Contracts: start at 0.250000 TDX per slot
  for (const g of GPUS) {
    await ensureInitialOffer(
      wallets[treasuryOf(g.id)],
      { currency: g.shareCode, issuer: shareIssuer.address, value: String(g.sharesTotal) },
      { currency: "TDX", issuer: tdxIssuer.address, value: String(g.sharesTotal * 5) },
      `${treasuryOf(g.id)} (${g.shareCode} ${g.sharesTotal} @ 5.0 TDX)`
    );
  }

  await ensureInitialOffer(
    wallets.TREASURY_GPU_A,
    { currency: "HRA", issuer: contractIssuer.address, value: "200" },
    { currency: "TDX", issuer: tdxIssuer.address, value: "50" },
    "TREASURY_GPU_A (HRA 200 @ 0.25 TDX)"
  );

  await ensureInitialOffer(
    wallets.TREASURY_GPU_B,
    { currency: "HRB", issuer: contractIssuer.address, value: "200" },
    { currency: "TDX", issuer: tdxIssuer.address, value: "50" },
    "TREASURY_GPU_B (HRB 200 @ 0.25 TDX)"
  );

  // Step 6: Oracle. One OracleSet per GPU so the risk keeper has a price.
  await ensureOracles();

  // Step 7: Lending rounds (XLS-65 vault + XLS-66 broker), lending networks only.
  if (net.lending) {
    await ensureLendingRounds();
  } else {
    console.log(`Lending is not enabled on ${net.name}; skipping vaults. Use NETWORK=devnet.`);
  }

  console.log(`setupNetwork completed successfully on ${networkName()}!`);
  return accountsFile;
}

async function ensureIssuerFlags(
  issuer: Wallet,
  flags: number[],
  name: string
): Promise<void> {
  const client = await getClient();
  const info = await client.request({
    command: "account_info",
    account: issuer.address,
    ledger_index: "validated",
  });

  const rootFlags = info.result.account_data.Flags ?? 0;

  for (const flag of flags) {
    const isDefaultRipple = flag === DEFAULT_RIPPLE_FLAG;
    const isTrustlineLocking = flag === ALLOW_TRUSTLINE_LOCKING_FLAG;

    const alreadySet =
      (isDefaultRipple && (rootFlags & LSF_DEFAULT_RIPPLE) !== 0) ||
      (isTrustlineLocking && (rootFlags & LSF_ALLOW_TRUSTLINE_LOCKING) !== 0);

    if (alreadySet) {
      continue;
    }

    console.log(`Setting flag ${flag} on ${name} (${issuer.address})...`);
    const tx: AccountSet = {
      TransactionType: "AccountSet",
      Account: issuer.address,
      SetFlag: flag,
    };
    await submitTx(issuer, tx);
  }
}

async function ensureTrustline(
  wallet: Wallet,
  currency: string,
  issuer: string,
  limit: string,
  name: string
): Promise<void> {
  const client = await getClient();
  const linesRes = await client.request({
    command: "account_lines",
    account: wallet.address,
    ledger_index: "validated",
  });

  const existing = linesRes.result.lines.find(
    (l) => l.currency === currency && l.account === issuer
  );

  if (existing && Number(existing.limit) >= Number(limit)) {
    return;
  }

  console.log(`Setting trustline for ${name} -> ${currency} (${limit})...`);
  const tx: TrustSet = {
    TransactionType: "TrustSet",
    Account: wallet.address,
    LimitAmount: {
      currency,
      issuer,
      value: limit,
    },
  };
  await submitTx(wallet, tx);
}

async function ensureTokenSupply(
  issuer: Wallet,
  recipient: Wallet,
  currency: string,
  targetAmount: string,
  recipientName: string
): Promise<void> {
  const client = await getClient();
  const linesRes = await client.request({
    command: "account_lines",
    account: recipient.address,
    ledger_index: "validated",
  });

  const existing = linesRes.result.lines.find(
    (l) => l.currency === currency && l.account === issuer.address
  );

  const currentBal = existing ? Number(existing.balance) : 0;
  const target = Number(targetAmount);

  if (currentBal >= target) {
    return;
  }

  const toIssue = (target - currentBal).toFixed(6);
  console.log(`Issuing ${toIssue} ${currency} to ${recipientName}...`);

  const payment: Payment = {
    TransactionType: "Payment",
    Account: issuer.address,
    Destination: recipient.address,
    Amount: {
      currency,
      issuer: issuer.address,
      value: toIssue,
    },
  };

  await submitTx(issuer, payment);
}

// Issue a GPU's shares to its treasury only if the issuer has never issued that code.
async function ensureSharesIssued(issuer: Wallet, treasury: Wallet, code: string, total: string, treasuryName: string): Promise<void> {
  const client = await getClient();
  const res = await client.request({ command: "gateway_balances", account: issuer.address, ledger_index: "validated" });
  const outstanding = Number((res.result.obligations as Record<string, string> | undefined)?.[code] ?? 0);
  if (outstanding > 0) return;
  console.log(`Issuing ${total} ${code} to ${treasuryName}...`);
  await submitTx(issuer, {
    TransactionType: "Payment",
    Account: issuer.address,
    Destination: treasury.address,
    Amount: { currency: code, issuer: issuer.address, value: total },
  });
}

async function ensureInitialOffer(
  treasury: Wallet,
  takerGets: { currency: string; issuer: string; value: string },
  takerPays: { currency: string; issuer: string; value: string },
  desc: string
): Promise<void> {
  const client = await getClient();
  const offersRes = await client.request({
    command: "account_offers",
    account: treasury.address,
    ledger_index: "validated",
  });

  const existing = offersRes.result.offers?.find((o) => {
    const pays = typeof o.taker_pays === "object" ? o.taker_pays.currency : "XRP";
    const gets = typeof o.taker_gets === "object" ? o.taker_gets.currency : "XRP";
    return pays === takerPays.currency && gets === takerGets.currency;
  });

  if (existing) {
    return;
  }

  console.log(`Placing initial offer: ${desc}...`);
  const offerTx: OfferCreate = {
    TransactionType: "OfferCreate",
    Account: treasury.address,
    TakerGets: takerGets,
    TakerPays: takerPays,
  };

  await submitTx(treasury, offerTx);
}

async function ensureOracles(): Promise<void> {
  const client = await getClient();
  const oracle = getAccountWallet("ORACLE");
  for (const [i, gpu] of GPUS.entries()) {
    try {
      await client.request({
        command: "ledger_entry",
        oracle: { account: oracle.address, oracle_document_id: i + 1 },
        ledger_index: "validated",
      } as any);
      continue; // already published
    } catch {
      // not found: publish the opening price below
    }
    console.log(`Publishing opening oracle price for ${gpu.id}...`);
    // Opening NAV matches the initial DEX offer (5 TDX per share).
    await publishOracle({ gpuId: gpu.id, navPerShare: "5.000000", gpuHourPrice: "3.000000", utilizationPct: "20.00" });
  }
}

// Two rounds keep the demo whole: one in its investment phase (borrowers
// draw from it now) and the next one in subscription (lenders deposit now).
// Rounds whose vault vanished (devnet reset) are pruned first.
export async function ensureLendingRounds(): Promise<void> {
  const live = await pruneRounds();
  const soon = Date.now() + 60 * 60 * 1000;
  const now = new Date();

  const investing = live.find(
    (r) => vaultPhase(r.subscriptionDate, r.redemptionDate, now) === "investment" && new Date(r.redemptionDate).getTime() > soon
  );
  if (!investing) {
    console.log("Creating an investing lending round (short subscription, 14 day term)...");
    await createRound({
      subscriptionSeconds: 75,
      termSeconds: 14 * 24 * 3600,
      coverAmount: "1000",
      seedDeposits: [
        { lender: "BOB", amount: "4000" },
        { lender: "CAROL", amount: "3000" },
      ],
      waitForInvestment: true,
      log: (m) => console.log(`  ${m}`),
    });
  }

  const subscribing = live.find(
    (r) => vaultPhase(r.subscriptionDate, r.redemptionDate, now) === "subscription" && new Date(r.subscriptionDate).getTime() > soon
  );
  if (!subscribing) {
    console.log("Creating the next lending round (3 day subscription window)...");
    await createRound({
      subscriptionSeconds: 3 * 24 * 3600,
      termSeconds: 14 * 24 * 3600,
      coverAmount: "500",
      seedDeposits: [
        { lender: "BOB", amount: "20000" },
        { lender: "CAROL", amount: "1000" },
      ],
      log: (m) => console.log(`  ${m}`),
    });
  }
}

// Replace an account with a fresh faucet-funded wallet on the active network
// (devnet demo resets: a clean borrower history every pitch). The new seed is
// written to .env by appendOrUpdateEnvSeeds and never printed; the public
// address goes to contracts/accounts.<network>.json. Run setupNetwork after
// this so the new account gets its trust lines and tokens.
export async function rotateAccount(name: AccountName): Promise<{ address: string }> {
  if (networkName() === "testnet") throw new Error("rotateAccount is for devnet demo resets only");
  const client = await getClient();
  const { wallet } = await client.fundWallet();
  if (!wallet.seed) throw new Error("faucet returned no seed");
  appendOrUpdateEnvSeeds({ [name]: wallet.seed });
  const file = loadAccountsJson();
  file[name] = { address: wallet.address };
  const { _note: _n, ...rest } = file as any;
  saveAccountsJson(rest);
  return { address: wallet.address };
}

// Demo resets: seized collateral piles up with the broker and the treasury's
// sell offer runs dry. Send the broker's shares back to the GPU treasury and
// list whatever the treasury holds but does not have on offer, at `price`.
// demo:reset: seized collateral (GPU shares the lending pool took in liquidations) goes back to the GPU's
// treasury. It is not listed here: a fixed-price listing (it was 5.00) filled at once against the market
// maker's bid near NAV and moved the treasury's cash; the market maker lists the treasury's shares at NAV
// on its next quote (apps/api marketMaker.ts).
export async function restockShares(gpuId: GpuId): Promise<{ returned: string }> {
  const gpu = GPUS.find((g) => g.id === gpuId)!;
  const client = await getClient();
  const shareIssuer = getAccountAddress("SHARE_ISSUER");
  const treasury = getAccountWallet(treasuryOf(gpuId));
  const broker = getAccountWallet("LENDING_POOL");
  const res = await client.request({ command: "account_lines", account: broker.address, ledger_index: "validated" });
  const held = Number(res.result.lines.find((l) => l.currency === gpu.shareCode && l.account === shareIssuer)?.balance ?? 0);
  if (held > 0) {
    await submitTx(broker, {
      TransactionType: "Payment",
      Account: broker.address,
      Destination: treasury.address,
      Amount: { currency: gpu.shareCode, issuer: shareIssuer, value: held.toFixed(6) },
    } as Payment);
  }
  return { returned: held.toFixed(6) };
}
