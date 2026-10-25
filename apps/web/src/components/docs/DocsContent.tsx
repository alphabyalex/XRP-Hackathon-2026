"use client";
// /docs: protocol docs with a sticky left sidebar that follows the scroll.
import { useEffect, useState } from "react";
import Link from "next/link";
import { API_GROUPS, type Route } from "./apiRef";
import { Code } from "./Code";
import "./docs.css";

const BASE = "https://moonshift-protocol.vercel.app/api";

const NAV: { id: string; label: string; children?: { id: string; label: string }[] }[] = [
  { id: "overview", label: "Overview" },
  { id: "router", label: "How the router works" },
  { id: "shares", label: "GPU shares and payouts" },
  { id: "lending", label: "Lending and borrowing" },
  { id: "credit", label: "Credit data via Quicknode" },
  { id: "api", label: "API reference", children: API_GROUPS.map((g) => ({ id: g.id, label: g.title })) },
  { id: "models", label: "Models" },
];

const ALL_IDS = NAV.flatMap((n) => [n.id, ...(n.children?.map((c) => c.id) ?? [])]);

const PY = `from openai import OpenAI

client = OpenAI(base_url="${BASE}/v1", api_key="unused")

r = client.chat.completions.create(
    model="Qwen/Qwen2.5-1.5B-Instruct",
    messages=[{"role": "user", "content": "Explain VWAP in one line"}],
    extra_body={"priority": "balanced"},  # cheapest | balanced | fastest
)
print(r.choices[0].message.content)
print(r.x_ms)  # GPUs used, moves, price, payment hash`;

const SSE = `const es = new EventSource("${BASE}/events");
es.addEventListener("loan", (e) => console.log(JSON.parse(e.data)));
es.addEventListener("credit", (e) => console.log(JSON.parse(e.data)));`;

function ApiRoute({ r }: { r: Route }) {
  return (
    <div className="doc-route">
      <div className="doc-route-head">
        <span className="doc-method">{r.method}</span>
        <code>{r.path}</code>
        {r.auth && <span className="doc-auth">Signed in</span>}
      </div>
      <p>{r.summary}</p>
      <div className={r.request ? "doc-route-io" : "doc-route-io one"}>
        {r.request !== undefined && (
          <div>
            <span className="lbl">Request</span>
            <Code compact text={JSON.stringify(r.request, null, 2)} />
          </div>
        )}
        <div>
          <span className="lbl">Response</span>
          <Code compact text={JSON.stringify(r.response, null, 2)} />
        </div>
      </div>
    </div>
  );
}

export function DocsContent() {
  const [active, setActive] = useState("overview");

  // The sidebar marks the section nearest the top of the viewport.
  useEffect(() => {
    const els = ALL_IDS.map((id) => document.getElementById(id)).filter((e): e is HTMLElement => !!e);
    const io = new IntersectionObserver(
      (entries) => {
        const vis = entries.filter((e) => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        if (vis[0]) setActive(vis[0].target.id);
      },
      { rootMargin: "-80px 0px -65% 0px" }
    );
    els.forEach((e) => io.observe(e));
    return () => io.disconnect();
  }, []);

  return (
    <main className="docs wrap">
      <aside className="docs-side" aria-label="Docs sections">
        <span className="docs-side-t">Documentation</span>
        <ul>
          {NAV.map((n) => (
            <li key={n.id}>
              <a href={`#${n.id}`} className={active === n.id ? "on" : undefined}>
                {n.label}
              </a>
              {n.children && (
                <ul>
                  {n.children.map((c) => (
                    <li key={c.id}>
                      <a href={`#${c.id}`} className={active === c.id ? "on" : undefined}>
                        {c.label}
                      </a>
                    </li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ul>
      </aside>

      <article className="docs-body">
        <section id="overview">
          <h1>Moonshift docs</h1>
          <p className="doc-lede">
            Moonshift turns GPUs into assets on the XRP Ledger. Anyone can rent compute from them, own shares of what they earn, and borrow against
            those shares. Every payment, payout and loan is a transaction you can look up.
          </p>
          <p>There are three sides to the product, and they share one ledger:</p>
          <ul>
            <li>
              <b>Compute.</b> Developers send tasks, like chat completions, through one OpenAI compatible endpoint. The router places each task on
              the GPU that best fits the priority they ask for.
            </li>
            <li>
              <b>Shares.</b> Each GPU issues shares. What the GPU earns from compute is paid out to its shareholders.
            </li>
            <li>
              <b>Credit.</b> Holders can lock shares and borrow USDC from lending rounds that lenders fund. Loans are priced from the borrower&apos;s
              on-chain history and the GPU&apos;s real revenue.
            </li>
          </ul>
          <p>
            Amounts settle in USDC. The base URL for every route below is <code>{BASE}</code>.
          </p>
        </section>

        <section id="router">
          <h2>How the router works</h2>
          <p>
            A task is a unit of work: a set of prompts with a token budget, or a number of GPU minutes. You pick a priority and the router does the
            rest.
          </p>
          <h3>Priorities</h3>
          <div className="doc-table">
            <table>
              <tbody>
                <tr>
                  <td>Cheapest</td>
                  <td>The lowest expected cost that still meets your deadline and budget.</td>
                </tr>
                <tr>
                  <td>Balanced</td>
                  <td>The plan closest to both the cheapest and the fastest at once. This is the default.</td>
                </tr>
                <tr>
                  <td>Fastest</td>
                  <td>The earliest finish that stays inside your budget.</td>
                </tr>
              </tbody>
            </table>
          </div>
          <p>
            For every GPU it can use, the router prices run time, the earliest start that clears booked windows, the chance the capacity is taken
            back, and what a resume would cost. It can split a task across up to three GPUs. A single streamed reply always runs on one GPU at a
            time.
          </p>
          <h3>The price cap</h3>
          <p>
            Before a task starts, you set aside its quote plus a buffer of 10, 25 or 50 percent. That amount is locked on the ledger, so the GPU is
            sure to be paid and you are sure never to pay more. At settlement each GPU is paid for the work it served and the rest comes back to you
            in the same batch of transactions. If a task reaches its cap, it pauses until you raise the cap or cancel.
          </p>
          <h3>Resume on reclaim</h3>
          <p>
            Some capacity can be taken back by its provider with a short warning. When that happens the router saves the task&apos;s progress, plans
            the rest in the same priority, and continues on another GPU. For a chat completion the new GPU picks up from the text already written, so
            you get one continuous answer. The order&apos;s events show the move, and nothing is charged twice.
          </p>
        </section>

        <section id="shares">
          <h2>GPU shares and payouts</h2>
          <p>
            Each GPU on Moonshift issues its shares as a token on the XRP Ledger. Shares trade on the ledger&apos;s built-in order book,
            so the price on the Market page is the price you can trade at.
          </p>
          <ul>
            <li>Every task a GPU serves pays that GPU&apos;s treasury.</li>
            <li>Revenue is paid out to holders pro rata, all holders in one batch, with one transaction hash for the payout.</li>
            <li>A GPU is listed only while its endpoint passes its health check. GPU-A runs Qwen2.5-1.5B-Instruct on an NVIDIA T4 on Akash Network.</li>
          </ul>
          <p>The share price, revenue and payouts you see on a GPU&apos;s page come from the ledger and the GPU&apos;s own usage records.</p>
        </section>

        <section id="lending">
          <h2>Lending and borrowing</h2>
          <h3>Lending rounds</h3>
          <p>
            Lenders fund rounds. Each round is an XLS-65 single asset vault with a subscription phase, when it takes deposits, and an investment
            phase, when its capital is lent out. A round has a target APR, a size and a date when lenders can redeem. A first-loss cover sits in
            front of lenders.
          </p>
          <h3>Borrowing</h3>
          <p>
            A holder locks GPU shares and borrows USDC from the round that is lending. The loan is an XLS-66 loan with a fixed schedule of payments.
            Repaying in full releases the shares at once.
          </p>
          <ul>
            <li>You can never borrow more than you are approved for. An amount above the limit is refused, never shrunk.</li>
            <li>You can borrow against any GPU you hold shares in.</li>
          </ul>
          <h3>Credit grades</h3>
          <p>
            Every borrower has a score from 0 to 100 and a grade from A to E, with a confidence level. The grade sets the APR and how much can be
            borrowed against the shares. Grade E does not borrow.
          </p>
          <h3>Margin calls and liquidation</h3>
          <p>
            Each loan has two lines on its loan to value: a margin call line and a liquidation line. A risk keeper checks every open loan against the
            GPU&apos;s live share price. Crossing the margin call line starts a cure window to pay the loan down. Crossing the liquidation line
            transfers the locked shares to repay the loan. Both are on-chain transactions and both feed back into the borrower&apos;s score.
          </p>
        </section>

        <section id="credit">
          <h2>Credit data via Quicknode</h2>
          <p>
            Moonshift underwrites from what a wallet has actually done. We read the borrower&apos;s XRP Ledger history through Quicknode and turn it
            into factors: account age, payments in and out, counterparties, trust lines, balance stability and large outflows. Each factor links to
            the transactions it came from.
          </p>
          <div className="doc-table">
            <table>
              <thead>
                <tr>
                  <th>Method</th>
                  <th>What we use it for</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>
                    <code>account_tx</code>
                  </td>
                  <td>The full payment history, paged by marker. Age, volume, counterparties and repayments.</td>
                </tr>
                <tr>
                  <td>
                    <code>account_info</code>
                  </td>
                  <td>Balance and sequence, for balance stability and whether the account is active.</td>
                </tr>
                <tr>
                  <td>
                    <code>account_lines</code>
                  </td>
                  <td>Trust lines: which assets the account holds and how many issuers it deals with.</td>
                </tr>
                <tr>
                  <td>
                    <code>account_objects</code>
                  </td>
                  <td>Open loans, locked collateral and offers that still bind the account.</td>
                </tr>
                <tr>
                  <td>
                    <code>account_offers</code>
                  </td>
                  <td>Open orders on the book, which commit part of the balance.</td>
                </tr>
                <tr>
                  <td>
                    <code>subscribe</code>
                  </td>
                  <td>A WebSocket on the borrower&apos;s account and on ledger closes, so the score updates the moment a transaction lands.</td>
                </tr>
                <tr>
                  <td>
                    <code>server_info</code>
                  </td>
                  <td>Network status: the validated ledger index and the current fee, shown on the credit panel.</td>
                </tr>
              </tbody>
            </table>
          </div>
          <p>
            Deep history pages never change, so they are cached and a refresh costs nothing. Our repository&apos;s <code>docs/QUICKNODE.md</code>{" "}
            lists each call with a command to reproduce it.
          </p>
        </section>

        <section id="api">
          <h2>API reference</h2>
          <p>
            JSON over HTTPS. Amounts are decimal strings. Routes marked Signed in act for the wallet that signed in on Moonshift; the session is a
            cookie. Errors look like <code>{`{"error": {"code": "OVER_LIMIT", "message": "..."}}`}</code>.
          </p>
          <Code lang="JavaScript" text={SSE} />
          {API_GROUPS.map((g) => (
            <div key={g.id} id={g.id} className="doc-group">
              <h3>{g.title}</h3>
              {g.routes.map((r) => (
                <ApiRoute key={r.method + r.path} r={r} />
              ))}
            </div>
          ))}
        </section>

        <section id="models">
          <h2>Models</h2>
          <p>
            Moonshift serves open models through the OpenAI client you already use. Point it at our base URL, choose a priority, and the router
            places the request. See every model, its GPU and price on the <Link href="/models">Models</Link> page.
          </p>
          <Code lang="Python" text={PY} />
        </section>

      </article>
    </main>
  );
}
