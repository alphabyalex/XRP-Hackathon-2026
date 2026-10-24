"use client";
// Small pieces shared by /borrow and /lend.
import { useState } from "react";
import clsx from "clsx";
import type { StressResult, XlsLoanRecord } from "@moonshift/shared";
import { fmt, shortHash } from "@/lib/format";
import { pct, restorePrice, stress, txUrl } from "@/lib/lendingApi";
import { Button } from "./Button";
import { useToast } from "./Toast";

export function TxLink({ network, hash, label }: { network: string; hash?: string | null; label?: string }) {
  if (!hash) return null;
  const url = txUrl(network, hash);
  const text = `${label ? `${label} ` : ""}${shortHash(hash)}`;
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
      <div className="meter-l">
        <span style={{ left: 0 }}>LTV {pct(ltv)}</span>
        <span style={{ left: at(marginCallLtv), transform: "translateX(-50%)" }}>margin call {pct(marginCallLtv, 0)}</span>
        <span style={{ left: at(liquidationLtv), transform: "translateX(-50%)", color: "var(--down)" }}>liquidation {pct(liquidationLtv, 0)}</span>
      </div>
    </div>
  );
}

const STEP_LABEL: Record<string, string> = {
  escrow: "Collateral escrow",
  loanSet: "LoanSet",
  pay: "LoanPay",
  pay2: "LoanPay",
  release: "Collateral release",
  delete: "LoanDelete",
  marginCall: "Margin call",
  seize: "Collateral seized",
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
}: {
  gpuId: string;
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
        `${gpuId.toUpperCase()} oracle ${fmt(Number(r.priceBefore), 2)} to ${fmt(Number(r.priceAfter), 2)} USDC · ${act ? `${act.action === "liquidate" ? "liquidation" : "margin call"} tx ${shortHash(act.tx?.hash ?? "")}` : "no loan crossed a line"}`
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
      toast("Oracle price restored", `${gpuId.toUpperCase()} ${fmt(Number(r.price), 2)} USDC per share · tx ${shortHash(r.tx.hash)}`);
      onDone?.(null);
    } catch (e) {
      toast("Restore failed", (e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className={clsx("stress", compact && "compact")}>
      <span className="lbl">Stress test (devnet oracle)</span>
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
            <span>Oracle price</span>
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
