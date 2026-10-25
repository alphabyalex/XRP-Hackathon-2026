"use client";
// /borrow: credit profile, live risk quote, Bedrock memo, then a real XLS-66
// loan on devnet with GPU shares escrowed. Loan health updates live.
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import type {
  AgentText,
  CreditProfile,
  LoanQuoteApiResponse,
  PortfolioResponse,
  XlsLoanRecord,
} from "@moonshift/shared";
import { getGpu, getPortfolio } from "@/lib/api";
import { fmt, shortHash, typedAmount, usdc } from "@/lib/format";
import {
  ApiCodeError,
  getVault,
  borrowerProfile,
  collateralOptions,
  listLoans,
  maxPrincipal,
  openFromQuote,
  walletGet,
  type CollateralOption,
  type ConnectedWallet,
  payNext,
  payOff,
  pct,
  quoteLoan,
  quoteMemo,
  txUrl,
  useApiEvents,
} from "@/lib/lendingApi";
import { Button } from "./Button";
import { useToast } from "./Toast";
import { HealthMeter, LoanTxs, StatusChip, TxLink } from "./LendingBits";
import { WalletConnect } from "./WalletConnect";
import { useWallet } from "@/lib/wallet";
import { ConnectPrompt } from "./ConnectPrompt";
import "./lending/lending.css";
import type { VaultOverview } from "@moonshift/shared";
import type { LinePoint } from "./charts";
import { BorrowCharts } from "./lending/BorrowCharts";
import { AccountHistory } from "./lending/AccountHistory";
import { Apply } from "./lending/Apply";
import { NetworkLine } from "./lending/NetworkLine";

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
type FactorChange = {
  feature: string;
  before: unknown;
  after: unknown;
  pointsBefore: number;
  pointsAfter: number;
  delta: number;
};

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
  return c.delta !== 0
    ? `${label} ${c.delta > 0 ? "+" : ""}${c.delta} (${move})`
    : `${label} ${move}`;
}

// Open loans, locked collateral and DEX offers (account_objects, account_offers via Quicknode).
function obligationText(c: unknown) {
  const o = (c as { history?: { obligations?: Record<string, number> | null } })
    .history?.obligations;
  if (!o) return null;
  const parts = [
    o.loans ? `${o.loans} open loan${o.loans > 1 ? "s" : ""}` : "",
    o.escrows ? `${o.escrows} locked collateral` : "",
    o.offers ? `${o.offers} open offer${o.offers > 1 ? "s" : ""}` : "",
  ].filter(Boolean);
  return parts.length ? parts.join(", ") : "no open obligations";
}

function activityText(a: Activity) {
  if (a.type !== "Payment") return a.type;
  return a.direction === "out" ? "Sent" : "Received";
}

function clock(iso: string) {
  return new Date(iso).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

function days(seconds: number) {
  const d = seconds / 86400;
  // One decimal unless whole, the same way the credit memo writes it.
  return d >= 1
    ? `${fmt(d, Number.isInteger(Math.round(d * 10) / 10) ? 0 : 1)} days`
    : `${Math.round(seconds / 60)} min`;
}

function until(iso: string | null | undefined, now: number) {
  if (!iso) return "none";
  const ms = new Date(iso).getTime() - now;
  if (ms <= 0) return "now";
  const h = Math.floor(ms / 3600e3);
  const m = Math.floor((ms % 3600e3) / 60e3);
  return h >= 24 ? `${Math.floor(h / 24)}d ${h % 24}h` : `${h}h ${m}m`;
}

type MaxAmount = {
  maxPrincipal: string;
  collateralValue: string;
  termSeconds: number;
};

export function BorrowContent({
  initialPortfolio,
  initialProfile,
  initialMax,
  initialWallet,
  defaultShares,
  gpuId: initialGpuId,
}: {
  initialPortfolio: PortfolioResponse | null;
  initialProfile: CreditProfile | null;
  initialMax: MaxAmount | null;
  initialWallet: ConnectedWallet | null;
  defaultShares: string;
  gpuId: string;
}) {
  const [portfolio, setPortfolio] = useState(initialPortfolio);
  // The GPU whose shares are locked. Every GPU the account holds is offered.
  const [gpuId, setGpuId] = useState(initialGpuId);
  const [options, setOptions] = useState<CollateralOption[] | null>(null);
  // The api refused an amount above the limit (409 OVER_LIMIT).
  const [refused, setRefused] = useState<string | null>(null);
  // The lending round that funds the loan, and the collateral's real hourly prices.
  const [vault, setVault] = useState<VaultOverview | null>(null);
  const [priceHistory, setPriceHistory] = useState<
    { t: number; price: number }[]
  >([]);
  const [coverage, setCoverage] = useState<LinePoint[]>([]);
  const [shares, setShares] = useState(defaultShares);
  // The borrower types the amount; the largest approved one is shown beside it.
  const [principal, setPrincipal] = useState("");
  const [max, setMax] = useState<MaxAmount | null>(initialMax);
  const [quote, setQuote] = useState<LoanQuoteApiResponse | null>(null);
  const [profile, setProfile] = useState<CreditProfile | null>(initialProfile);
  // The site-wide wallet (header pill). Until the api answers, the server-rendered one stands in.
  const site = useWallet();
  const wallet = site.loaded ? site.wallet : (site.wallet ?? initialWallet);
  const walletKey = wallet?.address ?? "";
  const firstWallet = useRef(walletKey);
  useEffect(() => {
    if (walletKey === firstWallet.current) return;
    firstWallet.current = walletKey;
    setRequote((n) => n + 1); // new history: refetch the profile, the max and the quote
  }, [walletKey]);
  const [activity, setActivity] = useState<Activity[]>([]);
  const [allFactors, setAllFactors] = useState(false);
  const [allActivity, setAllActivity] = useState(false);
  // The last live rescore: what moved, shown briefly on the card.
  const [live, setLive] = useState<{
    at: number;
    scoreBefore: number;
    score: number;
    changes: FactorChange[];
  } | null>(null);
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

  const option = options?.find((o) => o.gpuId === gpuId);
  const held =
    option?.shares ??
    Number(portfolio?.shares.find((s) => s.gpuId === gpuId)?.qty ?? 0);
  const gpuLabel = option?.label ?? gpuId.toUpperCase();
  const code = `${gpuLabel} shares`;

  const refresh = useCallback(async () => {
    const [p, l, o] = await Promise.all([
      getPortfolio().catch(() => null),
      listLoans(true).catch(() => null),
      collateralOptions().catch(() => null),
    ]);
    if (p) setPortfolio(p);
    if (l) setLoans(l.loans);
    if (o) setOptions(o);
  }, []);

  // Start on a GPU the account actually holds.
  useEffect(() => {
    if (!options?.length || options.some((o) => o.gpuId === gpuId)) return;
    setGpuId(options[0].gpuId);
  }, [options, gpuId]);

  function pickGpu(id: string) {
    if (id === gpuId) return;
    const h = options?.find((o) => o.gpuId === id)?.shares ?? 0;
    setGpuId(id);
    setMax(null);
    setQuote(null);
    setRefused(null);
    // Keep the typed share count unless the new GPU has fewer.
    if (Number(shares) > h) setShares(h > 0 ? String(Math.floor(h)) : "");
    setCoverage([]);
  }

  // The round lending now: which market funds the loan and what it has available.
  useEffect(() => {
    let alive = true;
    const load = () =>
      getVault()
        .then((v) => alive && setVault(v))
        .catch(() => {});
    void load();
    const t = setInterval(load, 15_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  // The GPU's hourly share prices plus the live one, for LTV over time.
  useEffect(() => {
    let alive = true;
    const load = () =>
      getGpu(gpuId)
        .then((g) => {
          if (!alive) return;
          const hist = (
            (g as { priceHistory?: { t: number; price: number }[] })
              .priceHistory ?? []
          ).filter((p) => p.price > 0);
          const now = Number(g.sharePrice);
          setPriceHistory(
            now > 0 ? [...hist, { t: Date.now(), price: now }] : hist,
          );
        })
        .catch(() => {});
    void load();
    const t = setInterval(load, 30_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [gpuId]);

  // Credit profile (cached by the api). The server usually renders it already.
  useEffect(() => {
    if (initialProfile && requote === 0) return;
    let alive = true;
    // A new wallet's first score can take a few seconds: retry rather than give up.
    (async () => {
      for (let i = 0; i < 5 && alive; i++) {
        try {
          const p = await borrowerProfile();
          if (alive) setProfile(p);
          return;
        } catch {
          await new Promise((r) => setTimeout(r, 1500));
        }
      }
    })();
    return () => {
      alive = false;
    };
  }, [initialProfile, requote]);

  // The connected wallet's newest transactions (the feed then grows live).
  useEffect(() => {
    if (!wallet) return setActivity([]);
    let alive = true;
    walletGet()
      .then(
        (r) =>
          alive &&
          setActivity(
            ((r as { activity?: Activity[] }).activity ?? []).slice(0, 8),
          ),
      )
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [wallet]);

  // Live rescore from the credit service (Quicknode WebSocket on the wallet):
  // add the tx to the feed, highlight what moved, refetch the profile, the max
  // and the quote (and so the memo).
  useApiEvents(["credit"], (_type, data) => {
    if (
      data?.kind !== "PROFILE_CHANGED" ||
      !profile ||
      data.borrower !== profile.address
    )
      return;
    // Connected (or switched) from another tab or device: pick the wallet up too.
    if (wallet?.address !== data.address) void site.refresh();
    const item = data.activity as Activity | undefined;
    // The new profile and what moved land together, so highlighted rows already show the new points.
    borrowerProfile()
      .then(setProfile)
      .catch(() => {})
      .finally(() => {
        if (item)
          setActivity((list) =>
            [item, ...list.filter((x) => x.txHash !== item.txHash)].slice(0, 8),
          );
        setLive({
          at: Date.now(),
          scoreBefore: data.scoreBefore,
          score: data.score,
          changes: data.changes ?? [],
        });
        setRequote((n) => n + 1);
      });
  });
  // The same rescore without the events stream: the api's cached profile, every 10 s.
  const shownScore = profile?.score;
  useEffect(() => {
    if (!walletKey) return;
    const t = setInterval(() => {
      borrowerProfile()
        .then((p) => {
          if (p.score === shownScore) return;
          setProfile(p);
          setRequote((n) => n + 1);
        })
        .catch(() => {});
    }, 10_000);
    return () => clearInterval(t);
  }, [walletKey, shownScore]);

  useEffect(() => {
    if (!live) return;
    const t = setTimeout(
      () => setLive((l) => (l && Date.now() - l.at >= HIGHLIGHT_MS ? null : l)),
      HIGHLIGHT_MS,
    );
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
      maxPrincipal(gpuId, String(s))
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

  const maxNum = max ? Number(max.maxPrincipal) : null;
  // Above the approved amount: no quote and no loan, only the limit.
  const overMax = maxNum !== null && Number(principal) > maxNum;
  useEffect(() => setRefused(null), [principal, shares, gpuId]);

  // Live quote once an amount is entered, debounced. Stale responses are dropped.
  useEffect(() => {
    const s = Number(shares);
    const p = Number(principal);
    if (!(s > 0) || !(p > 0) || overMax) {
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
        const q = await quoteLoan(gpuId, String(s), String(p));
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
  }, [shares, principal, gpuId, requote, overMax]);

  // Each live quote adds a coverage point.
  useEffect(() => {
    if (!quote || quote.counterOffer) return;
    const v = Number(quote.quote.coverageRatio);
    if (Number.isFinite(v))
      setCoverage((c) => [...c, { t: Date.now(), v }].slice(-120));
  }, [quote]);

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
    if (!walletKey) {
      setLoans([]);
      return;
    }
    void refresh();
    const t = setInterval(() => setNow(Date.now()), 1000);
    // 5 s: where the events stream cannot reach the page (some tunnels drop SSE), polling still moves it.
    const poll = setInterval(() => void refresh(), 5_000);
    return () => {
      clearInterval(t);
      clearInterval(poll);
    };
  }, [refresh, walletKey]);

  useApiEvents(["loan", "vault", "risk"], (type, data) => {
    if (type === "vault")
      getVault()
        .then(setVault)
        .catch(() => {});
    if (type === "loan" && data?.alert?.text)
      setAlerts((a) => ({ ...a, [data.id]: data.alert.text }));
    if (type === "loan" && data?.type === "margin_call")
      toast("Margin call", `${data.alert?.text?.slice(0, 120) ?? ""}`);
    if (type === "loan" && data?.type === "liquidated")
      toast("Loan liquidated", "Your locked shares repaid the loan.", data.tx);
    void refresh();
  });

  async function doOpen() {
    if (!quote || busy || blocked) return;
    setBusy("open");
    try {
      const loan = await openFromQuote(quote.quoteId);
      toast(
        `Borrowed ${usdc(loan.principal)} USDC`,
        `${fmt(Number(loan.collateralShares), 0)} ${code} locked`,
        loan.txs.loanSet,
      );
      setPrincipal(""); // a quote opens one loan; the next one starts from a fresh amount
      setRequote((n) => n + 1); // the profile and the max change after a loan
      await refresh();
    } catch (e) {
      if (e instanceof ApiCodeError && e.code === "OVER_LIMIT") {
        setRefused(e.message);
        setRequote((n) => n + 1); // refetch the limit the api enforced
      } else toast("Borrow failed", (e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function doPay(loan: XlsLoanRecord, full: boolean) {
    setBusy(loan.id + (full ? "full" : "next"));
    try {
      const r = full ? await payOff(loan.id) : await payNext(loan.id);
      if (full)
        toast(
          "Loan paid off",
          `${fmt(Number(r.collateralShares), 0)} ${code} back in your wallet`,
          r.txs.release,
        );
      else toast("Installment paid", "", r.txs.pay);
      await refresh();
    } catch (e) {
      toast("Payment failed", (e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  // A counter-offer is a smaller loan than asked: shown as the limit, never opened.
  const limit = quote?.counterOffer
    ? Number(quote.counterOffer.offered)
    : maxNum;
  const overLimit = overMax || !!quote?.counterOffer || !!refused;
  const overHeld = Number(shares) > held;
  const blocked = overLimit || overHeld;
  const q = overLimit ? undefined : quote?.quote;
  const inv = vault?.investing ?? null;
  const active = loans.filter(
    (l) => l.status === "open" || l.status === "margin_call",
  );
  // The profile drives the card: it is refetched on every wallet change, so it
  // is never older than the quote's copy.
  const credit = profile ?? quote?.credit;
  const changed = new Map((live?.changes ?? []).map((c) => [c.feature, c]));
  const factors = credit
    ? Object.entries(credit.features)
        .filter(([k, f]) => f.points !== 0 || changed.has(k))
        .sort(
          (a, b) =>
            Number(changed.has(b[0])) - Number(changed.has(a[0])) ||
            Math.abs(b[1].points) - Math.abs(a[1].points),
        )
    : [];
  // The top 3 (and any that just changed); the rest behind "Show all".
  const topFactors = allFactors
    ? factors
    : factors.slice(0, Math.max(3, changed.size));
  const shownActivity = allActivity ? activity : activity.slice(0, 3);

  const head = (
    <div className="shead">
      <h2>Borrow against your GPU shares.</h2>
      <p>
        Your shares stay yours. They are locked while you borrow USDC from the
        Moonshift lending vault and come back the moment you repay. Terms come
        from your payment history and the GPU&apos;s real revenue.
      </p>
    </div>
  );

  if (!wallet) {
    return (
      <main className="s">
        <div className="wrap">
          {head}
          <div className="trade card">
            <ConnectPrompt />
          </div>
          <Apply />
        </div>
      </main>
    );
  }

  return (
    <main className="s">
      <div className="wrap">
        <div className="shead bw-head">
          <h2>Borrow against your GPU shares.</h2>
          <p>
            Lock shares, borrow USDC from the lending round, and get them back
            the moment you repay. Terms come from your payment history and the
            GPU&apos;s real revenue.
          </p>
        </div>

        <div className="lend-grid bw-grid">
          {/* Credit profile */}
          <div className="trade card bw-credit">
            <div className="bw-card-head">
              <span className="lbl" style={{ margin: 0 }}>
                Credit rating
              </span>
              <NetworkLine />
            </div>
            {credit ? (
              <>
                <div
                  className={
                    live && live.score !== live.scoreBefore
                      ? "score flash"
                      : "score"
                  }
                >
                  <div className="bignum">{credit.score}</div>
                  <div>
                    <div className="grade">Grade {credit.grade}</div>
                    <div className="muted">{credit.confidence} confidence</div>
                  </div>
                </div>
                <WalletConnect />
                {live && live.changes.length > 0 && (
                  <p className="changes">
                    {live.score !== live.scoreBefore
                      ? `Score ${live.scoreBefore} to ${live.score}. `
                      : "Updated just now. "}
                    {live.changes.map(changeText).join(" · ")}
                  </p>
                )}
                <div className="factors">
                  {topFactors.map(([k, f]) => {
                    // The factor's name links to the transaction behind it.
                    const hash = f.txHashes.find((h) => !/^0+[0-9]$/.test(h));
                    const url = hash
                      ? txUrl(f.from ?? credit.network, hash)
                      : null;
                    const name = FACTOR_TEXT[k] ?? k;
                    return (
                      <div
                        key={k}
                        className={changed.has(k) ? "flash" : undefined}
                      >
                        <span>
                          {url ? (
                            <a
                              className="factor-link"
                              href={url}
                              target="_blank"
                              rel="noreferrer"
                            >
                              {name}
                            </a>
                          ) : (
                            name
                          )}
                        </span>
                        <b className={f.points < 0 ? "dn" : "up"}>
                          {f.points > 0 ? "+" : ""}
                          {f.points}
                        </b>
                      </div>
                    );
                  })}
                </div>
                {factors.length > 3 && (
                  <button
                    type="button"
                    className="linkish more"
                    onClick={() => setAllFactors((v) => !v)}
                  >
                    {allFactors
                      ? "Show fewer"
                      : `Show all ${factors.length} factors`}
                  </button>
                )}
                {credit.components && credit.components.length > 0 && (
                  <div className="sources">
                    {credit.components.map((c) =>
                      c.role === "reference" ? (
                        <div key={c.part} className="ref">
                          <span>
                            Wallet history · {shortHash(c.address)} · score{" "}
                            {c.ownScore.score}
                          </span>
                        </div>
                      ) : (
                        <div key={c.part}>
                          <b>{c.part}</b>
                          <span>
                            {shortHash(c.address)}
                            {obligationText(c) && ` · ${obligationText(c)}`}
                          </span>
                          {/* the wallet row above already says it for a connected wallet */}
                          {c.ownership && !c.ownership.verified && !wallet && (
                            <span className="unverified">
                              Ownership not verified
                            </span>
                          )}
                        </div>
                      ),
                    )}
                  </div>
                )}
                {wallet && activity.length > 0 && (
                  <div className="activity">
                    <span className="lbl">Wallet activity</span>
                    {shownActivity.map((a) => (
                      <div key={a.txHash}>
                        <span>{clock(a.at)}</span>
                        <span>{activityText(a)}</span>
                        <b>
                          {a.amount
                            ? `${fmt(Number(a.amount), 2)} ${a.currency ?? ""}`
                            : ""}
                        </b>
                        <span>
                          {a.counterparty ? shortHash(a.counterparty) : ""}
                        </span>
                        <TxLink network={a.network} hash={a.txHash} />
                      </div>
                    ))}
                    {activity.length > 3 && (
                      <button
                        type="button"
                        className="linkish more"
                        onClick={() => setAllActivity((v) => !v)}
                      >
                        {allActivity ? "Show fewer" : "Show all"}
                      </button>
                    )}
                  </div>
                )}
              </>
            ) : (
              <p className="note">{"Reading your payment history..."}</p>
            )}
          </div>

          {/* Quote and open */}
          <div className="bw-right">
            <div className="trade card">
              {inv ? (
                <div className="bw-fund">
                  <span>
                    Funded by <Link href="/lend">round {inv.round}</Link>
                  </span>
                  <b>{fmt(Number(inv.assetsAvailable), 2)} USDC available</b>
                </div>
              ) : vault ? (
                <div className="bw-fund">
                  <span>No round is lending right now.</span>
                </div>
              ) : null}
              <div className="gpu-pick">
                <span className="lbl">Collateral</span>
                {options === null ? (
                  <p className="note">Reading your holdings...</p>
                ) : options.length === 0 ? (
                  <p className="note">
                    You hold no GPU shares yet. Buy shares on the Market to
                    borrow against them.
                  </p>
                ) : (
                  <div
                    className="gpu-opts"
                    role="radiogroup"
                    aria-label="GPU to borrow against"
                  >
                    {options.map((o) => (
                      <button
                        key={o.gpuId}
                        type="button"
                        role="radio"
                        aria-checked={o.gpuId === gpuId}
                        className={o.gpuId === gpuId ? "gpu-opt on" : "gpu-opt"}
                        onClick={() => pickGpu(o.gpuId)}
                      >
                        <b>{o.label}</b>
                        <span>{fmt(o.shares, 0)} shares</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
              <div className="two">
                <div>
                  <label className="lbl" htmlFor="coll">
                    Shares to lock
                  </label>
                  <div className="inp">
                    <input
                      id="coll"
                      type="text"
                      autoComplete="off"
                      value={shares}
                      inputMode="numeric"
                      onChange={(e) =>
                        setShares(typedAmount(e.target.value, false))
                      }
                    />
                    <span>shares</span>
                  </div>
                  <span className={overHeld ? "note dn" : "note"}>
                    You hold {fmt(held, 0)} {code}
                  </span>
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
                      onChange={(e) =>
                        setPrincipal(typedAmount(e.target.value))
                      }
                    />
                    <span>USDC</span>
                  </div>
                  {overLimit && limit !== null ? (
                    <span className="note dn">
                      You can borrow up to {fmt(limit, 2)} USDC against these
                      shares
                    </span>
                  ) : refused ? (
                    <span className="note dn">{refused}</span>
                  ) : max && Number(max.maxPrincipal) > 0 ? (
                    <button
                      type="button"
                      className="note max-hint"
                      onClick={() =>
                        setPrincipal(String(Number(max.maxPrincipal)))
                      }
                    >
                      Up to {fmt(Number(max.maxPrincipal), 0)} USDC
                    </button>
                  ) : (
                    <span className="note">
                      {max ? "No approved amount for these shares" : " "}
                    </span>
                  )}
                </div>
              </div>

              {q && (
                <>
                  <div
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "flex-end",
                      marginTop: 22,
                      gap: 12,
                      flexWrap: "wrap",
                    }}
                  >
                    <div>
                      <span className="lbl">APR</span>
                      <div className="bignum">{pct(q.apr, 2)}</div>
                    </div>
                    <span
                      className={
                        q.decision === "approve"
                          ? "chip chip-open"
                          : "chip chip-defaulted"
                      }
                    >
                      {q.decision === "approve" ? "Approved" : "Declined"}
                      {quoting ? "..." : ""}
                    </span>
                  </div>
                  <HealthMeter
                    ltv={Number(q.ltv)}
                    marginCallLtv={Number(q.marginCallLtv)}
                    liquidationLtv={Number(q.liquidationLtv)}
                  />
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
                      {days(quote!.terms.termSeconds)},{" "}
                      {quote!.terms.paymentTotal} payments
                    </b>
                  </div>
                  {q.reasons.length > 0 && (
                    <p className="note">
                      Risk flags:{" "}
                      {q.reasons.join(", ").toLowerCase().replace(/_/g, " ")}
                    </p>
                  )}
                </>
              )}
              {quoteErr && !q && !overLimit && (
                <p className="note dn">{quoteErr}</p>
              )}
              <Button
                disabled={
                  !q || q.decision !== "approve" || !!busy || quoting || blocked
                }
                onClick={doOpen}
              >
                {busy === "open"
                  ? "Opening your loan..."
                  : overHeld
                    ? `You hold ${fmt(held, 0)} ${code}`
                    : overLimit
                      ? "Above your limit"
                      : q?.decision === "decline"
                        ? "Not approved"
                        : Number(principal) > 0
                          ? `Lock ${fmt(Number(shares) || 0, 0)} ${code}, borrow ${fmt(Number(principal), 2)} USDC`
                          : "Enter an amount"}
              </Button>
            </div>
            {/* Before a quote, the collateral's price fills the column under the panel. */}
            {!q && (
              <BorrowCharts
                quote={null}
                priceHistory={priceHistory}
                coverage={coverage}
                gpuLabel={gpuLabel}
              />
            )}
          </div>
          {/* The credit memo sits under the rating on wide screens, after the quote on phones. */}
          {q && (
            <div className="trade card bw-memo">
              <span className="lbl">Credit memo</span>
              {memo ? (
                <blockquote className="memo" style={{ marginTop: 6 }}>
                  {memo.text.replace(/TDX/g, "USDC")}
                  {!memo.fellBack && <span className="via">via Amazon Bedrock</span>}
                </blockquote>
              ) : (
                <p className="memo-pending">Writing credit memo...</p>
              )}
            </div>
          )}
        </div>

        {q && (
          <BorrowCharts
            quote={quote}
            priceHistory={priceHistory}
            coverage={coverage}
            gpuLabel={gpuLabel}
          />
        )}

        {active.length > 0 && (
          <>
            <h3 className="sub-h" style={{ marginTop: 40 }}>
              Your open loans
            </h3>
            <div className="loans">
              {active.map((l) => {
                const h = l.health;
                return (
                  <div className="trade card loan-card" key={l.id}>
                    <div
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                        alignItems: "center",
                        gap: 10,
                      }}
                    >
                      <span className="lbl" style={{ margin: 0 }}>
                        {l.gpuId.toUpperCase()} loan {l.id.slice(0, 8)} · round{" "}
                        {l.round}
                      </span>
                      <StatusChip status={l.status} />
                    </div>
                    <div className="loan-body">
                      <div>
                        <div className="bignum" style={{ marginTop: 10 }}>
                          {fmt(
                            Number(
                              l.ledger?.totalValueOutstanding ?? l.principal,
                            ),
                            2,
                          )}{" "}
                          USDC
                        </div>
                        {h && (
                          <HealthMeter
                            ltv={Number(h.ltv)}
                            marginCallLtv={Number(l.marginCallLtv)}
                            liquidationLtv={Number(l.liquidationLtv)}
                          />
                        )}
                      </div>
                      <div>
                        <div className="line" style={{ marginTop: 16 }}>
                          <span>Collateral</span>
                          <b>
                            {fmt(Number(l.collateralShares), 0)} {code} at{" "}
                            {h ? fmt(Number(h.collateralPrice), 2) : "..."} USDC
                          </b>
                        </div>
                        <div className="line">
                          <span>APR</span>
                          <b>{pct(l.apr, 2)}</b>
                        </div>
                        <div className="line">
                          <span>Next payment</span>
                          <b>
                            {fmt(Number(l.ledger?.periodicPayment ?? 0), 2)}{" "}
                            USDC in {until(l.ledger?.nextPaymentDueDate, now)}
                          </b>
                        </div>
                      </div>
                    </div>
                    {alerts[l.id] && l.status === "margin_call" && (
                      <p className="note dn">{alerts[l.id]}</p>
                    )}
                    <LoanTxs loan={l} />
                    <div className="two" style={{ marginTop: 6 }}>
                      <Button
                        variant="ghost"
                        disabled={!!busy}
                        onClick={() => doPay(l, false)}
                      >
                        {busy === l.id + "next"
                          ? "Paying..."
                          : "Pay installment"}
                      </Button>
                      <Button disabled={!!busy} onClick={() => doPay(l, true)}>
                        {busy === l.id + "full"
                          ? "Paying off..."
                          : "Pay off, release shares"}
                      </Button>
                    </div>
                  </div>
                );
              })}
            </div>
          </>
        )}

        <AccountHistory loans={loans} />

        <Apply />
      </div>
    </main>
  );
}
