"use client";
// Lend > Lending markets: one card per round (GET /lending/markets, or the
// vault rounds from GET /vault), deposit into the round taking deposits, and
// how risk is priced.
import type { VaultOverview, VaultState } from "@moonshift/shared";
import { fmt, typedAmount } from "@/lib/format";
import { Button } from "../Button";
import { ConnectPrompt } from "../ConnectPrompt";

export type Market = {
  id: string;
  round: number | null;
  title: string;
  phase: string;
  acceptsDeposits: boolean;
  targetApr: number | null; // percent
  size: number | null;
  filled: number | null;
  facts: [string, string][];
  history: [string, string][];
  explorerUrl: string | null;
};

const PHASE: Record<string, string> = {
  subscription: "Open for deposits",
  investment: "Lending",
  redemption: "Repaying lenders",
  closed: "Closed",
  matured: "Closed",
};

const dateStr = (iso?: string | null) =>
  iso ? new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "";
const usd = (v: unknown) => (v === null || v === undefined || v === "" ? "" : `${fmt(Number(v), 2)} USDC`);
const num = (v: unknown) => (v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));

// GET /lending/markets rows, whatever subset of the requested fields they carry.
export function marketsFromApi(raw: any): Market[] | null {
  const rows = Array.isArray(raw) ? raw : raw?.markets ?? raw?.rounds;
  if (!Array.isArray(rows)) return null;
  return rows.map((m: any, i: number) => {
    const phase = String(m.phase ?? m.status ?? "");
    const facts: [string, string][] = [];
    const add = (k: string, v: string) => v && facts.push([k, v]);
    add("Price per GPU unit", m.gpuUnitPrice != null ? usd(m.gpuUnitPrice) : "");
    add("Use of funds", m.useOfFunds ?? "");
    add("Collateral", m.collateral ?? "");
    add("Opens", dateStr(m.opensAt ?? m.subscriptionDate));
    add("Deposits close", dateStr(m.closesAt ?? m.depositsCloseAt));
    add("Lenders repaid", dateStr(m.maturesAt ?? m.redemptionDate));
    const hist: [string, string][] = Array.isArray(m.history)
      ? m.history.map((h: any) => [String(h.label ?? h.at ?? ""), String(h.value ?? h.text ?? "")] as [string, string])
      : [];
    return {
      id: String(m.id ?? m.round ?? i),
      round: num(m.round),
      title: String(m.title ?? m.finances ?? m.name ?? `Round ${m.round ?? i + 1}`),
      phase,
      acceptsDeposits: m.acceptsDeposits ?? phase === "subscription",
      targetApr: num(m.targetApr ?? m.targetAprPct) !== null ? normPct(m.targetApr ?? m.targetAprPct) : null,
      size: num(m.size),
      filled: num(m.filled),
      facts,
      history: hist,
      explorerUrl: m.explorerUrl ?? null,
    };
  });
}

// A rate may come as 0.13 or 13: show percent.
const normPct = (v: unknown) => {
  const n = Number(v);
  return n > 0 && n < 1 ? n * 100 : n;
};

// The vault's rounds, newest first: what /vault already tells us about each.
export function marketsFromVault(v: VaultOverview): Market[] {
  const byRound = new Map<number, VaultState>();
  for (const r of v.rounds ?? []) byRound.set(r.round, r);
  if (v.investing) byRound.set(v.investing.round, v.investing);
  if (v.subscribing) byRound.set(v.subscribing.round, v.subscribing);
  return [...byRound.values()]
    .sort((a, b) => b.round - a.round)
    .map((r) => {
      const cover = Number(r.coverAvailable);
      const facts: [string, string][] = [
        ["Use of funds", "USDC loans to holders of Moonshift GPU shares"],
        ["Collateral", `Locked GPU shares${cover > 0 ? `, plus ${fmt(cover, 2)} USDC first-loss cover` : ""}`],
        [r.phase === "subscription" ? "Deposits close" : "Deposits closed", dateStr(r.subscriptionDate)],
        ["Lenders repaid", dateStr(r.redemptionDate)],
      ];
      const history: [string, string][] = [];
      if (r.phase !== "subscription") {
        history.push(["Lent out", `${fmt(Number(r.debtTotal), 2)} USDC (${r.utilizationPct}%)`]);
        history.push(["Earned so far", `${r.earnedApyPct ?? r.lenderApyPct}% APY`]);
        if (Number(r.lossUnrealized) > 0) history.push(["Unrealized loss", `${fmt(Number(r.lossUnrealized), 2)} USDC`]);
        const broker = (r as { broker?: { loansOriginated?: number } | null }).broker;
        if (broker?.loansOriginated) history.push(["Loans originated", fmt(broker.loansOriginated, 0)]);
      }
      return {
        id: String(r.round),
        round: r.round,
        title: `Round ${r.round}: credit for GPU shareholders`,
        phase: r.phase,
        acceptsDeposits: r.phase === "subscription",
        targetApr: r.targetApyPct ? Number(r.targetApyPct) : null,
        size: null,
        filled: Number(r.assetsTotal),
        facts,
        history,
        explorerUrl: r.explorerUrl ?? null,
      };
    });
}

function MarketCard({ m, children }: { m: Market; children?: React.ReactNode }) {
  const fill = m.size && m.filled !== null ? Math.min(1, m.filled / m.size) : null;
  return (
    <div className={m.acceptsDeposits ? "trade card mkt open" : "trade card mkt"}>
      <div className="mkt-head">
        <span className="mkt-phase">{PHASE[m.phase] ?? m.phase}</span>
        {m.round !== null && <span className="mkt-round">Round {m.round}</span>}
      </div>
      <h3 className="mkt-title">{m.title}</h3>
      <div className="mkt-nums">
        <div>
          <span>Target APR</span>
          <b>{m.targetApr !== null ? `${fmt(m.targetApr, 2)}%` : "Set at launch"}</b>
        </div>
        <div>
          <span>{m.size ? "Filled" : "Deposits"}</span>
          <b>
            {m.filled !== null ? fmt(m.filled, 0) : "0"}
            {m.size ? <small> / {fmt(m.size, 0)} USDC</small> : <small> USDC</small>}
          </b>
        </div>
      </div>
      {fill !== null && (
        <div className="mkt-fill" aria-label={`${Math.round(fill * 100)}% filled`}>
          <i style={{ width: `${fill * 100}%` }} />
        </div>
      )}
      <div className="mkt-facts">
        {m.facts.map(([k, v]) => (
          <div key={k}>
            <span>{k}</span>
            <b>{v}</b>
          </div>
        ))}
      </div>
      {m.history.length > 0 && (
        <div className="mkt-facts mkt-hist">
          {m.history.map(([k, v], i) => (
            <div key={`${i}-${k}`}>
              <span>{k}</span>
              <b>{v}</b>
            </div>
          ))}
        </div>
      )}
      {m.explorerUrl && (
        <a className="txl" href={m.explorerUrl} target="_blank" rel="noreferrer">
          View vault account
        </a>
      )}
      {children}
    </div>
  );
}

export function Markets({
  markets,
  signedIn,
  amount,
  setAmount,
  busy,
  onMove,
  positions,
}: {
  markets: Market[] | null;
  signedIn: boolean;
  amount: string;
  setAmount: (v: string) => void;
  busy: string | null;
  onMove: (kind: "deposit" | "withdraw") => void;
  positions: { round: number; phase: string; shares: string; value: string }[];
}) {
  const pos = positions.filter((p) => Number(p.shares) > 0);
  return (
    <div className="mkt-layout">
      <div className="mkt-list">
        {markets === null ? (
          <div className="trade card">
            <p className="note">Loading lending markets...</p>
          </div>
        ) : markets.length === 0 ? (
          <div className="trade card">
            <p className="note">No lending market is open right now.</p>
          </div>
        ) : (
          markets.map((m) => (
            <MarketCard key={m.id} m={m}>
              {m.acceptsDeposits && (
                <div className="mkt-dep">
                  {!signedIn ? (
                    <ConnectPrompt line="Connect your wallet to deposit" />
                  ) : (
                    <>
                      <label className="lbl" htmlFor={`dep-${m.id}`}>
                        Deposit
                      </label>
                      <div className="mkt-dep-row">
                        <div className="inp">
                          <input
                            id={`dep-${m.id}`}
                            type="text"
                            autoComplete="off"
                            placeholder="0"
                            value={amount}
                            inputMode="decimal"
                            onChange={(e) => setAmount(typedAmount(e.target.value))}
                          />
                          <span>USDC</span>
                        </div>
                        <Button disabled={!!busy || !(Number(amount) > 0)} onClick={() => onMove("deposit")}>
                          {busy === "deposit" ? "Depositing..." : "Deposit"}
                        </Button>
                        <Button variant="ghost" disabled={!!busy || !(Number(amount) > 0)} onClick={() => onMove("withdraw")}>
                          {busy === "withdraw" ? "Withdrawing..." : "Withdraw"}
                        </Button>
                      </div>
                      {pos.length > 0 && (
                        <p className="note">Your position: {pos.map((p) => `round ${p.round}, ${fmt(Number(p.value), 2)} USDC`).join("; ")}</p>
                      )}
                    </>
                  )}
                </div>
              )}
            </MarketCard>
          ))
        )}
      </div>
      <aside className="trade card risk-panel">
        <span className="lbl">How we price risk</span>
        <ol>
          <li>
            <b>The borrower.</b> Each borrower&apos;s on-chain payment history, read through Quicknode, sets their credit grade. Every factor links to
            the transaction behind it.
          </li>
          <li>
            <b>The collateral.</b> Each GPU&apos;s real revenue history is the cash flow behind the shares that secure a loan, and its live share
            price sets their value.
          </li>
          <li>
            <b>The terms.</b> The risk desk turns both into the APR and the loan to value limits: a maximum to borrow, a margin call line and a
            liquidation line on every loan.
          </li>
        </ol>
        <p className="note">
          A first-loss cover takes losses before lenders do. A keeper checks every open loan against the live share price and acts on-chain when a
          line is crossed.
        </p>
      </aside>
    </div>
  );
}
