"use client";
import { useState } from "react";
import type { PortfolioResponse, TxLogEntry } from "@moonshift/shared";
import type { GpuMap } from "@/lib/liveData";
import { getPortfolio, getTxLog, redeemSlots, repayLoan } from "@/lib/api";
import { fmt, shortHash, txToastLine } from "@/lib/format";
import { useToast } from "./Toast";
import { Button } from "./Button";
import { ACCOUNT } from "@/lib/session";

export function PortfolioContent({
  initialPortfolio,
  initialTxLog,
  gpus,
}: {
  initialPortfolio: PortfolioResponse;
  initialTxLog: TxLogEntry[];
  gpus: GpuMap;
}) {
  const [portfolio, setPortfolio] = useState(initialPortfolio);
  const [txLog, setTxLog] = useState(initialTxLog);
  const [busy, setBusy] = useState<string | null>(null);
  const toast = useToast();

  async function refresh() {
    const [p, t] = await Promise.all([getPortfolio(ACCOUNT), getTxLog()]);
    setPortfolio(p);
    setTxLog(t);
  }

  async function doRedeem(gpuId: string) {
    setBusy(gpuId);
    try {
      const slotStart = new Date(Math.ceil(Date.now() / 300000) * 300000 + 300000).toISOString();
      const res = await redeemSlots(ACCOUNT, gpuId, "1", slotStart);
      toast(`Redeemed 1 slot on ${gpuId.toUpperCase()}`, `booked ${res.slotStart} · ${res.redemptionId}`);
      await refresh();
    } catch (err) {
      toast("Redeem failed", (err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function doRepay(loanId: string) {
    setBusy(loanId);
    try {
      const loan = await repayLoan(loanId);
      toast(`Repaid loan`, txToastLine(`${fmt(Number(loan.principal), 2)} USDC`, loan.settleTx ?? loanId));
      await refresh();
    } catch (err) {
      toast("Repay failed", (err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  const dividends = txLog.filter((t) => t.kind === "payDividends" && t.account === ACCOUNT);

  return (
    <main className="s">
      <div className="wrap">
        <div className="shead">
          <h2>Portfolio</h2>
          <p>{ACCOUNT}&apos;s holdings, dividends, booked contracts and open loans.</p>
        </div>

        <h3 className="sub-h" style={{ marginTop: 0 }}>
          Holdings
        </h3>
        <div className="tbl">
          <table>
            <thead>
              <tr>
                <th>GPU</th>
                <th className="r">Shares</th>
                <th className="r">Contract tokens</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {Object.values(gpus).map((g) => {
                const shareQty = portfolio.shares.find((s) => s.gpuId === g.id)?.qty ?? "0";
                const contractQty = portfolio.contracts.find((c) => c.gpuId === g.id)?.qty ?? "0";
                return (
                  <tr key={g.id}>
                    <td>
                      <b>{g.id.toUpperCase()}</b>
                    </td>
                    <td className="r num">{shareQty}</td>
                    <td className="r num">{contractQty}</td>
                    <td className="r">
                      {Number(contractQty) > 0 && (
                        <Button variant="ghost" size="sm" disabled={busy === g.id} onClick={() => doRedeem(g.id)}>
                          Redeem
                        </Button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <h3 className="sub-h">TDX balance</h3>
        <p className="num" style={{ fontSize: 22 }}>
          {fmt(Number(portfolio.tdxBalance), 2)} USDC
        </p>

        <h3 className="sub-h">Dividends received</h3>
        <div className="tbl">
          <table>
            <thead>
              <tr>
                <th>When</th>
                <th>What</th>
                <th className="r">Amount</th>
                <th className="r">Tx</th>
              </tr>
            </thead>
            <tbody>
              {dividends.length === 0 && (
                <tr>
                  <td colSpan={4}>No dividends yet.</td>
                </tr>
              )}
              {dividends.map((d) => (
                <tr key={d.hash}>
                  <td>{new Date(d.createdAt).toLocaleString()}</td>
                  <td>{d.summary}</td>
                  <td className="r px">{fmt(Number(portfolio.dividendsReceived), 2)} USDC</td>
                  <td className="r">
                    <a href={d.explorerUrl} target="_blank" rel="noreferrer" className="num">
                      {shortHash(d.hash)}
                    </a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <h3 className="sub-h">Open loans</h3>
        <div className="tbl">
          <table>
            <thead>
              <tr>
                <th>GPU</th>
                <th className="r">Collateral</th>
                <th className="r">Principal</th>
                <th>Due</th>
                <th>Status</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {portfolio.loans.length === 0 && (
                <tr>
                  <td colSpan={6}>No loans yet.</td>
                </tr>
              )}
              {portfolio.loans.map((l) => (
                <tr key={l.id}>
                  <td>{l.gpuId.toUpperCase()}</td>
                  <td className="r num">{l.collateralShares}</td>
                  <td className="r px">{fmt(Number(l.principal), 2)} USDC</td>
                  <td>{new Date(l.dueAt).toLocaleString()}</td>
                  <td>{l.status}</td>
                  <td className="r">
                    {l.status === "open" && (
                      <Button variant="ghost" size="sm" disabled={busy === l.id} onClick={() => doRepay(l.id)}>
                        Repay
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </main>
  );
}
