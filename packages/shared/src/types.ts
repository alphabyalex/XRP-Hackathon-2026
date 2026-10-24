// Shared request/response types for A9.1 (xrpl) through A9.4 (api).
// Keep this file, docs/CONTRACTS.md, and contracts/*.json in sync.
// Money is always a decimal string (<=6 decimals) or XRP drops string, never a float.

import type { GpuId } from "./constants";

export type AccountName =
  | "TDX_ISSUER"
  | "SHARE_ISSUER"
  | "CONTRACT_ISSUER"
  | "TREASURY_GPU_A"
  | "TREASURY_GPU_B"
  | "PROTOCOL_FEES"
  | "LENDING_POOL"
  | "ORACLE"
  | "ALICE"
  | "BOB"
  | "CAROL"
  | "DEV";

export type IsoDateTime = string; // ISO 8601 UTC
export type DecimalString = string; // e.g. "12.500000", at most 6 decimals
export type DropsString = string; // XRP amount in drops, as a string

export type Amount =
  | DropsString
  | { currency: string; issuer: string; value: DecimalString };

// ---------------------------------------------------------------------------
// A9.1 packages/xrpl (owner Tharun, consumer apps/api)
// ---------------------------------------------------------------------------

export interface TxResult {
  hash: string;
  result: string;
  validated: boolean;
  explorerUrl: string;
}

export interface AccountsFile {
  [account: string]: { address: string };
}

export interface Offer {
  account: string;
  seq: number;
  takerGets: Amount;
  takerPays: Amount;
}

export interface Balances {
  xrp: DecimalString;
  tokens: Record<string, DecimalString>;
}

export interface Holder {
  account: string;
  shares: DecimalString;
}

export interface BuySharesParams {
  buyer: AccountName;
  gpuId: GpuId;
  qty: DecimalString;
  maxPricePerShare: DecimalString;
}

export interface SellSharesParams {
  seller: AccountName;
  gpuId: GpuId;
  qty: DecimalString;
  pricePerShare: DecimalString;
}

export interface BuyContractsParams {
  buyer: AccountName;
  gpuId: GpuId;
  qty: DecimalString;
  maxPrice: DecimalString;
}

export interface RedeemContractsParams {
  holder: AccountName;
  gpuId: GpuId;
  qty: DecimalString;
  slotStart: IsoDateTime;
}

export interface RedeemContractsResult extends TxResult {
  redemptionId: string;
}

export interface PayForInferenceParams {
  payer: AccountName;
  gpuId: GpuId;
  amount: DecimalString;
  memo: string;
}

export interface DividendPayout {
  account: string;
  amount: DecimalString;
}

export interface PayDividendsParams {
  gpuId: GpuId;
  payouts: DividendPayout[];
  hostingFee: DecimalString;
}

export interface OpenLoanParams {
  borrower: AccountName;
  gpuId: GpuId;
  collateralShares: DecimalString;
  principal: DecimalString;
  dueAt: IsoDateTime;
}

export interface OpenLoanResult {
  loanId: string;
  escrowTx: TxResult;
  disburseTx: TxResult;
}

export interface PublishOracleParams {
  gpuId: GpuId;
  navPerShare: DecimalString;
  gpuHourPrice: DecimalString;
  utilizationPct: DecimalString;
}

// ---------------------------------------------------------------------------
// A9.2 services/compute (owner Kristian, consumer apps/api)
// ---------------------------------------------------------------------------

export type GpuState = "READY" | "SERVING" | "DRAINING" | "BOOKED" | "OFFLINE";

export interface ComputeGpuStatus {
  id: GpuId;
  state: GpuState;
  model: string;
  simulated: boolean;
  tokens_per_sec: number;
  utilization_pct_1h: number;
}

export type CalendarKind = "BOOKED" | "INFERENCE" | "HOLD";

export interface CalendarEntry {
  start: IsoDateTime;
  end: IsoDateTime;
  kind: CalendarKind;
  ref: string | null;
}

export type ComputeErrorCode =
  | "GPU_BOOKED"
  | "NO_ELIGIBLE_GPU"
  | "INSUFFICIENT_RUNWAY"
  | "PRICE_CAP_EXCEEDED"
  | "UPSTREAM_ERROR";

export interface ComputeErrorBody {
  error: { code: ComputeErrorCode; message: string };
}

export interface ChatCompletionRequest {
  model?: string;
  messages: { role: "system" | "user" | "assistant"; content: string }[];
  stream?: boolean;
  [key: string]: unknown; // OpenAI-compatible passthrough
}

export interface ChatCompletionExtra {
  request_id: string;
  gpu_id: GpuId;
  model: string;
  input_tokens: number;
  output_tokens: number;
  charge: DecimalString;
  routed_reason: string;
  simulated: boolean;
}

export interface ChatCompletionResponse {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: {
    index: number;
    message: { role: "assistant"; content: string };
    finish_reason: string;
  }[];
  x_ms: ChatCompletionExtra;
}

export interface BookingRequest {
  gpu_id: GpuId;
  slot_start: IsoDateTime;
  slots: number;
  redemption_id: string;
  holder: string;
}

export interface BookingResponse {
  booking_id: string;
}

export interface UsageEvent {
  request_id: string;
  gpu_id: GpuId;
  buyer: string;
  booking_id: string | null;
  input_tokens: number;
  output_tokens: number;
  charge: DecimalString;
  started_at: IsoDateTime;
  finished_at: IsoDateTime;
  simulated?: boolean;
}

// ---------------------------------------------------------------------------
// A9.3 services/pricing (owner Lucy, consumer apps/api)
// ---------------------------------------------------------------------------

export interface InferenceRatesResponse {
  input_per_mtok: DecimalString;
  output_per_mtok: DecimalString;
  base_fee: DecimalString;
  currency: "TDX";
  valid_until: IsoDateTime;
  inputs: Record<string, unknown>;
}

export interface ContractPriceResponse {
  price_per_slot: DecimalString;
  slot_minutes: number;
  reference_hourly_usd: DecimalString;
  components: Record<string, unknown>;
  valid_until: IsoDateTime;
  sources: string[];
}

export interface NavResponse {
  nav_per_share: DecimalString;
  treasury_cash: DecimalString;
  pv_future_net: DecimalString;
  utilization_assumption: DecimalString;
  trailing_revenue_24h: DecimalString;
  implied_yield_pct: DecimalString;
  inputs: Record<string, unknown>;
}

export interface DividendsProposeRequest {
  gpu_id: GpuId;
  period_start: IsoDateTime;
  period_end: IsoDateTime;
  gross_revenue: DecimalString;
  holders: { account: string; shares: DecimalString }[];
}

export interface DividendsProposeResponse {
  hosting_fee: DecimalString;
  reserve: DecimalString;
  distributable: DecimalString;
  payouts: DividendPayout[];
  dust: DecimalString;
  explanation: string;
  risk_flags: string[];
}

export interface LoanQuoteRequest {
  gpu_id: GpuId;
  shares: DecimalString;
}

export interface LoanQuoteResponse {
  collateral_value: DecimalString;
  max_principal: DecimalString;
  apr_bps: number;
  liquidation_value: DecimalString;
  term_minutes: number;
}

export type AgentExplainContext = "dividend" | "nav" | "loan";

export interface AgentExplainRequest {
  context: AgentExplainContext;
  data: Record<string, unknown>;
}

export interface AgentExplainResponse {
  text: string;
  risk_flags: string[];
}

// ---------------------------------------------------------------------------
// A9.4 apps/api (owner Alexander, consumer apps/web and services)
// ---------------------------------------------------------------------------

export interface ApiGpuSummary {
  id: GpuId;
  label: string;
  hw: string;
  model: string;
  state: GpuState;
  simulated: boolean;
  sharePrice: DecimalString;
  navPerShare: DecimalString;
  revenue24h: DecimalString;
  utilizationPct: DecimalString;
  impliedYieldPct: DecimalString;
  holdersCount: number;
}

export interface ApiGpuDetail extends ApiGpuSummary {
  calendar: CalendarEntry[];
  recentRequests: UsageEvent[];
  holders: Holder[];
  oracle: {
    navPerShare: DecimalString;
    gpuHourPrice: DecimalString;
    utilizationPct: DecimalString;
    publishedAt: IsoDateTime | null;
  };
}

export interface PortfolioResponse {
  account: string;
  tdxBalance: DecimalString;
  shares: { gpuId: GpuId; qty: DecimalString }[];
  contracts: { gpuId: GpuId; qty: DecimalString }[];
  dividendsReceived: DecimalString;
  loans: LoanRecord[];
}

export interface TxLogEntry {
  hash: string;
  kind: string;
  account: string;
  summary: string;
  explorerUrl: string;
  createdAt: IsoDateTime;
}

export interface BuySharesBody {
  buyer: string;
  gpuId: GpuId;
  qty: DecimalString;
}

export interface SellSharesBody {
  seller: string;
  gpuId: GpuId;
  qty: DecimalString;
  price: DecimalString;
}

export interface BuyContractsBody {
  buyer: string;
  gpuId: GpuId;
  qty: DecimalString;
}

export interface RedeemContractsBody {
  holder: string;
  gpuId: GpuId;
  qty: DecimalString;
  slotStart: IsoDateTime;
}

export interface RedeemContractsResponse {
  redemptionId: string;
  bookingId: string;
  slotStart: IsoDateTime;
  slotEnd: IsoDateTime;
}

export interface InferenceChatBody {
  buyer?: string; // defaults to "DEV"
  bookingId?: string;
  messages: ChatCompletionRequest["messages"];
}

export interface LoansOpenBody {
  borrower: string;
  gpuId: GpuId;
  collateralShares: DecimalString;
}

export type LoanStatus = "open" | "repaid" | "defaulted";

export interface LoanRecord {
  id: string;
  borrower: string;
  gpuId: GpuId;
  collateralShares: DecimalString;
  principal: DecimalString;
  dueAt: IsoDateTime;
  status: LoanStatus;
  escrowTx: string | null;
  disburseTx: string | null;
  settleTx: string | null;
}

export interface DividendRun {
  id: string;
  gpuId: GpuId;
  periodStart: IsoDateTime;
  periodEnd: IsoDateTime;
  grossRevenue: DecimalString;
  hostingFee: DecimalString;
  reserve: DecimalString;
  distributable: DecimalString;
  status: "proposed" | "approved" | "paid" | "failed";
  explanation: string;
  createdAt: IsoDateTime;
  payouts?: DividendPayout[];
}

export interface AdminDividendsProposeBody {
  gpuId: GpuId;
}

// SSE event payloads on GET /events
export type SseEventType = "usage" | "tx" | "calendar" | "dividend" | "loan" | "vault" | "credit" | "risk";

export interface SseEvent<T = unknown> {
  type: SseEventType;
  data: T;
}
