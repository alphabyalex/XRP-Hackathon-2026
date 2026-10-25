"use client";
// Market, renter view: every health-checked GPU from GET /catalog/gpus with its hardware, the
// hourly price next to what other providers charge right now, free nodes and the last 24 hours of
// measured utilization. Polled every 5 seconds; nothing here is filled in when the feed is quiet.
import clsx from "clsx";
import Link from "next/link";
import { Sparkline, chartTheme } from "./charts";
import { useCatalog, num, usdHr, whereOf, utilPoints, type CatalogGpu } from "@/lib/catalog";
import { fmt } from "@/lib/format";

function Others({ g }: { g: CatalogGpu }) {
  const rows = [
    ["GPU market", g.prices.economy?.usdPerHour],
    ["AWS spot", g.prices.awsSpot?.usdPerHour],
    ["AWS on demand", g.prices.awsOnDemand?.usdPerHour],
  ].filter(([, v]) => num(v) !== null);
  if (!rows.length) return <span className="sub">No outside price yet</span>;
  return (
    <span className="sub">
      {rows.map(([k, v]) => (
        <span key={k as string} className="other-px">
          {k} {usdHr(v)}
        </span>
      ))}
    </span>
  );
}

export function RenterTable({ fallback }: { fallback?: React.ReactNode }) {
  const { data, error } = useCatalog();
  if (!data && error && fallback) return <>{fallback}</>;
  if (!data) {
    return <p className="note rent-note">{error ? "GPU listings are not available right now. They will appear here as soon as the catalog answers." : "Loading GPUs"}</p>;
  }
  if (!data.gpus.length) return <p className="note rent-note">No GPU has passed its health check yet. Listings appear here the moment one does.</p>;
  return (
    <div className="tbl renter">
      <table>
        <thead>
          <tr>
            <th>Location</th>
            <th>GPU</th>
            <th className="r">vCPU</th>
            <th className="r">RAM</th>
            <th className="r">Storage</th>
            <th className="r">Price per hour</th>
            <th className="r">24h</th>
            <th className="r">Free nodes</th>
            <th>Last 24 hours</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {data.gpus.map((g) => {
            const ch = num(g.prices.change24hPct);
            const util = utilPoints(g);
            const free = num(g.nodes.free);
            const total = num(g.nodes.total);
            return (
              <tr key={g.id}>
                <td>
                  <b>{whereOf(g)}</b>
                  <span className="sub">{g.label}</span>
                </td>
                <td>
                  <b>{g.card}</b>
                  <span className="sub">{num(g.vramGb) !== null ? `${g.vramGb} GB VRAM` : "VRAM not reported"}</span>
                </td>
                <td className="r num">{num(g.vcpu) ?? "–"}</td>
                <td className="r num">{num(g.ramGb) !== null ? `${g.ramGb} GB` : "–"}</td>
                <td className="r num">{num(g.storageGb) !== null ? `${g.storageGb} GB` : "–"}</td>
                <td className="r num">
                  <b>{usdHr(g.prices.rentalUsdPerHour)}</b>
                  <Others g={g} />
                </td>
                <td className="r">
                  {ch === null ? (
                    <span className="sub-inline">–</span>
                  ) : (
                    <span className={clsx("chg", ch >= 0 ? "up" : "dn")}>
                      {ch >= 0 ? "+" : ""}
                      {fmt(ch, 2)}%
                    </span>
                  )}
                </td>
                <td className="r num">{free === null ? "–" : `${free} of ${total ?? free}`}</td>
                <td>
                  {util.length > 1 ? (
                    <Sparkline points={util} width={110} height={28} color={chartTheme.accent} label={`${g.label} utilization, last 24 hours`} />
                  ) : (
                    <span className="sub-inline">Collecting</span>
                  )}
                </td>
                <td className="r">
                  <Link className="btn ink sm" href={`/gpu/${g.id}`}>
                    Rent a GPU
                  </Link>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
