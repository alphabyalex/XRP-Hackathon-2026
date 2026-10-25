"use client";
import { AccountBalance } from "./AccountBalance";
import dynamic from "next/dynamic";
import { GPUS } from "@moonshift/shared";
import { useLiveGpus, useApiUnreachable, useNow } from "@/lib/liveData";
import { gpuView } from "@/lib/gpuView";
import { fmt } from "@/lib/format";
import { Button } from "./Button";
import { AppWindow } from "./AppWindow";
import { MarketTable } from "./MarketTable";
import { ScheduleRows } from "./ScheduleRows";
import { TradePanel } from "./TradePanel";
import { MoneyStack } from "./MoneyStack";
import { BorrowPanel } from "./BorrowPanel";
import { CodeSample } from "./CodeSample";
import { PlaygroundTry } from "./PlaygroundTry";
import { ApiErrorNotice } from "./ApiErrorNotice";
import { Reveal } from "./Reveal";

const Hero3DMark = dynamic(() => import("./Hero3DMark").then((m) => m.Hero3DMark), {
  ssr: false,
  loading: () => <div className="stage3d" />,
});

export function HomeContent() {
  const gpus = useLiveGpus();
  const now = useNow();
  const unreachable = useApiUnreachable();
  const views = GPUS.map((g) => gpus[g.id]).filter(Boolean).map((g) => gpuView(g, now));
  const featured = views.find((v) => v.gpu.id === "gpu-a") ?? views[0];

  const paidLastNight = views.reduce((s, v) => s + v.split.holders, 0);
  const avgUtil = views.length ? views.reduce((s, v) => s + (Number(v.gpu.utilizationPct) || 0), 0) / views.length : 0;

  return (
    <main id="top">
      <section className="hero">
        <div className="wrap hero-in">
          <div>
            <h1>
              Own a <em>share</em> of a GPU.
            </h1>
            <p className="sub">
              Moonshift splits real GPUs into shares on the XRP Ledger. Customers send tasks, the router runs each one on the best GPU, and every hour a GPU works pays its shareholders. Payouts land every night in USDC.
            </p>
            <div className="ctas">
              <Button href="/market" arrow>
                Browse GPUs
              </Button>
              <Button href="/#schedule" variant="ghost">
                See how it earns
              </Button>
            </div>
            <div className="proof">
              <div>
                <b>{fmt(paidLastNight, 2)} USDC</b>paid to holders last night
              </div>
              <div>
                <b>{fmt(avgUtil, 1)}%</b>of hours earning, 24h
              </div>
              <div>
                <b>{GPUS.length}</b>GPUs live on the XRPL
              </div>
            </div>
          </div>
          <Hero3DMark />
        </div>
      </section>

      {unreachable && (
        <div className="wrap" style={{ paddingBottom: 40 }}>
          <ApiErrorNotice />
        </div>
      )}

      <section className="s tinted" id="market">
        <div className="wrap">
          <Reveal>
            <div className="shead">
              <h2>Two GPUs, trading now.</h2>
              <p>Each one is an NVIDIA T4 running on AWS. Prices come from the order book on the XRP Ledger DEX. Yield is last 24 hours of payouts, annualized.</p>
            </div>
          </Reveal>
          <Reveal>
            <AppWindow tabs={["Market", "Portfolio", "Borrow", "Playground"]} activeTab="Market" acct={<AccountBalance />}>
              <div className="tbl">
                <MarketTable views={views} />
              </div>
            </AppWindow>
          </Reveal>
        </div>
      </section>

      {featured && (
        <section className="s" id="schedule">
          <div className="wrap">
            <Reveal>
              <div className="shead">
                <h2>
                  Working around
                  <br />
                  the clock.
                </h2>
                <p>This is {featured.dashLabel}&apos;s last 20 hours and next 4, in five minute slots. Lit time is the GPU working on customers&apos; tasks; gray is idle. As one task ends the router places the next, so the machine is rarely idle.</p>
              </div>
            </Reveal>
            <div className="sched-grid">
              <Reveal>
                <div>
                <ScheduleRows slots={featured.slots} nowIndex={featured.nowIndex} windowStart={featured.windowStart} />
                <div className="key">
                  <span>
                    <i className="k-l" />
                    Working
                  </span>
                  <span>
                    <i className="k-i" />
                    Idle
                  </span>
                  <span>
                    <i className="k-o" />
                    Open to book
                  </span>
                </div>
                <div className="facts" style={{ marginTop: 40 }}>
                  <div>
                    <span>Earning, last 24h</span>
                    <b>{fmt(Number(featured.gpu.utilizationPct) || 0, 1)}%</b>
                  </div>
                  <div>
                    <span>Revenue, last 24h</span>
                    <b>{fmt(featured.revenue24h, 2)} USDC</b>
                  </div>
                  <div>
                    <span>Paid per share, last 24h</span>
                    <b>{fmt(featured.split.holders / 1000, 6)} USDC</b>
                  </div>
                </div>
                </div>
              </Reveal>
              <Reveal>
                <TradePanel
                  gpuId={featured.gpu.id}
                  gpuLabel={featured.dashLabel}
                  sharePrice={Number(featured.gpu.sharePrice) || 0}
                  revenue24h={featured.revenue24h}
                  nowIndex={featured.nowIndex}
                  slots={featured.slots}
                  windowStart={featured.windowStart}
                />
              </Reveal>
            </div>
          </div>
        </section>
      )}

      {featured && (
        <section className="s tinted">
          <div className="wrap">
            <MoneyStack revenue24h={featured.revenue24h} />
          </div>
        </section>
      )}

      {featured && (
        <section className="s" id="borrow">
          <div className="wrap">
            <div className="borrow">
              <Reveal>
                <div className="shead" style={{ marginBottom: 0 }}>
                  <h2>Borrow without selling.</h2>
                  <p>Lock your shares in an XRPL escrow and borrow up to half their value in USDC. Locked shares keep earning their nightly payout.</p>
                </div>
                <div className="ledger">
                  <div>
                    <code>EscrowCreate</code>
                    <span>locks your shares until the loan is repaid</span>
                  </div>
                  <div>
                    <code>Payment</code>
                    <span>the lending pool sends you USDC</span>
                  </div>
                  <div>
                    <code>Batch</code>
                    <span>both happen together or not at all</span>
                  </div>
                </div>
              </Reveal>
              <Reveal>
                <BorrowPanel gpuId={featured.gpu.id} gpuLabel={featured.dashLabel} sharePrice={Number(featured.gpu.sharePrice) || 0} />
              </Reveal>
            </div>
          </div>
        </section>
      )}

      <section className="s tinted" id="developers">
        <div className="wrap">
          <Reveal>
            <div className="shead">
              <h2>Point your OpenAI client here.</h2>
              <p>Moonshift&apos;s router speaks the OpenAI API. Every token you pay for goes to the shareholders of whichever GPU served it.</p>
            </div>
          </Reveal>
          <Reveal>
            <div className="dev">
              <CodeSample />
              <PlaygroundTry />
            </div>
          </Reveal>
        </div>
      </section>

      <section className="enter" id="enter">
        <div className="wrap enter-in">
          <Reveal>
            <div className="enter-kicker">
              <span />
              The app
              <span />
            </div>
            <h2>Enter the app</h2>
            <p>
              Trade GPU-A and GPU-B on the XRP Ledger, book a five-minute slot, or borrow against the shares you hold.
            </p>
            <div className="ctas">
              <Button href="/market" arrow>
                Enter app
              </Button>
            </div>
          </Reveal>
        </div>
      </section>
    </main>
  );
}
