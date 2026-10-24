"use client";
// /lend: XLS-65 vault rounds, deposit and withdraw, the loan book, simulated
// loan-book stats from the risk desk, and the stress test.
import { useCallback, useEffect, useState } from "react";
import type { BookStats, VaultOverview, VaultState, XlsLoanRecord } from "@moonshift/shared";
import { fmt, shortHash, typedAmount } from "@/lib/format";
import { LENDER, bookStats, deposit, getPositions, getVault, listLoans, pct, useApiEvents, withdraw } from "@/lib/lendingApi";
import { Button } from "./Button";
import { useToast } from "./Toast";
import { StatusChip, StressControls, TxLink } from "./LendingBits";

function dateStr(iso: string) {
  return iso ? new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "";
}

function RoundCard({ v, title, network, children }: { v: VaultState; title: string; network: string; children?: React.ReactNode }) {
  return (
    <div className="trade card">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10 }}>
        <span className="lbl" style={{ margin: 0 }}>
          {title} · round {v.round}
        </span>
        <span className={`chip chip-${v.phase === "investment" ? "open" : "phase"}`}>{v.phase}</span>
      </div>
      <div className="bignum" style={{ marginTop: 10 }}>
        {fmt(Number(v.assetsTotal), 2)} USDC
      </div>
      <div className="facts" style={{ marginTop: 14 }}>
        <div>
          <span>Lent out</span>
          <b>
            {fmt(Number(v.debtTotal), 2)} ({v.utilizationPct}%)
          </b>
        </div>
        <div>
          <span>Available</span>
          <b>{fmt(Number(v.assetsAvailable), 2)}</b>
        </div>
        <div>
          <span>Lender APY (from open loans)</span>
          <b>{v.lenderApyPct}%</b>
        </div>
        <div>
          <span>First-loss cover</span>
          <b>{fmt(Number(v.coverAvailable), 2)}</b>
        </div>
        <div>
          <span>Share price</span>
          <b>{Number(v.sharePrice).toFixed(4)}</b>
        </div>
        <div>
          <span>{v.phase === "subscription" ? "Deposits close" : "Lending until"}</span>
          <b>{dateStr(v.phase === "subscription" ? v.subscriptionDate : v.redemptionDate)}</b>
        </div>
      </div>
      {v.explorerUrl && network !== "mock" && (
        <a className="txl" href={v.explorerUrl} target="_blank" rel="noreferrer">
          Vault account on the {network} explorer
        </a>
      )}
      {children}
    </div>
  );
}

export function LendContent() {
  const [vault, setVault] = useState<VaultOverview | null>(null);
  const [loans, setLoans] = useState<XlsLoanRecord[]>([]);
  const [stats, setStats] = useState<(BookStats & { dataSource: string }) | null>(null);
  const [positions, setPositions] = useState<{ round: number; phase: string; shares: string; value: string }[]>([]);
  const [amount, setAmount] = useState("100");
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const toast = useToast();

  const refresh = useCallback(async () => {
    try {
      const [v, l, p] = await Promise.all([getVault(), listLoans(), getPositions(LENDER)]);
      setVault(v);
      setLoans(l.loans);
      setPositions(p.positions);
      setErr(null);
    } catch (e) {
      setErr((e as Error).message);
    }
  }, []);

  useEffect(() => {
    void refresh();
    bookStats().then(setStats).catch(() => {});
    const t = setInterval(() => void refresh(), 20_000);
    return () => clearInterval(t);
  }, [refresh]);

  useApiEvents(["vault", "loan", "risk"], () => void refresh());

  async function move(kind: "deposit" | "withdraw") {
    setBusy(kind);
    try {
      const r = kind === "deposit" ? await deposit(LENDER, amount) : await withdraw(LENDER, amount);
      toast(
        kind === "deposit" ? `Deposited ${fmt(Number(amount), 2)} USDC` : `Withdrew ${fmt(Number(amount), 2)} USDC`,
        `round ${r.round} · ${kind === "deposit" ? "VaultDeposit" : "VaultWithdraw"} tx ${shortHash(r.tx.hash)}${r.tx.hash.startsWith("MOCK") ? " · simulated" : ""}`
      );
      await refresh();
    } catch (e) {
      toast(kind === "deposit" ? "Deposit failed" : "Withdraw failed", (e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  const net = vault?.network ?? "devnet";
  const active = loans.filter((l) => l.status === "open" || l.status === "margin_call");
  const defaults = loans.filter((l) => l.status === "liquidated" || l.status === "defaulted").length;
  const calls = loans.filter((l) => l.marginCallAt).length;
  const pos = positions.filter((p) => Number(p.shares) > 0);

  return (
    <main className="s">
      <div className="wrap">
        <div className="shead">
          <h2>Lend USDC to GPU owners.</h2>
          <p>
            Deposits go into an XRPL vault (XLS-65) that Moonshift lends from as a native loan broker (XLS-66). Every loan is backed by escrowed GPU
            shares and a first-loss cover. Vaults run in rounds: a round takes deposits, then lends for a fixed term, then pays lenders back, so you
            deposit into the next round while the current one is lending.
          </p>
        </div>
        {err && <p className="note dn">{err}</p>}
        {vault && (
          <div className="lend-grid">
            {vault.investing ? (
              <RoundCard v={vault.investing} title="Lending now" network={net} />
            ) : (
              <div className="trade card">
                <p className="note">No round is lending right now. Run npm run demo:reset.</p>
              </div>
            )}
            {vault.subscribing ? (
              <RoundCard v={vault.subscribing} title="Open for deposits" network={net}>
                <label className="lbl" htmlFor="dep" style={{ marginTop: 18 }}>
                  Amount ({LENDER.charAt(0) + LENDER.slice(1).toLowerCase()}, demo lender)
                </label>
                <div className="inp">
                  <input id="dep" type="text" autoComplete="off" value={amount} inputMode="decimal" onChange={(e) => setAmount(typedAmount(e.target.value))} />
                  <span>USDC</span>
                </div>
                <div className="two">
                  <Button disabled={!!busy || !(Number(amount) > 0)} onClick={() => move("deposit")}>
                    {busy === "deposit" ? "Depositing..." : "Deposit"}
                  </Button>
                  <Button variant="ghost" disabled={!!busy || !(Number(amount) > 0)} onClick={() => move("withdraw")}>
                    {busy === "withdraw" ? "Withdrawing..." : "Withdraw"}
                  </Button>
                </div>
                {pos.length > 0 && (
                  <p className="note">
                    Your position:{" "}
                    {pos.map((p) => `round ${p.round} ${fmt(Number(p.value), 2)} USDC`).join(", ")}
                  </p>
                )}
              </RoundCard>
            ) : (
              <div className="trade card">
                <p className="note">No round is open for deposits.</p>
              </div>
            )}
          </div>
        )}

        <h3 className="sub-h" style={{ marginTop: 64 }}>
          Loan book
        </h3>
        <div className="proof" style={{ marginTop: 8, marginBottom: 24 }}>
          <div>
            <b>{active.length}</b>active loans
          </div>
          <div>
            <b>{fmt(active.reduce((s, l) => s + Number(l.ledger?.totalValueOutstanding ?? 0), 0), 2)}</b>outstanding USDC
          </div>
          <div>
            <b>{calls}</b>margin calls
          </div>
          <div>
            <b>{defaults}</b>liquidations
          </div>
        </div>
        {loans.length > 0 ? (
          <div className="tbl">
            <table>
              <thead>
                <tr>
                  <th>Loan</th>
                  <th>Borrower</th>
                  <th>Status</th>
                  <th>Owed</th>
                  <th>APR</th>
                  <th>LTV</th>
                  <th>Lines</th>
                  <th>Ledger</th>
                </tr>
              </thead>
              <tbody>
                {loans.slice(0, 12).map((l) => (
                  <tr key={l.id}>
                    <td>{l.id.slice(0, 8)}</td>
                    <td>{l.borrower}</td>
                    <td>
                      <StatusChip status={l.status} />
                    </td>
                    <td className="num">{fmt(Number(l.ledger?.totalValueOutstanding ?? 0), 2)}</td>
                    <td className="num">{pct(l.apr, 2)}</td>
                    <td className="num">{l.health ? pct(l.health.ltv) : ""}</td>
                    <td className="num">
                      {pct(l.marginCallLtv, 0)} / {pct(l.liquidationLtv, 0)}
                    </td>
                    <td>
                      <TxLink network={l.network} hash={l.txs.seize ?? l.txs.release ?? l.txs.loanSet} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="note">No loans yet. Open one on the Borrow page.</p>
        )}

        <div className="lend-grid" style={{ marginTop: 48 }}>
          <div className="trade card">
            <StressControls gpuId="gpu-a" onDone={() => void refresh()} />
          </div>
          <div className="trade card">
            <span className="lbl">Loan book by credit grade, 30 days (simulated)</span>
            {stats ? (
              <div className="tbl">
                <table>
                  <thead>
                    <tr>
                      <th>Grade</th>
                      <th>Defaults</th>
                      <th>Margin calls</th>
                      <th>Cured</th>
                    </tr>
                  </thead>
                  <tbody>
                    {stats.grades.map((g) => (
                      <tr key={g.grade}>
                        <td>{g.grade}</td>
                        <td className="num">{pct(g.defaultRate)}</td>
                        <td className="num">{pct(g.marginCallRate)}</td>
                        <td className="num">{pct(g.cureRate)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="note">Loading...</p>
            )}
            <p className="note">Simulated loan book from the risk desk, {stats?.borrowers ?? 0} borrowers. Not real loans.</p>
          </div>
        </div>
      </div>
    </main>
  );
}
