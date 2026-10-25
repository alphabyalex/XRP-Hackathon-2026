"use client";
// Small pieces shared by /borrow and /lend.
import { useState } from "react";
import clsx from "clsx";
import type { StressResult, XlsLoanRecord } from "@moonshift/shared";
import { fmt, usdc } from "@/lib/format";
import { pct, restorePrice, stress, txUrl } from "@/lib/lendingApi";
import { Button } from "./Button";
import { useToast } from "./Toast";

export function TxLink({ network, hash, label }: { network: string; hash?: string | null; label?: string }) {
  if (!hash) return null;
  const url = txUrl(network, hash);
  const text = label ? `${label} · View transaction` : "View transaction";
  return url ? (
    <a className="txl" href={url} target="_blank" rel="noreferrer">
      {text}
    </a>
  ) : (
    <span className="txl">{text}</span>
  );
}

const STATUS_TEXT: Record<string, string> = {
  open: "Healthy",
  margin_call: "Margin call",
  liquidated: "Liquidated",
  defaulted: "Defaulted",
  repaid: "Repaid",
};

export function StatusChip({ status }: { status: string }) {
  return <span className={clsx("chip", `chip-${status}`)}>{STATUS_TEXT[status] ?? status}</span>;
}

// LTV meter with the margin call and liquidation lines from the risk quote.
export function HealthMeter({ ltv, marginCallLtv, liquidationLtv }: { ltv: number; marginCallLtv: number; liquidationLtv: number }) {
  const scale = Math.max(liquidationLtv * 1.25, ltv * 1.05, 0.01);
  const at = (x: number) => `${Math.min(100, (x / scale) * 100)}%`;
  const tone = ltv >= liquidationLtv ? "var(--down)" : ltv >= marginCallLtv ? "var(--accent)" : "var(--ink)";
  return (
    <div>
      <div className="meter">
        <div className="fill" style={{ width: at(ltv), background: tone }} />
        <span className="tick" style={{ left: at(marginCallLtv) }} />
        <span className="tick" style={{ left: at(liquidationLtv), background: "var(--down)" }} />
      </div>
      {/* A row, not labels pinned under the ticks: the two lines are often a few percent apart. */}
      <div className="meter-l">
        <span>LTV {pct(ltv)}</span>
        <span className="lines">
          <span>
            <i className="key" />
            margin call {pct(marginCallLtv, 0)}
          </span>
          <span style={{ color: "var(--down)" }}>
            <i className="key" style={{ background: "var(--down)" }} />
            liquidation {pct(liquidationLtv, 0)}
          </span>
        </span>
      </div>
    </div>
  );
}

const STEP_LABEL: Record<string, string> = {
  escrow: "Shares locked",
  loanSet: "Loan opened",
  pay: "Payment",
  pay2: "Payment",
  release: "Shares returned",
  delete: "Loan closed",
  marginCall: "Margin call",
  seize: "Shares taken",
  default: "Default",
};

export function LoanTxs({ loan }: { loan: XlsLoanRecord }) {
  return (
    <div className="txlist">
      {Object.entries(loan.txs).map(([k, h]) => (
        <TxLink key={k} network={loan.network} hash={h} label={STEP_LABEL[k] ?? k} />
      ))}
    </div>
  );
}

// "Crash GPU price" demo control: publishes a shocked price to the on-ledger
// oracle, runs the risk scenario, and lets the keeper fire.
export function StressControls({
  gpuId,
  loanId,
  onDone,
  compact,
  label = "Stress test",
}: {
  gpuId: string;
  label?: string;
  loanId?: string;
  onDone?: (r: StressResult | null) => void;
  compact?: boolean;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [last, setLast] = useState<StressResult | null>(null);
  const toast = useToast();

  async function run(level: "margin_call" | "liquidation") {
    setBusy(level);
    try {
      const r = await stress(gpuId, level, loanId);
      setLast(r);
      const act = r.actions[0];
      toast(
        level === "margin_call" ? "GPU price crashed toward the margin call line" : "GPU price crashed past liquidation",
        `${gpuId.toUpperCase()} ${usdc(r.priceBefore)} to ${usdc(r.priceAfter)} USDC per share${act ? "" : " · no loan crossed a line"}`,
        act?.tx?.hash
      );
      onDone?.(r);
    } catch (e) {
      toast("Stress test failed", (e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function restore() {
    setBusy("restore");
    try {
      const r = await restorePrice(gpuId);
      setLast(null);
      toast("Price restored", `${gpuId.toUpperCase()} ${usdc(r.price)} USDC per share`, r.tx.hash);
      onDone?.(null);
    } catch (e) {
      toast("Restore failed", (e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className={clsx("stress", compact && "compact")}>
      <span className="lbl">{label}</span>
      <div className="stress-btns">
        <Button size="sm" variant="ghost" disabled={!!busy} onClick={() => run("margin_call")}>
          {busy === "margin_call" ? "Crashing..." : "Crash price to margin call"}
        </Button>
        <Button size="sm" variant="ghost" disabled={!!busy} onClick={() => run("liquidation")}>
          {busy === "liquidation" ? "Crashing..." : "Crash price to liquidation"}
        </Button>
        <Button size="sm" variant="ghost" disabled={!!busy} onClick={restore}>
          {busy === "restore" ? "Restoring..." : "Restore price"}
        </Button>
      </div>
      {last && !compact && (
        <div className="facts" style={{ marginTop: 14 }}>
          <div>
            <span>Share price</span>
            <b>
              {fmt(Number(last.priceBefore), 2)} to {fmt(Number(last.priceAfter), 2)}
            </b>
          </div>
          <div>
            <span>Scenario (model estimate)</span>
            <b>
              {last.scenario.marginCalls} margin calls, {last.scenario.liquidations} liquidations
            </b>
          </div>
          <div>
            <span>Vault loss, cover absorbed (model estimate)</span>
            <b>
              {fmt(Number(last.scenario.vaultLoss), 2)} / {fmt(Number(last.scenario.firstLossCoverAbsorbed), 2)}
            </b>
          </div>
          {last.actions.map((a) => (
            <div key={a.loanId + a.action}>
              <span>
                {a.action === "liquidate" ? "Liquidated" : "Margin call"} at {pct(a.ltv)} LTV
              </span>
              <b>{a.tx ? <TxLink network={a.tx.hash.startsWith("MOCK") ? "mock" : "devnet"} hash={a.tx.hash} /> : "already handled"}</b>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
