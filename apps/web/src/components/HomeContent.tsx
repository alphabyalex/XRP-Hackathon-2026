"use client";
import { utilizationOf } from "@/lib/schedule";
import { num } from "@/lib/catalog";
import { priceOf, useStatsMap } from "@/lib/gpuMarket";
import dynamic from "next/dynamic";
import { GPUS } from "@moonshift/shared";
import { useLiveGpus, useApiUnreachable, useNow } from "@/lib/liveData";
import { gpuView } from "@/lib/gpuView";
import { Button } from "./Button";
import { AppWindow } from "./AppWindow";
import { RentTabContent } from "./RentTabContent";
import { ScheduleRows } from "./ScheduleRows";
import { MoneyStack } from "./MoneyStack";
import { BorrowPanel } from "./BorrowPanel";
import { CodeSample } from "./CodeSample";
import { PlaygroundTry } from "./PlaygroundTry";
import { ApiErrorNotice } from "./ApiErrorNotice";
import { Reveal } from "./Reveal";
import { LiveNumber } from "./LiveNumber";

const Hero3DMark = dynamic(() => import("./Hero3DMark").then((m) => m.Hero3DMark), {
  ssr: false,
  loading: () => <div className="stage3d" />,
});

// "two GPUs" in the hero sentence (spelled out up to ten).
const WORDS = ["no", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"];
const gpuWords = (n: number) => `${WORDS[n] ?? n} GPU${n === 1 ? "" : "s"}`;
export function HomeContent() {
  const gpus = useLiveGpus();
  const now = useNow();
  const unreachable = useApiUnreachable();
  const views = GPUS.map((g) => gpus[g.id]).filter(Boolean).map((g) => gpuView(g, now));
  const featured = views.find((v) => v.gpu.id === "gpu-a") ?? views[0];

  // Counted only while compute reports the GPU connected (an offline GPU's shares still trade).
  const live = views.filter((v) => v.gpu.state !== "OFFLINE");
  // Payouts and prices from GET /gpus/:id/stats (the dividend ledger), the numbers Market and the GPU page show.
  const stats = useStatsMap(views.map((v) => v.gpu.id));
  const paidOf = (v: (typeof views)[number]) => num(stats[v.gpu.id]?.paidToHoldersLastNight) ?? v.split.holders;
  const paidLastNight = views.reduce((s, v) => s + paidOf(v), 0);
  // From the same slots the schedules draw, so the number and the bars agree.
  const avgUtil = live.length ? live.reduce((s, v) => s + utilizationOf(v.slots, v.nowIndex), 0) / live.length : 0;

  return (
    <main id="top">
      <section className="hero">
        <div className="wrap hero-in">
          <Reveal>
            <h1>
              Own a <em>share</em> of a GPU.
            </h1>
            <p className="sub">
              Moonshift splits real GPUs into shares on the XRP Ledger. Right now {gpuWords(live.length)} {live.length === 1 ? "is" : "are"} taking customer tasks, busy{" "}
              <LiveNumber value={avgUtil} digits={1} suffix="%" /> of the last 20 hours. Last night shareholders were paid{" "}
              <LiveNumber value={paidLastNight} digits={2} /> USDC.
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
                <b>
                  <LiveNumber value={paidLastNight} digits={2} /> USDC
                </b>
                paid to holders last night
              </div>
              <div>
                <b>
                  <LiveNumber value={avgUtil} digits={1} suffix="%" />
                </b>
                of the last 20 hours working
              </div>
              <div>
                <b>{live.length}</b>
                {live.length === 1 ? "GPU" : "GPUs"} live on the XRP Ledger
              </div>
            </div>
          </Reveal>
          <Hero3DMark />
        </div>
      </section>

      {unreachable && (
        <div className="wrap" style={{ paddingBottom: 40 }}>
          <ApiErrorNotice />
        </div>
      )}

      <section className="s tinted close-bottom" id="market">
        <div className="wrap">
          <Reveal>
            <div className="shead">
              <h2>Rent a GPU by the hour</h2>
              <p>Every GPU below passed its health check in the last minute. Run a task on one, or buy a share of what it earns.</p>
            </div>
          </Reveal>
          <Reveal>
            <AppWindow>
              <RentTabContent checkoutHref="/market" />
            </AppWindow>
          </Reveal>
        </div>
      </section>

      {featured && (
        <section className="s close close-bottom" id="schedule">
          <div className="wrap">
            <Reveal>
              <div className="shead">
                <h2>
                  Working around
                  <br />
                  the clock.
                </h2>
                <p>
                  Here is {featured.dashLabel} over the last 20 hours and the next 4. Each bar is five minutes. Dark bars are customer work, light ones are idle time. When one task
                  finishes the router hands it the next, so the gaps stay short.
                </p>
              </div>
            </Reveal>
            <div className="sched-grid" style={{ gridTemplateColumns: "1fr", maxWidth: 860, marginInline: "auto" }}>
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
                      Ahead
                    </span>
                  </div>
                  <div className="facts" style={{ marginTop: 40 }}>
                    <div>
                      <span>Working, last 20 hours</span>
                      <b>
                        <LiveNumber value={utilizationOf(featured.slots, featured.nowIndex)} digits={1} suffix="%" />
                      </b>
                    </div>
                    <div>
                      <span>Revenue, last 24h</span>
                      <b>
                        <LiveNumber value={num(stats[featured.gpu.id]?.revenue24h) ?? featured.revenue24h} digits={2} /> USDC
                      </b>
                    </div>
                    <div>
                      <span>Paid per share, last 24h</span>
                      <b>
                        <LiveNumber value={num(stats[featured.gpu.id]?.paidPerShare24h) ?? featured.split.holders / 1000} digits={6} /> USDC
                      </b>
                    </div>
                  </div>
                </div>
              </Reveal>
            </div>
          </div>
        </section>
      )}

      {featured && (
        <section className="s tinted close close-bottom">
          <div className="wrap">
            <MoneyStack revenue24h={featured.revenue24h} />
          </div>
        </section>
      )}

      {featured && (
        <section className="s close close-bottom" id="borrow">
          <div className="wrap">
            <div className="borrow">
              <Reveal>
                <div className="shead" style={{ marginBottom: 0 }}>
                  <h2>Borrow without selling.</h2>
                  <p>Lock your shares and borrow up to half their value in USDC. Locked shares keep earning their nightly payout.</p>
                </div>
                <div className="ledger">
                  <div>
                    <code>Lock</code>
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
                <BorrowPanel gpuId={featured.gpu.id} gpuLabel={featured.dashLabel} sharePrice={priceOf(stats[featured.gpu.id], featured.gpu.sharePrice)} />
              </Reveal>
            </div>
          </div>
        </section>
      )}

      <section className="s tinted close" id="developers">
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
              <PlaygroundTry autoplay />
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
              Trade GPU shares on the XRP Ledger, run compute tasks, or borrow against the shares you hold.
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
