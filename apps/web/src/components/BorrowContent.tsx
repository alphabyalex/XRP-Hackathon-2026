"use client";
import { useEffect, useState } from "react";
import type { PortfolioResponse } from "@moonshift/shared";
import { getPortfolio, repayLoan } from "@/lib/api";
import { fmt, txToastLine } from "@/lib/format";
import { BorrowPanel } from "./BorrowPanel";
import { Button } from "./Button";
import { useToast } from "./Toast";
import { ACCOUNT } from "@/lib/session";

function countdown(dueAt: string): string {
  const ms = new Date(dueAt).getTime() - Date.now();
  if (ms <= 0) return "due now";
  const m = Math.floor(ms / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  return `${m}m ${s}s`;
}

export function BorrowContent({
  initialPortfolio,
  gpuId,
  gpuLabel,
  sharePrice,
}: {
  initialPortfolio: PortfolioResponse;
  gpuId: string;
  gpuLabel: string;
  sharePrice: number;
}) {
  const [portfolio, setPortfolio] = useState(initialPortfolio);
  const [now, setNow] = useState(Date.now());
  const [busy, setBusy] = useState(false);
  const toast = useToast();

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  async function refresh() {
    setPortfolio(await getPortfolio(ACCOUNT));
  }

  const openLoan = portfolio.loans.find((l) => l.status === "open");

  async function doRepay() {
    if (!openLoan || busy) return;
    setBusy(true);
    try {
      const loan = await repayLoan(openLoan.id);
      toast("Repaid loan", txToastLine(`${fmt(Number(loan.principal), 2)} USDC`, loan.settleTx ?? loan.disburseTx ?? ""));
      await refresh();
    } catch (err) {
      toast("Repay failed", (err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="s">
      <div className="wrap">
        <div className="shead">
          <h2>Borrow without selling.</h2>
          <p>Lock your shares in an XRPL escrow and borrow up to half their value in USDC. Locked shares keep earning their nightly payout.</p>
        </div>

        {openLoan ? (
          <div className="trade" style={{ padding: 30, maxWidth: 480, marginBottom: 56 }}>
            <span className="lbl">Open loan on {openLoan.gpuId.toUpperCase()}</span>
            <div className="bignum">{fmt(Number(openLoan.principal), 2)} USDC</div>
            <div className="line">
              <span>Collateral</span>
              <b>
                {openLoan.collateralShares} {openLoan.gpuId.toUpperCase().replace("GPU-", "GP")}
              </b>
            </div>
            <div className="line">
              <span>Due in</span>
              <b key={now}>{countdown(openLoan.dueAt)}</b>
            </div>
            <Button disabled={busy} onClick={doRepay}>
              Repay {fmt(Number(openLoan.principal), 2)} USDC
            </Button>
          </div>
        ) : (
          <BorrowPanel gpuId={gpuId} gpuLabel={gpuLabel} sharePrice={sharePrice} onBorrowed={refresh} />
        )}
      </div>
    </main>
  );
}
