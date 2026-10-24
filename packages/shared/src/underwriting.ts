// Shapes for the underwriting services and the api routes built on them.
// Sources of truth: contracts/credit (Lucy, :7100), contracts/risk
// (Kristian, :7000), contracts/pricing (Tharun, :6000), contracts/api.
// Money is a 6-decimal string; ratios (ltv, apr, pd) are decimal fractions.

import type { DecimalString, IsoDateTime } from "./types";
import type { LedgerLoan, VaultState, LoanBrokerState, TxResultLite } from "./lending";

export type DataSource = "live" | "mock" | "mock-fallback";

// --- credit (Lucy) ---------------------------------------------------------

export interface CreditFeature {
  value: number | string;
  points: number;
  reason: string;
  txHashes: string[];
}

export interface CreditProfile {
  address: string;
  network: string;
  readOnly: boolean;
  source: string;
  simulated: boolean;
  score: number;
  grade: "A" | "B" | "C" | "D" | "E";
  confidence: "low" | "medium" | "high";
  features: Record<string, CreditFeature>;
  reasons: string[];
  portfolio?: { grade: string; defaultRatePct: string; loans: number; text: string; simulated: boolean } | null;
  asOf: IsoDateTime;
}

export interface CreditEvent {
  id: string;
  kind: "LARGE_OUTFLOW" | "MISSED_PAYMENT" | "MS_REPAY" | "MS_LOAN_DISBURSE" | "MARGIN_CALL" | "LIQUIDATION" | string;
  severity: string;
  network: string;
  address: string;
  txHash: string | null;
  amount: string | null;
  currency: string | null;
  detail: string;
  ledgerIndex: number | null;
  at: IsoDateTime;
  via: string;
  simulated: boolean;
}

// --- risk (Kristian) -------------------------------------------------------

export interface RevenueBucket {
  start: IsoDateTime;
  end: IsoDateTime;
  revenue: DecimalString;
  bookedMinutes: number;
  inferenceMinutes: number;
  idleMinutes: number;
  utilizationPct: DecimalString;
  simulated: boolean;
}

export interface PricePoint {
  timestamp: IsoDateTime;
  price: DecimalString;
}

export interface RiskCreditProfile {
  address: string;
  network: string;
  score: number;
  grade: string;
  confidence: number; // 0..1 (low 0.3, medium 0.6, high 0.9)
  features: Record<string, unknown>;
  evidence: { feature: string; txHash: string }[];
  reasons: string[];
}

export interface RiskQuoteRequest {
  borrower: string;
  gpuId: string;
  collateralShares: DecimalString;
  principal: DecimalString;
  termSeconds: number;
  creditProfile: RiskCreditProfile;
  revenueHistory: RevenueBucket[];
  collateralPrice: DecimalString;
  collateralPriceHistory: PricePoint[];
}

export interface RiskQuote {
  decision: "approve" | "decline";
  ltv: string;
  maxLtv: string;
  apr: string;
  marginCallLtv: string;
  liquidationLtv: string;
  termSeconds: number;
  paymentIntervalSeconds: number;
  pd: string;
  pdLabel: string;
  expectedLoss: DecimalString;
  coverageRatio: string;
  reasons: string[];
}

export interface ScenarioRunRequest {
  gpuPriceShockPct: number;
  utilizationShockPct?: number;
  defaultRateMultiplier?: number;
}

export interface ScenarioRunResponse {
  loans: { loanId: string; ltv: string; state: "HEALTHY" | "MARGIN_CALL" | "LIQUIDATE" | string; simulated: boolean }[];
  marginCalls: number;
  liquidations: number;
  vaultLoss: DecimalString;
  firstLossCoverAbsorbed: DecimalString;
  lenderApyBefore: string;
  lenderApyAfter: string;
  simulated: boolean;
}

export interface BookStats {
  periodDays: number;
  borrowers: number;
  grades: {
    grade: string;
    loans: number;
    defaultRate: string;
    marginCallRate: string;
    cureRate: string;
    outcomes: { repaidOnTime: number; late: number; marginCalledThenCured: number; liquidated: number };
    simulated: boolean;
  }[];
  simulated: boolean;
}

// GET /internal/loans, the keeper's view.
export interface KeeperLoan {
  loanId: string;
  borrower: string;
  gpuId: string;
  collateralShares: DecimalString;
  outstandingBalance: DecimalString;
  apr: string;
  pd: string;
  status: string;
  marginCallLtv: string;
  liquidationLtv: string;
  marginCallAt: IsoDateTime | null;
  simulated: boolean;
}

export interface KeeperActionBody {
  idempotencyKey: string;
  observedLtv: string;
  threshold: string;
  occurredAt: IsoDateTime;
  reason: string;
}

// --- pricing agent (Tharun) ------------------------------------------------

export interface AgentText {
  text: string;
  modelId: string | null;
  latencyMs: number;
  fellBack: boolean; // true = deterministic fallback, not Bedrock
  source: DataSource;
}

// --- api routes ------------------------------------------------------------

export type XlsLoanStatus = "open" | "margin_call" | "repaid" | "liquidated" | "defaulted";

export interface LoanQuoteApiRequest {
  borrower: string; // AccountName (ALICE) or address
  gpuId: string;
  collateralShares: DecimalString;
  principal: DecimalString;
  termSeconds?: number;
}

export interface Xls66Terms {
  interestRateTenthBps: number;
  paymentTotal: number;
  paymentIntervalSeconds: number;
  gracePeriodSeconds: number;
  termSeconds: number;
}

export interface LoanQuoteApiResponse {
  quoteId: string;
  expiresAt: IsoDateTime;
  borrower: string;
  borrowerAddress: string;
  gpuId: string;
  collateralShares: DecimalString;
  principal: DecimalString;
  collateralPrice: DecimalString;
  collateralValue: DecimalString;
  quote: RiskQuote;
  terms: Xls66Terms;
  credit: CreditProfile;
  memo: AgentText;
  revenue24h: DecimalString;
  sources: { credit: DataSource; risk: DataSource; memo: DataSource; revenue: DataSource; oracle: DataSource };
}

export interface XlsLoanRecord {
  id: string;
  network: string;
  borrower: string;
  borrowerAddress: string;
  gpuId: string;
  collateralShares: DecimalString;
  principal: DecimalString;
  apr: string;
  marginCallLtv: string;
  liquidationLtv: string;
  pd: string;
  status: XlsLoanStatus;
  openedAt: IsoDateTime;
  marginCallAt: IsoDateTime | null;
  liquidatedAt: IsoDateTime | null;
  round: number;
  txs: Record<string, string>; // step -> hash (escrow, loanSet, pay, release, marginCall, seize, default)
  ledger: LedgerLoan | null; // live ledger view, null once deleted
  health: { collateralPrice: DecimalString; collateralValue: DecimalString; ltv: string } | null;
  simulated: boolean;
}

export interface VaultOverview {
  network: string;
  simulated: boolean;
  investing: (VaultState & { broker: LoanBrokerState | null }) | null;
  subscribing: (VaultState & { broker: LoanBrokerState | null }) | null;
  rounds: VaultState[];
}

export interface StressResult {
  gpuId: string;
  priceBefore: DecimalString;
  priceAfter: DecimalString;
  oracleTx: TxResultLite | null;
  scenario: ScenarioRunResponse;
  actions: { loanId: string; action: "margin_call" | "liquidate"; ltv: string; tx: TxResultLite | null; alert?: AgentText }[];
}
