"use client";
// /borrow, bottom: the account's loan history, live. One row per ledger step
// of every loan (opened, payments, margin calls, liquidations, repaid), each
// with its transaction.
import type { XlsLoanRecord } from "@moonshift/shared";
import { fmt } from "@/lib/format";
import { TxLink } from "../LendingBits";

const STEP: Record<string, string> = {
  escrow: "Shares locked",
  loanSet: "Loan opened",
  pay: "Payment",
  pay2: "Payment",
  marginCall: "Margin call",
  seize: "Liquidated, shares taken",
  default: "Default",
  release: "Repaid, shares returned",
  delete: "Loan closed",
};
const ORDER = ["escrow", "loanSet", "pay", "pay2", "marginCall", "seize", "default", "release", "delete"];

function when(iso: string | null | undefined) {
  return iso ? new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }) : "";
}

export function AccountHistory({ loans }: { loans: XlsLoanRecord[] }) {
  const rows = [...loans]
    .sort((a, b) => b.openedAt.localeCompare(a.openedAt))
    .flatMap((l) =>
      Object.entries(l.txs)
        .filter(([, h]) => !!h)
        .sort((a, b) => {
          const ia = ORDER.indexOf(a[0].replace(/\d+$/, "")) === -1 ? 50 : ORDER.indexOf(a[0]);
          const ib = ORDER.indexOf(b[0].replace(/\d+$/, "")) === -1 ? 50 : ORDER.indexOf(b[0]);
          return ib - ia;
        })
        .map(([k, h]) => ({
          key: l.id + k,
          loan: l,
          step: STEP[k] ?? STEP[k.replace(/\d+$/, "")] ?? k,
          at: k === "marginCall" ? l.marginCallAt : k === "seize" ? l.liquidatedAt : k === "loanSet" || k === "escrow" ? l.openedAt : null,
          hash: h,
          tone: k === "seize" || k === "default" ? "dn" : k === "marginCall" ? "warn" : "",
        }))
    );

  return (
    <section className="bw-hist">
      <h3 className="sub-h">Your history</h3>
      {rows.length === 0 ? (
        <p className="note">No loans yet. Your loans, payments and margin calls appear here as they land on the ledger.</p>
      ) : (
        <div className="tbl">
          <table>
            <thead>
              <tr>
                <th>Event</th>
                <th>Loan</th>
                <th>GPU</th>
                <th className="num">Principal</th>
                <th>When</th>
                <th>Ledger</th>
              </tr>
            </thead>
            <tbody>
              {rows.slice(0, 40).map((r) => (
                <tr key={r.key}>
                  <td className={r.tone}>{r.step}</td>
                  <td>{r.loan.id.slice(0, 8)}</td>
                  <td>{r.loan.gpuId.toUpperCase()}</td>
                  <td className="num">{fmt(Number(r.loan.principal), 2)}</td>
                  <td>{when(r.at)}</td>
                  <td>
                    <TxLink network={r.loan.network} hash={r.hash} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
