"use client";
// /borrow: credit profile, live risk quote, Bedrock memo, then a real XLS-66
// loan on devnet with GPU shares escrowed. Loan health updates live.
import { useCallback, useEffect, useRef, useState } from "react";
import type { AgentText, CreditProfile, LoanQuoteApiResponse, PortfolioResponse, XlsLoanRecord } from "@moonshift/shared";
import { getPortfolio } from "@/lib/api";
import { fmt, shortHash, typedAmount } from "@/lib/format";
import { borrowerProfile, listLoans, maxPrincipal, openFromQuote, walletGet, type ConnectedWallet, payNext, payOff, pct, quoteLoan, quoteMemo, txUrl, useApiEvents } from "@/lib/lendingApi";
import { Button } from "./Button";
import { useToast } from "./Toast";
import { HealthMeter, LoanTxs, StatusChip, StressControls, TxLink } from "./LendingBits";
import { WalletConnect } from "./WalletConnect";
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
  largeOutflows: "Outflows over half the balance",
  msRepaysOnTime: "Moonshift repayments on time",
  msRepaysLate: "Moonshift repayments late",
  msMarginCalls: "Margin calls",
  msLiquidations: "Liquidations",
  msDividendsReceived: "GPU dividends received",
  msShareTrades: "GPU share trades",
};

// One line of the connected wallet's activity feed (credit service shape).
type Activity = {
  at: string;
  type: string;
  direction: "in" | "out";
  amount: string | null;
  currency: string | null;
  counterparty: string | null;
  txHash: string;
  network: string;
  ok: boolean;
};
type FactorChange = { feature: string; before: unknown; after: unknown; pointsBefore: number; pointsAfter: number; delta: number };

// How long a live change stays highlighted.
const HIGHLIGHT_MS = 8000;

function factorValue(v: unknown) {
  if (v === null || v === undefined) return "none";
  const n = Number(v);
  return Number.isFinite(n) ? fmt(n, Number.isInteger(n) ? 0 : 2) : String(v);
}

// "Counterparties +2", or the value move when the points did not change.
function changeText(c: FactorChange) {
  const label = FACTOR_TEXT[c.feature] ?? c.feature;
  const move = `${factorValue(c.before)} to ${factorValue(c.after)}`;
  return c.delta !== 0 ? `${label} ${c.delta > 0 ? "+" : ""}${c.delta} (${move})` : `${label} ${move}`;
}

function activityText(a: Activity) {
  if (a.type !== "Payment") return a.type;
  return a.direction === "out" ? "Sent" : "Received";
}

function clock(iso: string) {
  return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
}

function days(seconds: number) {
  const d = seconds / 86400;
  // One decimal unless whole, the same way the credit memo writes it.
  return d >= 1 ? `${fmt(d, Number.isInteger(Math.round(d * 10) / 10) ? 0 : 1)} days` : `${Math.round(seconds / 60)} min`;
}

function until(iso: string | null | undefined, now: number) {
  if (!iso) return "none";
  const ms = new Date(iso).getTime() - now;
  if (ms <= 0) return "now";
  const h = Math.floor(ms / 3600e3);
  const m = Math.floor((ms % 3600e3) / 60e3);
  return h >= 24 ? `${Math.floor(h / 24)}d ${h % 24}h` : `${h}h ${m}m`;
}

type MaxAmount = { maxPrincipal: string; collateralValue: string; termSeconds: number };

export function BorrowContent({
  initialPortfolio,
  initialProfile,
  initialMax,
  initialWallet,
  defaultShares,
  gpuId,
  gpuLabel,
}: {
  initialPortfolio: PortfolioResponse;
  initialProfile: CreditProfile | null;
  initialMax: MaxAmount | null;
  initialWallet: ConnectedWallet | null;
  defaultShares: string;
  gpuId: string;
  gpuLabel: string;
  sharePrice: number;
}) {
  const [portfolio, setPortfolio] = useState(initialPortfolio);
  const [shares, setShares] = useState(defaultShares);
  // The borrower types the amount; the largest approved one is shown beside it.
  const [principal, setPrincipal] = useState("");
  const [max, setMax] = useState<MaxAmount | null>(initialMax);
  const [quote, setQuote] = useState<LoanQuoteApiResponse | null>(null);
  const [profile, setProfile] = useState<CreditProfile | null>(initialProfile);
  const [wallet, setWallet] = useState<ConnectedWallet | null>(initialWallet);
  const [activity, setActivity] = useState<Activity[]>([]);
  // The last live rescore: what moved, shown briefly on the card.
  const [live, setLive] = useState<{ at: number; scoreBefore: number; score: number; changes: FactorChange[] } | null>(null);
  const [quoteErr, setQuoteErr] = useState<string | null>(null);
  const [quoting, setQuoting] = useState(false);
  const [loans, setLoans] = useState<XlsLoanRecord[]>([]);
  const [alerts, setAlerts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());
  const [memo, setMemo] = useState<AgentText | null>(null);
  const [requote, setRequote] = useState(0);
  const toast = useToast();
  const seq = useRef(0);
  // The max on screen answers this request; the server-rendered one counts.
  const maxFor = useRef(initialMax ? `${defaultShares}|${gpuId}|0` : "");

  const held = Number(portfolio.shares.find((s) => s.gpuId === gpuId)?.qty ?? 0);
  const code = `${gpuLabel} shares`;

  const refresh = useCallback(async () => {
    const [p, l] = await Promise.all([getPortfolio(ACCOUNT).catch(() => null), listLoans(ACCOUNT).catch(() => null)]);
    if (p) setPortfolio(p);
    if (l) setLoans(l.loans);
  }, []);

  // Credit profile (cached by the api). The server usually renders it already.
  useEffect(() => {
    if (initialProfile && requote === 0) return;
    let alive = true;
    borrowerProfile(ACCOUNT)
      .then((p) => alive && setProfile(p))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [initialProfile, requote]);

  // The connected wallet's newest transactions (the feed then grows live).
  useEffect(() => {
    if (!wallet) return setActivity([]);
    let alive = true;
    walletGet(ACCOUNT)
      .then((r) => alive && setActivity(((r as { activity?: Activity[] }).activity ?? []).slice(0, 8)))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [wallet]);

  // Live rescore from the credit service (Quicknode WebSocket on the wallet):
  // add the tx to the feed, highlight what moved, refetch the profile, the max
  // and the quote (and so the memo).
  useApiEvents(["credit"], (_type, data) => {
    if (data?.kind !== "PROFILE_CHANGED" || !profile || data.borrower !== profile.address) return;
    // Connected (or switched) from another tab or device: pick the wallet up too.
    if (wallet?.address !== data.address) walletGet(ACCOUNT).then((r) => setWallet(r.wallet)).catch(() => {});
    const item = data.activity as Activity | undefined;
    // The new profile and what moved land together, so highlighted rows already show the new points.
    borrowerProfile(ACCOUNT)
      .then(setProfile)
      .catch(() => {})
      .finally(() => {
        if (item) setActivity((list) => [item, ...list.filter((x) => x.txHash !== item.txHash)].slice(0, 8));
        setLive({ at: Date.now(), scoreBefore: data.scoreBefore, score: data.score, changes: data.changes ?? [] });
        setRequote((n) => n + 1);
      });
  });
  useEffect(() => {
    if (!live) return;
    const t = setTimeout(() => setLive((l) => (l && Date.now() - l.at >= HIGHLIGHT_MS ? null : l)), HIGHLIGHT_MS);
    return () => clearTimeout(t);
  }, [live]);

  // Largest approved amount for the shares entered, shown under the amount field.
  useEffect(() => {
    const s = Number(shares);
    if (!(s > 0)) return setMax(null);
    const key = `${s}|${gpuId}|${requote}`;
    if (key === maxFor.current) return;
    let alive = true;
    const t = setTimeout(() => {
      maxPrincipal(ACCOUNT, gpuId, String(s))
        .then((m) => {
          if (!alive) return;
          maxFor.current = key;
          setMax(m);
        })
        .catch(() => alive && setMax(null));
    }, 300);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [shares, gpuId, requote]);

  // Live quote once an amount is entered, debounced. Stale responses are dropped.
  useEffect(() => {
    const s = Number(shares);
    const p = Number(principal);
    if (!(s > 0) || !(p > 0)) {
      ++seq.current;
      setQuote(null);
      setQuoting(false);
      setQuoteErr(null);
      return;
    }
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
      setPrincipal(""); // a quote opens one loan; the next one starts from a fresh amount
      setRequote((n) => n + 1); // the profile and the max change after a loan
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
  // The profile drives the card: it is refetched on every wallet change, so it
  // is never older than the quote's copy.
  const credit = profile ?? quote?.credit;
  const changed = new Map((live?.changes ?? []).map((c) => [c.feature, c]));
  const topFactors = credit
    ? Object.entries(credit.features)
        .filter(([k, f]) => f.points !== 0 || changed.has(k))
        .sort((a, b) => Number(changed.has(b[0])) - Number(changed.has(a[0])) || Math.abs(b[1].points) - Math.abs(a[1].points))
        .slice(0, Math.max(5, changed.size))
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
                <div className={live && live.score !== live.scoreBefore ? "score flash" : "score"}>
                  <div className="bignum">{credit.score}</div>
                  <div>
                    <div className="grade">Grade {credit.grade}</div>
                    <div className="muted">{credit.confidence} confidence</div>
                  </div>
                </div>
                <WalletConnect
                  borrower={ACCOUNT}
                  wallet={wallet}
                  onChange={(w) => {
                    setWallet(w);
                    setRequote((n) => n + 1); // new history: refetch the profile, the max and the quote
                  }}
                />
                {live && live.changes.length > 0 && (
                  <p className="changes">
                    {live.score !== live.scoreBefore ? `Score ${live.scoreBefore} to ${live.score}. ` : "Updated just now. "}
                    {live.changes.map(changeText).join(" · ")}
                  </p>
                )}
                <div className="factors">
                  {topFactors.map(([k, f]) => (
                    <div key={k} className={changed.has(k) ? "flash" : undefined}>
                      <span>
                        {FACTOR_TEXT[k] ?? k}
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
                            const url = txUrl(f.from ?? credit.network, h);
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
                    {credit.components.map((c) =>
                      c.role === "reference" ? (
                        <div key={c.part} className="ref">
                          <span>
                            Mainnet history · {shortHash(c.address)} · score {c.ownScore.score}
                          </span>
                        </div>
                      ) : (
                        <div key={c.part}>
                          <b>{c.part}</b>
                          <span>
                            {c.network === "mainnet" ? "" : `XRPL ${c.network} · `}
                            {shortHash(c.address)}
                            {c.weight !== undefined ? ` · weighted ${Math.round(c.weight * 100)}%` : ""}
                          </span>
                          {/* the wallet row above already says it for a connected wallet */}
                          {c.ownership && !c.ownership.verified && !wallet && <span className="unverified">Ownership not verified</span>}
                        </div>
                      )
                    )}
                  </div>
                )}
                {wallet && activity.length > 0 && (
                  <div className="activity">
                    <span className="lbl">Wallet activity</span>
                    {activity.map((a) => (
                      <div key={a.txHash}>
                        <span>{clock(a.at)}</span>
                        <span>{activityText(a)}</span>
                        <b>{a.amount ? `${fmt(Number(a.amount), 2)} ${a.currency ?? ""}` : ""}</b>
                        <span>{a.counterparty ? shortHash(a.counterparty) : ""}</span>
                        <TxLink network={a.network} hash={a.txHash} />
                      </div>
                    ))}
                  </div>
                )}
                {credit.components?.some((c) => c.source === "quicknode") && <p className="via">via Quicknode</p>}
              </>
            ) : (
              <p className="note">{"Reading your payment history..."}</p>
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
                  <input
                    id="amt"
                    type="text"
                    autoComplete="off"
                    placeholder="0"
                    value={principal}
                    inputMode="decimal"
                    onChange={(e) => setPrincipal(typedAmount(e.target.value))}
                  />
                  <span>USDC</span>
                </div>
                {max && Number(max.maxPrincipal) > 0 ? (
                  <button type="button" className="note max-hint" onClick={() => setPrincipal(String(Number(max.maxPrincipal)))}>
                    Up to {fmt(Number(max.maxPrincipal), 0)} USDC
                  </button>
                ) : (
                  <span className="note">{max ? "No approved amount for these shares" : " "}</span>
                )}
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
                    {!memo.fellBack && <span className="via">via Amazon Bedrock</span>}
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
                  : Number(principal) > 0
                    ? `Lock ${fmt(Number(shares) || 0, 0)} ${code}, borrow ${fmt(Number(principal), 2)} USDC`
                    : "Enter an amount"}
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
