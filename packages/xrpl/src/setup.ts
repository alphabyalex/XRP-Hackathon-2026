import {
  Wallet,
  dropsToXrp,
  type AccountSet,
  type TrustSet,
  type Payment,
  type OfferCreate,
} from "xrpl";
import type { AccountName, AccountsFile } from "@moonshift/shared";
import { GPUS } from "@moonshift/shared";
import { getClient, submitTx } from "./client.js";
import {
  ALL_ACCOUNT_NAMES,
  getAccountWallet,
  getSeedEnvKey,
  loadAccountsJson,
  saveAccountsJson,
  appendOrUpdateEnvSeeds,
  loadWalletFromSeed,
} from "./wallets.js";

const DEFAULT_RIPPLE_FLAG = 8; // asfDefaultRipple
const ALLOW_TRUSTLINE_LOCKING_FLAG = 17; // asfAllowTrustLineLocking

const LSF_DEFAULT_RIPPLE = 0x00800000;
const LSF_ALLOW_TRUSTLINE_LOCKING = 0x40000000;

export async function setupNetwork(): Promise<AccountsFile> {
  const client = await getClient();
  console.log("Starting setupNetwork (idempotent)...");

  // Step 1: Ensure all wallets exist and have sufficient testnet XRP (>= 50 XRP)
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
      console.log(`Generating and funding new testnet wallet for ${name}...`);
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
  console.log("Updated contracts/accounts.testnet.json with public addresses.");

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

  // Step 3: Establish trustlines
  // All non-issuers trust TDX
  const nonIssuers: AccountName[] = [
    "TREASURY_GPU_A",
    "TREASURY_GPU_B",
    "PROTOCOL_FEES",
    "LENDING_POOL",
    "ORACLE",
    "ALICE",
    "BOB",
    "CAROL",
    "DEV",
  ];

  for (const acct of nonIssuers) {
    await ensureTrustline(wallets[acct], "TDX", tdxIssuer.address, "1000000000", acct);
  }

  // Treasuries, personas and LENDING_POOL trust GPA and GPB
  const shareTrustees: AccountName[] = [
    "TREASURY_GPU_A",
    "TREASURY_GPU_B",
    "LENDING_POOL",
    "ALICE",
    "BOB",
    "CAROL",
    "DEV",
  ];

  for (const acct of shareTrustees) {
    await ensureTrustline(wallets[acct], "GPA", shareIssuer.address, "1000000000", acct);
    await ensureTrustline(wallets[acct], "GPB", shareIssuer.address, "1000000000", acct);
  }

  // Treasuries, personas and DEV trust HRA and HRB
  const contractTrustees: AccountName[] = [
    "TREASURY_GPU_A",
    "TREASURY_GPU_B",
    "ALICE",
    "BOB",
    "CAROL",
    "DEV",
  ];

  for (const acct of contractTrustees) {
    await ensureTrustline(wallets[acct], "HRA", contractIssuer.address, "1000000000", acct);
    await ensureTrustline(wallets[acct], "HRB", contractIssuer.address, "1000000000", acct);
  }

  // Step 4: Issue tokens
  // 1,000 GPA to TREASURY_GPU_A
  await ensureTokenSupply(shareIssuer, wallets.TREASURY_GPU_A, "GPA", "1000", "TREASURY_GPU_A");
  // 1,000 GPB to TREASURY_GPU_B
  await ensureTokenSupply(shareIssuer, wallets.TREASURY_GPU_B, "GPB", "1000", "TREASURY_GPU_B");

  // 200 HRA and 200 HRB to treasuries
  await ensureTokenSupply(contractIssuer, wallets.TREASURY_GPU_A, "HRA", "200", "TREASURY_GPU_A");
  await ensureTokenSupply(contractIssuer, wallets.TREASURY_GPU_B, "HRB", "200", "TREASURY_GPU_B");

  // 10,000 TDX to each persona and to LENDING_POOL
  const tdxRecipients: AccountName[] = ["ALICE", "BOB", "CAROL", "DEV", "LENDING_POOL"];
  for (const acct of tdxRecipients) {
    await ensureTokenSupply(tdxIssuer, wallets[acct], "TDX", "10000", acct);
  }

  // Step 5: Initial DEX Sell Offers
  // Shares: start at 5.000000 TDX per share
  // Contracts: start at 0.250000 TDX per slot
  await ensureInitialOffer(
    wallets.TREASURY_GPU_A,
    { currency: "GPA", issuer: shareIssuer.address, value: "1000" },
    { currency: "TDX", issuer: tdxIssuer.address, value: "5000" },
    "TREASURY_GPU_A (GPA 1000 @ 5.0 TDX)"
  );

  await ensureInitialOffer(
    wallets.TREASURY_GPU_B,
    { currency: "GPB", issuer: shareIssuer.address, value: "1000" },
    { currency: "TDX", issuer: tdxIssuer.address, value: "5000" },
    "TREASURY_GPU_B (GPB 1000 @ 5.0 TDX)"
  );

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

  console.log("setupNetwork completed successfully!");
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
