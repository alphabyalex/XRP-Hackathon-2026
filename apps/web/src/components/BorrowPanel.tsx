"use client";
// The Home borrow card: what borrowing against this GPU's shares costs right
// now. The chart is the base APR from GET /lending/base-apr, live (5 s and on
// loan events); until that route answers, the APR of each real loan at
// origination. Collateral value is the typed shares at the live share price;
// capital is what the lending round has available. The quote itself is on /borrow.
import { useEffect, useState } from "react";
import type { VaultOverview, XlsLoanRecord } from "@moonshift/shared";
import { usePolled } from "@/lib/liveData";
import { lendingBaseApr, useApiEvents } from "@/lib/lendingApi";
import { fmt, typedAmount } from "@/lib/format";
import { Button } from "./Button";
import { LiveLine, type LinePoint } from "./charts";

type BaseApr = { apr?: number | string; baseApr?: number | string; baseAprPct?: number | string; series?: any[]; history?: any[] };

const asPct = (v: unknown) => {
  const n = Number(v);
  if (v === null || v === undefined || v === "" || !Number.isFinite(n)) return null;
  return n > 0 && n < 1 ? n * 100 : n;
};

// GET /lending/base-apr every 5 s and on loan and risk events. A 404 (not
// deployed yet) is asked again a minute later, not every poll.
function useBaseApr(): { data: BaseApr | null } {
  const [data, setData] = useState<BaseApr | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let alive = true;
    lendingBaseApr().then((d) => alive && d && setData(d));
    const t = setTimeout(() => setTick((n) => n + 1), 5000);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [tick]);
  useApiEvents(["loan", "risk"], () => setTick((n) => n + 1));
  return { data };
}

export function BorrowPanel({ gpuId, gpuLabel, sharePrice }: { gpuId: string; gpuLabel: string; sharePrice: number; maxShares?: number; onBorrowed?: () => void }) {
  const [shares, setShares] = useState("");
  const base = useBaseApr();
  const vault = usePolled<VaultOverview>("/vault", { ms: 5000, on: ["vault", "loan"] });
  const loans = usePolled<{ loans: XlsLoanRecord[] }>(base.data ? null : "/loans", { ms: 15000, on: ["loan"] });

  const baseNow = asPct(base.data?.baseAprPct ?? base.data?.baseApr ?? base.data?.apr);
  const series: LinePoint[] = base.data
    ? (base.data.series ?? base.data.history ?? [])
        .map((p: any) => ({ t: new Date(p.at ?? p.t).getTime(), v: asPct(p.apr ?? p.baseApr ?? p.v) ?? NaN }))
        .filter((p: LinePoint) => Number.isFinite(p.t) && Number.isFinite(p.v))
    : (loans.data?.loans ?? []).map((l) => ({ t: new Date(l.openedAt).getTime(), v: Number(l.apr) * 100 }));
  const recent = !base.data && series.length ? series.reduce((a, b) => (b.t > a.t ? b : a)).v : null;
  const apr = baseNow ?? recent;
  const available = vault.data?.investing ? Number(vault.data.investing.assetsAvailable) : null;
  const s = Number(shares) || 0;

  return (
    <div className="trade" style={{ padding: 26 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 12, flexWrap: "wrap" }}>
        <span className="lbl" style={{ margin: 0 }}>
          Borrow against {gpuLabel} shares
        </span>
        <span className="lbl" style={{ margin: 0 }}>
          {base.data ? "Base APR, live" : "APR of recent loans"}
        </span>
      </div>
      <div className="bignum" style={{ marginTop: 6 }}>
        {apr !== null ? `${fmt(apr, 2)}%` : "..."}
      </div>
      <LiveLine key={series.length} points={series} unit="%" height={120} area={false} label="Borrow APR" format={(v) => fmt(v, 2)} empty="Waiting for the first loan" />
      <label className="lbl" htmlFor="home-coll" style={{ marginTop: 14 }}>
        Shares to lock
      </label>
      <div className="inp">
        <input id="home-coll" type="text" autoComplete="off" placeholder="0" value={shares} inputMode="numeric" onChange={(e) => setShares(typedAmount(e.target.value, false))} />
        <span>shares</span>
      </div>
      <div className="line" style={{ marginTop: 14 }}>
        <span>Collateral value</span>
        <b>{sharePrice > 0 ? `${fmt(s * sharePrice, 2)} USDC` : "..."}</b>
      </div>
      <div className="line">
        <span>Available to borrow from the lending round</span>
        <b>{available !== null ? `${fmt(available, 2)} USDC` : "..."}</b>
      </div>
      <Button href={s > 0 ? `/borrow?gpu=${gpuId}&shares=${s}` : "/borrow"} arrow>
        Get your quote
      </Button>
    </div>
  );
}
