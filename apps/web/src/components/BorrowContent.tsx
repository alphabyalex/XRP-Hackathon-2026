"use client";
// /borrow: credit profile, live risk quote, Bedrock memo, then a real XLS-66
// loan on devnet with GPU shares escrowed. Loan health updates live.
import { useCallback, useEffect, useRef, useState } from "react";
import type { AgentText, CreditStats, LoanQuoteApiResponse, PortfolioResponse, XlsLoanRecord } from "@moonshift/shared";
import { getPortfolio } from "@/lib/api";
import { fmt, shortHash, typedAmount } from "@/lib/format";
import { creditStats, listLoans, maxPrincipal, openFromQuote, payNext, payOff, pct, quoteLoan, quoteMemo, txUrl, useApiEvents } from "@/lib/lendingApi";
import { Button } from "./Button";
import { useToast } from "./Toast";
import { HealthMeter, LoanTxs, StatusChip, StressControls, TxLink } from "./LendingBits";
import { ACCOUNT } from "@/lib/session";

const FACTOR_TEXT: Record<string, string> = {
  accountAgeDays: "Account age (days)",
  txCount: "Transactions",
  paymentVolumeInXrp: "Payments received (XRP)",
  paymentVolumeOutXrp: "Payments sent (XRP)",
  distinctCounterparties: "Counterparties",
  trustlines: "Trust lines",
  balanceStability: "Balance stability",
  largestOutflowRatio: "Largest outflow ratio",
  msRepaysOnTime: "Moonshift repayments on time",
  msRepaysLate: "Moonshift repayments late",
  msMarginCalls: "Margin calls",
  msLiquidations: "Liquidations",
};

function days(seconds: number) {
  const d = seconds / 86400;
  return d >= 1 ? `${fmt(d, d >= 10 ? 0 : 1)} days` : `${Math.round(seconds / 60)} min`;
}

function until(iso: string | null | undefined, now: number) {
  if (!iso) return "none";
  const ms = new Date(iso).getTime() - now;
  if (ms <= 0) return "now";
  const h = Math.floor(ms / 3600e3);
  const m = Math.floor((ms % 3600e3) / 60e3);
  return h >= 24 ? `${Math.floor(h / 24)}d ${h % 24}h` : `${h}h ${m}m`;
}

export function BorrowContent({
  initialPortfolio,
  gpuId,
  gpuLabel,
}: {
  initialPortfolio: PortfolioResponse;
  gpuId: string;
  gpuLabel: string;
  sharePrice: number;
}) {
  const [portfolio, setPortfolio] = useState(initialPortfolio);
  const [shares, setShares] = useState("100");
  const [principal, setPrincipal] = useState("");
  // Until the borrower types an amount, it follows the largest approved one.
  const [amountTouched, setAmountTouched] = useState(false);
  const [quote, setQuote] = useState<LoanQuoteApiResponse | null>(null);
  const [quoteErr, setQuoteErr] = useState<string | null>(null);
  const [quoting, setQuoting] = useState(false);
  const [loans, setLoans] = useState<XlsLoanRecord[]>([]);
  const [alerts, setAlerts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());
  const [qn, setQn] = useState<CreditStats | null>(null);
  const [memo, setMemo] = useState<AgentText | null>(null);
  const [requote, setRequote] = useState(0);
  const toast = useToast();
  const seq = useRef(0);

  const held = Number(portfolio.shares.find((s) => s.gpuId === gpuId)?.qty ?? 0);
  const code = `${gpuLabel} shares`;

  const refresh = useCallback(async () => {
    const [p, l] = await Promise.all([getPortfolio(ACCOUNT).catch(() => null), listLoans(ACCOUNT).catch(() => null)]);
    if (p) setPortfolio(p);
    if (l) setLoans(l.loans);
  }, []);

  // Default the amount to the largest one risk approves for these shares.
  useEffect(() => {
    if (amountTouched || !(Number(shares) > 0)) return;
    let alive = true;
    const t = setTimeout(() => {
      maxPrincipal(ACCOUNT, gpuId, String(Number(shares)))
        .then((m) => {
          if (alive && !amountTouched) setPrincipal(Number(m.maxPrincipal) > 0 ? String(Number(m.maxPrincipal)) : "1");
        })
        .catch(() => alive && !amountTouched && setPrincipal((p) => p || "50"));
    }, 300);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [shares, gpuId, amountTouched, requote]);

  // Live quote, debounced. Stale responses are dropped.
  useEffect(() => {
    const s = Number(shares);
    const p = Number(principal);
    if (!(s > 0) || !(p > 0)) return;
    const mine = ++seq.current;
    setQuoting(true);
    const t = setTimeout(async () => {
      try {
        const q = await quoteLoan(ACCOUNT, gpuId, String(s), String(p));
        if (mine === seq.current) {
          setQuote(q);
          setQuoteErr(null);
        }
      } catch (e) {
        if (mine === seq.current) setQuoteErr((e as Error).message);
      } finally {
        if (mine === seq.current) setQuoting(false);
      }
    }, 450);
    return () => clearTimeout(t);
  }, [shares, principal, gpuId, requote]);

  // The credit memo arrives after the quote: show the quote now, the memo when Bedrock is done.
  useEffect(() => {
    if (!quote) return;
    if (quote.memo) {
      setMemo(quote.memo);
      return;
    }
    setMemo(null);
    let alive = true;
    (async () => {
      for (let i = 0; i < 4 && alive; i++) {
        try {
          const r = await quoteMemo(quote.quoteId);
          if (r.memo) {
            if (alive) setMemo(r.memo);
            return;
          }
        } catch {
          return;
        }
      }
    })();
    return () => {
      alive = false;
    };
  }, [quote]);

  // Live Quicknode counters from the credit service, next to the profile.
  useEffect(() => {
    const load = () => creditStats().then(setQn).catch(() => {});
    load();
    const t = setInterval(load, 15_000);
    return () => clearInterval(t);
  }, [quote]);

  useEffect(() => {
    void refresh();
    const t = setInterval(() => setNow(Date.now()), 1000);
    const poll = setInterval(() => void refresh(), 20_000);
    return () => {
      clearInterval(t);
      clearInterval(poll);
    };
  }, [refresh]);

  useApiEvents(["loan", "vault", "risk"], (type, data) => {
    if (type === "loan" && data?.alert?.text) setAlerts((a) => ({ ...a, [data.id]: data.alert.text }));
    if (type === "loan" && data?.type === "margin_call") toast("Margin call", `${data.alert?.text?.slice(0, 120) ?? ""}`);
    if (type === "loan" && data?.type === "liquidated") toast("Loan liquidated", `collateral seized · tx ${shortHash(data.tx ?? "")}`);
    void refresh();
  });

  async function doOpen() {
    if (!quote || busy) return;
    setBusy("open");
    try {
      const loan = await openFromQuote(quote.quoteId);
      toast(
        `Borrowed ${fmt(Number(loan.principal), 2)} USDC on ${loan.network}`,
        `XLS-66 LoanSet tx ${shortHash(loan.txs.loanSet ?? "")} · ${loan.collateralShares} ${code} escrowed`
      );
      setQuote(null);
      setAmountTouched(false); // next loan: back to the largest approved amount
      setRequote((n) => n + 1); // a quote opens one loan; fetch a fresh one
      await refresh();
    } catch (e) {
      toast("Borrow failed", (e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function doPay(loan: XlsLoanRecord, full: boolean) {
    setBusy(loan.id + (full ? "full" : "next"));
    try {
      const r = full ? await payOff(loan.id) : await payNext(loan.id);
      toast(
        full ? "Loan paid off, collateral released" : "Installment paid",
        full ? `Batch release tx ${shortHash(r.txs.release ?? "")} · ${r.collateralShares} ${code} back` : `LoanPay tx ${shortHash(r.txs.pay ?? "")}`
      );
      await refresh();
    } catch (e) {
      toast("Payment failed", (e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  const q = quote?.quote;
  const active = loans.filter((l) => l.status === "open" || l.status === "margin_call");
  const past = loans.filter((l) => !(l.status === "open" || l.status === "margin_call")).slice(0, 6);
  const credit = quote?.credit;
  const topFactors = credit
    ? Object.entries(credit.features)
        .filter(([, f]) => f.points !== 0)
        .sort((a, b) => Math.abs(b[1].points) - Math.abs(a[1].points))
        .slice(0, 5)
    : [];

  return (
    <main className="s">
      <div className="wrap">
        <div className="shead">
          <h2>Borrow against your GPU shares.</h2>
          <p>
            Your shares stay yours. They sit in an XRPL escrow while you borrow USDC from the Moonshift lending vault, and they come back the moment you
            repay. Terms come from your on-chain payment history and the GPU&apos;s real revenue.
          </p>
        </div>

        <div className="lend-grid">
          {/* Credit profile */}
          <div className="trade card">
            <span className="lbl">Credit profile</span>
            {credit ? (
              <>
                <div className="score">
                  <div className="bignum">{credit.score}</div>
                  <div>
                    <div className="grade">Grade {credit.grade}</div>
                    <div className="muted">{credit.confidence} confidence</div>
                  </div>
                </div>
                <div className="factors">
                  {topFactors.map(([k, f]) => (
                    <div key={k}>
                      <span>
                        {FACTOR_TEXT[k] ?? k}
                        {f.from && <em className="from">{f.from}</em>}
                      </span>
                      <b className={f.points < 0 ? "dn" : "up"}>
                        {f.points > 0 ? "+" : ""}
                        {f.points}
                      </b>
                      <span className="ev">
                        {f.txHashes
                          .filter((h) => !/^0+[0-9]$/.test(h))
                          .slice(0, 1)
                          .map((h) => {
                            const url = txUrl(credit.network, h);
                            return url ? (
                              <a key={h} className="txl" href={url} target="_blank" rel="noreferrer">
                                {shortHash(h)}
                              </a>
                            ) : null;
                          })}
                      </span>
                    </div>
                  ))}
                </div>
                {credit.components && credit.components.length > 0 && (
                  <div className="sources">
                    {credit.components.map((c) => (
                      <div key={c.part}>
                        <b>{c.part}</b>
                        <span>
                          {c.source === "quicknode" ? `Read through Quicknode (XRPL ${c.network})` : `XRPL ${c.network}`} · {shortHash(c.address)}
                        </span>
                        {c.ownership && !c.ownership.verified && <span className="unverified">Ownership not verified</span>}
                      </div>
                    ))}
                  </div>
                )}
                {qn && qn.dataSource === "live" && (
                  <p className="note qn">
                    Read through Quicknode: {qn.quicknode.calls} calls, {fmt(qn.quicknode.creditsUsed, 0)} credits
                    {qn.quicknode.p50LatencyMs ? `, p50 ${Math.round(qn.quicknode.p50LatencyMs)} ms` : ""}, {Math.round(qn.totals.cacheHitRate * 100)}% served from cache
                  </p>
                )}
                {credit.portfolio && (
                  <p className="note">
                    Borrowers in grade {credit.portfolio.grade} default {credit.portfolio.defaultRatePct}% of the time (model estimate)
                  </p>
                )}
                {!credit.components?.length && <p className="note">Source: XRPL {credit.network}</p>}
              </>
            ) : (
              <p className="note">{quoteErr ?? "Reading your payment history..."}</p>
            )}
          </div>

          {/* Quote and open */}
          <div className="trade card">
            <div className="two">
              <div>
                <label className="lbl" htmlFor="coll">
                  Shares to lock
                </label>
                <div className="inp">
                  <input id="coll" type="text" autoComplete="off" value={shares} inputMode="numeric" onChange={(e) => setShares(typedAmount(e.target.value, false))} />
                  <span>shares</span>
                </div>
                <span className="note">You hold {fmt(held, 0)} {code}</span>
              </div>
              <div>
                <label className="lbl" htmlFor="amt">
                  Borrow
                </label>
                <div className="inp">
                  <input id="amt" type="text" autoComplete="off" value={principal} inputMode="decimal" onChange={(e) => {
                      setAmountTouched(true);
                      setPrincipal(typedAmount(e.target.value));
                    }}
                  />
                  <span>USDC</span>
                </div>
                <span className="note">Collateral worth {quote ? fmt(Number(quote.collateralValue), 2) : "..."} USDC</span>
              </div>
            </div>

            {q && (
              <>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", marginTop: 22, gap: 12, flexWrap: "wrap" }}>
                  <div>
                    <span className="lbl">APR</span>
                    <div className="bignum">{pct(q.apr, 2)}</div>
                  </div>
                  <span className={q.decision === "approve" ? "chip chip-open" : "chip chip-defaulted"}>
                    {q.decision === "approve" ? "Approved" : "Declined"}
                    {quoting ? "..." : ""}
                  </span>
                </div>
                <HealthMeter ltv={Number(q.ltv)} marginCallLtv={Number(q.marginCallLtv)} liquidationLtv={Number(q.liquidationLtv)} />
                <div className="line" style={{ marginTop: 18 }}>
                  <span>Max LTV</span>
                  <b>{pct(q.maxLtv)}</b>
                </div>
                <div className="line">
                  <span>Dividend coverage</span>
                  <b>{fmt(Number(q.coverageRatio), 2)}x</b>
                </div>
                <div className="line">
                  <span>Default probability (estimate)</span>
                  <b>{pct(q.pd)}</b>
                </div>
                <div className="line">
                  <span>Term</span>
                  <b>
                    {days(quote!.terms.termSeconds)}, {quote!.terms.paymentTotal} payments
                  </b>
                </div>
                {q.reasons.length > 0 && <p className="note">Risk flags: {q.reasons.join(", ").toLowerCase().replace(/_/g, " ")}</p>}
                {memo ? (
                  <blockquote className="memo">
                    {memo.text.replace(/TDX/g, "USDC")}
                    <span>{memo.fellBack ? "Credit memo" : "Credit memo by Amazon Bedrock"}</span>
                  </blockquote>
                ) : (
                  <p className="memo-pending">Writing credit memo...</p>
                )}
              </>
            )}
            {quoteErr && !q && <p className="note dn">{quoteErr}</p>}
            <Button disabled={!q || q.decision !== "approve" || !!busy || quoting} onClick={doOpen}>
              {busy === "open"
                ? "Signing LoanSet on devnet..."
                : q?.decision === "decline"
                  ? "Lower the amount to get approved"
                  : `Lock ${fmt(Number(shares) || 0, 0)} ${code}, borrow ${fmt(Number(principal) || 0, 2)} USDC`}
            </Button>
          </div>
        </div>

        {active.length > 0 && (
          <>
            <h3 className="sub-h" style={{ marginTop: 64 }}>
              Your open loans
            </h3>
            <div className="loans">
              {active.map((l) => {
                const h = l.health;
                return (
                  <div className="trade card" key={l.id}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10 }}>
                      <span className="lbl" style={{ margin: 0 }}>
                        {l.gpuId.toUpperCase()} loan {l.id.slice(0, 8)} · round {l.round}
                      </span>
                      <StatusChip status={l.status} />
                    </div>
                    <div className="bignum" style={{ marginTop: 10 }}>
                      {fmt(Number(l.ledger?.totalValueOutstanding ?? l.principal), 2)} USDC
                    </div>
                    {h && <HealthMeter ltv={Number(h.ltv)} marginCallLtv={Number(l.marginCallLtv)} liquidationLtv={Number(l.liquidationLtv)} />}
                    <div className="line" style={{ marginTop: 16 }}>
                      <span>Collateral</span>
                      <b>
                        {l.collateralShares} {code} at {h ? fmt(Number(h.collateralPrice), 2) : "..."} USDC
                      </b>
                    </div>
                    <div className="line">
                      <span>APR</span>
                      <b>{pct(l.apr, 2)}</b>
                    </div>
                    <div className="line">
                      <span>Next payment</span>
                      <b>
                        {fmt(Number(l.ledger?.periodicPayment ?? 0), 2)} USDC in {until(l.ledger?.nextPaymentDueDate, now)}
                      </b>
                    </div>
                    {alerts[l.id] && l.status === "margin_call" && <p className="note dn">{alerts[l.id]}</p>}
                    <LoanTxs loan={l} />
                    <div className="two" style={{ marginTop: 6 }}>
                      <Button variant="ghost" disabled={!!busy} onClick={() => doPay(l, false)}>
                        {busy === l.id + "next" ? "Paying..." : "Pay installment"}
                      </Button>
                      <Button disabled={!!busy} onClick={() => doPay(l, true)}>
                        {busy === l.id + "full" ? "Paying off..." : "Pay off, release shares"}
                      </Button>
                    </div>
                    <StressControls gpuId={l.gpuId} loanId={l.id} compact onDone={() => void refresh()} />
                  </div>
                );
              })}
            </div>
          </>
        )}

        {past.length > 0 && (
          <>
            <h3 className="sub-h" style={{ marginTop: 56 }}>
              History
            </h3>
            <div className="tbl">
              <table>
                <thead>
                  <tr>
                    <th>Loan</th>
                    <th>Status</th>
                    <th>Principal</th>
                    <th>Collateral</th>
                    <th>Ledger</th>
                  </tr>
                </thead>
                <tbody>
                  {past.map((l) => (
                    <tr key={l.id}>
                      <td>{l.id.slice(0, 8)}</td>
                      <td>
                        <StatusChip status={l.status} />
                      </td>
                      <td className="num">{fmt(Number(l.principal), 2)}</td>
                      <td className="num">
                        {l.collateralShares} {code}
                      </td>
                      <td>
                        <TxLink network={l.network} hash={l.txs.release ?? l.txs.seize ?? l.txs.loanSet} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
    </main>
  );
}
