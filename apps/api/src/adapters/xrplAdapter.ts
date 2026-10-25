// Adapter over packages/xrpl. MOCK_XRPL=1 (default) uses an in-memory mock
// ledger that behaves consistently across calls. MOCK_XRPL=0 calls the real
// packages/xrpl functions on the active NETWORK (devnet or testnet).
// Lending (XLS-65/66) lives in ./lendingAdapter.ts.

import { randomBytes } from "crypto";
import * as realXrpl from "@moonshift/xrpl";
import { GPUS, explorerUrl, treasuryOf, type GpuId } from "@moonshift/shared";
import type {
  AccountName,
  AccountsFile,
  Balances,
  Holder,
  Offer,
  TxResult,
  BuySharesParams,
  SellSharesParams,
  BuyContractsParams,
  RedeemContractsParams,
  RedeemContractsResult,
  PayForInferenceParams,
  PayDividendsParams,
  OpenLoanParams,
  OpenLoanResult,
  PublishOracleParams,
} from "@moonshift/shared";

const MOCK = process.env.MOCK_XRPL !== "0";

function fakeHash(): string {
  return "MOCK" + randomBytes(30).toString("hex").toUpperCase();
}

function mockTx(result = "tesSUCCESS"): TxResult {
  const hash = fakeHash();
  return { hash, result, validated: true, explorerUrl: explorerUrl(hash) };
}

// --- in-memory mock ledger state -------------------------------------------

interface MockLoan {
  borrower: string;
  gpuId: GpuId;
  collateralShares: string;
  principal: string;
  repaid: boolean;
}

const tdxBalances = new Map<string, number>();
const shareHoldings = new Map<GpuId, Map<string, number>>();
const contractHoldings = new Map<GpuId, Map<string, number>>();
const loanRegistry = new Map<string, MockLoan>();
const oracleState = new Map<GpuId, { navPerShare: string; gpuHourPrice: string; utilizationPct: string; publishedAt: string }>();

const SHARE_PRICE = "1.050000"; // flat mock price, pricing service owns the real number
const CONTRACT_PRICE = "0.410000";

function treasuryFor(gpuId: GpuId): string {
  return treasuryOf(gpuId);
}

function ensureGpuMaps(gpuId: GpuId) {
  if (!shareHoldings.has(gpuId)) shareHoldings.set(gpuId, new Map());
  if (!contractHoldings.has(gpuId)) contractHoldings.set(gpuId, new Map());
}

function getBal(map: Map<string, number>, key: string): number {
  return map.get(key) ?? 0;
}

function initMockLedger() {
  tdxBalances.clear();
  shareHoldings.clear();
  contractHoldings.clear();
  loanRegistry.clear();
  oracleState.clear();

  const personas = ["ALICE", "BOB", "CAROL", "DEV"];
  for (const p of personas) tdxBalances.set(p, 1000);
  tdxBalances.set("LENDING_POOL", 5000);
  tdxBalances.set("PROTOCOL_FEES", 0);

  for (const gpu of GPUS) {
    ensureGpuMaps(gpu.id);
    shareHoldings.get(gpu.id)!.set(treasuryFor(gpu.id), gpu.sharesTotal);
    contractHoldings.get(gpu.id)!.set(treasuryFor(gpu.id), 10000); // plenty of contract supply for the demo
    tdxBalances.set(treasuryFor(gpu.id), 0);
  }
}
initMockLedger();

export function resetMockLedger(): void {
  initMockLedger();
}

// --- adapter functions, matching A9.1 exactly -------------------------------

export async function setupNetwork(): Promise<AccountsFile> {
  if (!MOCK) return realXrpl.setupNetwork();
  resetMockLedger();
  const accounts: AccountsFile = {};
  const names: AccountName[] = [
    "TDX_ISSUER",
    "SHARE_ISSUER",
    "CONTRACT_ISSUER",
    ...GPUS.map((g) => treasuryOf(g.id)),
    "PROTOCOL_FEES",
    "LENDING_POOL",
    "ORACLE",
    "ALICE",
    "BOB",
    "CAROL",
    "DEV",
  ];
  for (const n of names) accounts[n] = { address: `MOCK_ADDR_${n}` };
  return accounts;
}

export async function getBalances(account: AccountName): Promise<Balances> {
  if (!MOCK) return realXrpl.getBalances(account);
  const tokens: Record<string, string> = {};
  for (const gpu of GPUS) {
    const shares = getBal(shareHoldings.get(gpu.id) ?? new Map(), account);
    const contracts = getBal(contractHoldings.get(gpu.id) ?? new Map(), account);
    if (shares) tokens[gpu.shareCode] = String(shares);
    if (contracts) tokens[gpu.contractCode] = String(contracts);
  }
  const tdx = tdxBalances.get(account) ?? 0;
  if (tdx) tokens.TDX = tdx.toFixed(6);
  return { xrp: "1000.000000", tokens };
}

export async function getHolders(gpuId: GpuId): Promise<Holder[]> {
  if (!MOCK) return realXrpl.getHolders(gpuId);
  ensureGpuMaps(gpuId);
  const treasury = treasuryFor(gpuId);
  const out: Holder[] = [];
  for (const [account, qty] of shareHoldings.get(gpuId)!.entries()) {
    if (account === treasury || qty <= 0) continue;
    out.push({ account, shares: String(qty) });
  }
  return out;
}

export async function listShareOffers(gpuId: GpuId): Promise<Offer[]> {
  if (!MOCK) return realXrpl.listShareOffers(gpuId);
  const gpu = GPUS.find((g) => g.id === gpuId);
  if (!gpu) return [];
  const treasury = treasuryFor(gpuId);
  const available = getBal(shareHoldings.get(gpuId) ?? new Map(), treasury);
  return [
    {
      account: treasury,
      seq: 1,
      takerGets: { currency: gpu.shareCode, issuer: "MOCK_SHARE_ISSUER", value: String(available) },
      takerPays: String(Math.round(available * Number(SHARE_PRICE) * 1_000_000)),
    },
  ];
}

// Share prices from the DEX order book (the mock ledger has a flat price and no bids).
export async function getShareBook(gpuId: GpuId): Promise<realXrpl.ShareBook> {
  if (!MOCK) return realXrpl.getShareBook(gpuId);
  return { bestBid: null, bestAsk: Number(SHARE_PRICE).toFixed(6) };
}

// Every funded offer on both sides of the book (none on the mock ledger).
export async function getShareDepth(gpuId: GpuId): Promise<realXrpl.ShareDepth> {
  if (!MOCK) return realXrpl.getShareDepth(gpuId);
  return { bids: [], asks: [] };
}

export async function shareFill(hash: string, address: string, gpuId: GpuId) {
  if (!MOCK) return realXrpl.shareFill(hash, address, gpuId);
  return null;
}

export async function requoteShareOffer(p: Parameters<typeof realXrpl.requoteShareOffer>[0]) {
  if (!MOCK) return realXrpl.requoteShareOffer(p);
  return { action: "skipped" as const, price: p.price, hashes: [] as string[] };
}

export async function requoteShareLadder(p: Parameters<typeof realXrpl.requoteShareLadder>[0]) {
  if (!MOCK) return realXrpl.requoteShareLadder(p);
  throw new Error("Live liquidity requires the real ledger");
}

export async function buyShares(p: BuySharesParams): Promise<TxResult> {
  if (!MOCK) return realXrpl.buyShares(p);
  ensureGpuMaps(p.gpuId);
  const treasury = treasuryFor(p.gpuId);
  const qty = Number(p.qty);
  const cost = qty * Number(SHARE_PRICE);
  const buyerBal = tdxBalances.get(p.buyer) ?? 0;
  if (buyerBal < cost) return mockTx("tecUNFUNDED_PAYMENT");

  const shares = shareHoldings.get(p.gpuId)!;
  const treasuryShares = getBal(shares, treasury);
  if (treasuryShares < qty) return mockTx("tecINSUFFICIENT_FUNDS");

  shares.set(treasury, treasuryShares - qty);
  shares.set(p.buyer, getBal(shares, p.buyer) + qty);
  tdxBalances.set(p.buyer, buyerBal - cost);
  tdxBalances.set(treasury, (tdxBalances.get(treasury) ?? 0) + cost);
  return mockTx();
}

export async function sellShares(p: SellSharesParams): Promise<TxResult> {
  if (!MOCK) return realXrpl.sellShares(p);
  ensureGpuMaps(p.gpuId);
  const treasury = treasuryFor(p.gpuId);
  const qty = Number(p.qty);
  const proceeds = qty * Number(p.pricePerShare);

  const shares = shareHoldings.get(p.gpuId)!;
  const sellerShares = getBal(shares, p.seller);
  if (sellerShares < qty) return mockTx("tecINSUFFICIENT_FUNDS");

  shares.set(p.seller, sellerShares - qty);
  shares.set(treasury, getBal(shares, treasury) + qty);
  tdxBalances.set(p.seller, (tdxBalances.get(p.seller) ?? 0) + proceeds);
  tdxBalances.set(treasury, (tdxBalances.get(treasury) ?? 0) - proceeds);
  return mockTx();
}

export async function listContractOffers(gpuId: GpuId): Promise<Offer[]> {
  if (!MOCK) return realXrpl.listContractOffers(gpuId);
  const gpu = GPUS.find((g) => g.id === gpuId);
  if (!gpu) return [];
  const treasury = treasuryFor(gpuId);
  const available = getBal(contractHoldings.get(gpuId) ?? new Map(), treasury);
  return [
    {
      account: treasury,
      seq: 2,
      takerGets: { currency: gpu.contractCode, issuer: "MOCK_CONTRACT_ISSUER", value: String(available) },
      takerPays: String(Math.round(available * Number(CONTRACT_PRICE) * 1_000_000)),
    },
  ];
}

export async function buyContracts(p: BuyContractsParams): Promise<TxResult> {
  if (!MOCK) return realXrpl.buyContracts(p);
  ensureGpuMaps(p.gpuId);
  const treasury = treasuryFor(p.gpuId);
  const qty = Number(p.qty);
  const cost = qty * Number(CONTRACT_PRICE);
  const buyerBal = tdxBalances.get(p.buyer) ?? 0;
  if (buyerBal < cost) return mockTx("tecUNFUNDED_PAYMENT");

  const contracts = contractHoldings.get(p.gpuId)!;
  const treasuryContracts = getBal(contracts, treasury);
  if (treasuryContracts < qty) return mockTx("tecINSUFFICIENT_FUNDS");

  contracts.set(treasury, treasuryContracts - qty);
  contracts.set(p.buyer, getBal(contracts, p.buyer) + qty);
  tdxBalances.set(p.buyer, buyerBal - cost);
  tdxBalances.set(treasury, (tdxBalances.get(treasury) ?? 0) + cost);
  return mockTx();
}

export async function redeemContracts(p: RedeemContractsParams): Promise<RedeemContractsResult> {
  if (!MOCK) return realXrpl.redeemContracts(p);
  ensureGpuMaps(p.gpuId);
  const contracts = contractHoldings.get(p.gpuId)!;
  const qty = Number(p.qty);
  const held = getBal(contracts, p.holder);
  if (held < qty) {
    const tx = mockTx("tecINSUFFICIENT_FUNDS");
    return { ...tx, redemptionId: "" };
  }
  contracts.set(p.holder, held - qty); // burn
  const tx = mockTx();
  return { ...tx, redemptionId: `redemption_${fakeHash().slice(0, 12)}` };
}

export async function payForInference(p: PayForInferenceParams): Promise<TxResult> {
  if (!MOCK) return realXrpl.payForInference(p);
  const treasury = treasuryFor(p.gpuId);
  const amount = Number(p.amount);
  const payerBal = tdxBalances.get(p.payer) ?? 0;
  tdxBalances.set(p.payer, payerBal - amount);
  tdxBalances.set(treasury, (tdxBalances.get(treasury) ?? 0) + amount);
  return mockTx();
}

export async function payDividends(p: PayDividendsParams): Promise<TxResult[]> {
  if (!MOCK) return realXrpl.payDividends(p);
  const treasury = treasuryFor(p.gpuId);
  const results: TxResult[] = [];
  for (const payout of p.payouts) {
    const amount = Number(payout.amount);
    tdxBalances.set(payout.account, (tdxBalances.get(payout.account) ?? 0) + amount);
    tdxBalances.set(treasury, (tdxBalances.get(treasury) ?? 0) - amount);
    results.push(mockTx());
  }
  const fee = Number(p.hostingFee);
  tdxBalances.set("PROTOCOL_FEES", (tdxBalances.get("PROTOCOL_FEES") ?? 0) + fee);
  tdxBalances.set(treasury, (tdxBalances.get(treasury) ?? 0) - fee);
  results.push(mockTx());
  return results;
}

export async function openLoan(p: OpenLoanParams): Promise<OpenLoanResult> {
  if (!MOCK) return realXrpl.openLoan(p);
  ensureGpuMaps(p.gpuId);
  const shares = shareHoldings.get(p.gpuId)!;
  const qty = Number(p.collateralShares);
  const held = getBal(shares, p.borrower);
  const escrowTx = mockTx(held < qty ? "tecINSUFFICIENT_FUNDS" : "tesSUCCESS");
  if (held < qty) {
    // Same as the real ledger: no collateral escrowed, so no money goes out.
    return { loanId: "", escrowTx, disburseTx: escrowTx };
  }
  shares.set(p.borrower, held - qty); // lock as escrow collateral
  const principal = Number(p.principal);
  tdxBalances.set(p.borrower, (tdxBalances.get(p.borrower) ?? 0) + principal);
  tdxBalances.set("LENDING_POOL", (tdxBalances.get("LENDING_POOL") ?? 0) - principal);
  const disburseTx = mockTx();

  const loanId = `loan_${fakeHash().slice(0, 12)}`;
  loanRegistry.set(loanId, {
    borrower: p.borrower,
    gpuId: p.gpuId,
    collateralShares: p.collateralShares,
    principal: p.principal,
    repaid: false,
  });
  return { loanId, escrowTx, disburseTx };
}

export async function repayLoan(p: { loanId: string }): Promise<TxResult> {
  if (!MOCK) return realXrpl.repayLoan(p);
  const loan = loanRegistry.get(p.loanId);
  if (!loan) return mockTx("tecNO_ENTRY");
  const principal = Number(loan.principal);
  const borrowerBal = tdxBalances.get(loan.borrower) ?? 0;
  if (borrowerBal < principal) return mockTx("tecUNFUNDED_PAYMENT");
  tdxBalances.set(loan.borrower, borrowerBal - principal);
  tdxBalances.set("LENDING_POOL", (tdxBalances.get("LENDING_POOL") ?? 0) + principal);
  loan.repaid = true;
  return mockTx();
}

export async function settleLoan(p: { loanId: string }): Promise<TxResult> {
  if (!MOCK) return realXrpl.settleLoan(p);
  const loan = loanRegistry.get(p.loanId);
  if (!loan) return mockTx("tecNO_ENTRY");
  ensureGpuMaps(loan.gpuId);
  const shares = shareHoldings.get(loan.gpuId)!;
  const qty = Number(loan.collateralShares);
  if (loan.repaid) {
    // EscrowCancel equivalent: collateral goes back to the borrower.
    shares.set(loan.borrower, getBal(shares, loan.borrower) + qty);
  } else {
    // EscrowFinish with default fulfillment: collateral goes to the pool.
    shares.set("LENDING_POOL", getBal(shares, "LENDING_POOL") + qty);
  }
  return mockTx();
}

export async function publishOracle(p: PublishOracleParams): Promise<TxResult> {
  if (!MOCK) return realXrpl.publishOracle(p);
  oracleState.set(p.gpuId, {
    navPerShare: p.navPerShare,
    gpuHourPrice: p.gpuHourPrice,
    utilizationPct: p.utilizationPct,
    publishedAt: new Date().toISOString(),
  });
  return mockTx();
}

export function getOracle(gpuId: GpuId) {
  return (
    oracleState.get(gpuId) ?? {
      navPerShare: "0",
      gpuHourPrice: "0",
      utilizationPct: "0",
      publishedAt: null,
    }
  );
}

export async function subscribe(accounts: string[], onTx: (tx: unknown) => void): Promise<() => void> {
  if (!MOCK) return realXrpl.subscribe(accounts, onTx);
  void accounts;
  void onTx;
  // Mock mode pushes tx/SSE events directly from the route handlers instead.
  return async () => {};
}
