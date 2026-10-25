"use client";
import { useCallback, useEffect, useState } from "react";
import { Button } from "./Button";
import { useToast } from "./Toast";
import { StressControls } from "./LendingBits";
import { InstantSwitchCard } from "./InstantSwitchCard";
import { GPUS } from "@moonshift/shared";
import { fmt } from "@/lib/format";
import {
  catalog,
  fleet,
  fmtTime,
  listOrders,
  providerName,
  quote,
  reclaim,
  resetAccount,
  type CatalogOffer,
  type FleetGpu,
  type Order,
} from "@/lib/routerApi";
import "./router.css";

const KEY_STORE = "ms-admin-key";

function storedKey(): string {
  try {
    return localStorage.getItem(KEY_STORE) ?? "";
  } catch {
    return "";
  }
}

function benchmarkLabel(g: FleetGpu): string {
  const b = g.benchmark;
  if (!b) return "Listed price";
  const [prov, region, instance, capacity] = b.offerKey.split("#");
  return `${providerName(prov)} ${instance} ${capacity}, ${region}`;
}

// Operator view: live prices across providers, the fleet with a reclaim control, recent orders.
export function AdminRouter() {
  const [offers, setOffers] = useState<CatalogOffer[]>([]);
  const [gpus, setGpus] = useState<FleetGpu[]>([]);
  const [orders, setOrders] = useState<Order[]>([]);
  const [why, setWhy] = useState<string | null>(null);
  const [adminKey, setAdminKey] = useState("");
  const [resetWallet, setResetWallet] = useState("");
  const [resetting, setResetting] = useState(false);
  const toast = useToast();

  const load = useCallback(() => {
    catalog().then((c) => setOffers(c.offers)).catch(() => undefined);
    fleet().then(setGpus).catch(() => undefined);
    listOrders().then((o) => setOrders(o.orders)).catch(() => undefined);
  }, []);

  useEffect(() => {
    setAdminKey(storedKey());
    load();
    quote({ kind: "rental", minutes: 30 }).then((q) => setWhy(q.why)).catch(() => undefined);
    const t = setInterval(load, 3000);
    return () => clearInterval(t);
  }, [load]);

  async function doReclaim(id: string) {
    try {
      const r = await reclaim(id, adminKey);
      toast(`Reclaimed ${id.toUpperCase()}`, `${r.affectedOrders.length} order(s) moving`);
      load();
    } catch (err) {
      toast("Reclaim failed", (err as Error).message);
    }
  }

  async function doReset() {
    setResetting(true);
    try {
      const r = await resetAccount(resetWallet.trim(), adminKey);
      toast("Account reset", `${r.wallet.slice(0, 8)}... now uses ${r.account.slice(0, 8)}...`);
      setResetWallet("");
    } catch (err) {
      toast("Reset failed", (err as Error).message);
    } finally {
      setResetting(false);
    }
  }

  function saveKey(v: string) {
    setAdminKey(v);
    try {
      localStorage.setItem(KEY_STORE, v);
    } catch {
      // storage unavailable; key lives for this page only
    }
  }

  const byPrice = [...offers].sort((a, b) => a.pricePerGpuHourUsd - b.pricePerGpuHourUsd);

  return (
    <main className="s">
      <div className="wrap adm">
        <div className="shead">
          <h2>Router</h2>
        </div>

        <div className="inp" style={{ maxWidth: 360 }}>
          <input
            type="password"
            placeholder="Admin key"
            value={adminKey}
            onChange={(e) => saveKey(e.target.value)}
            style={{ fontSize: 15 }}
            aria-label="Admin key"
          />
        </div>

        <h3>Fleet</h3>
        <table>
          <thead>
            <tr>
              <th>GPU</th>
              <th>Provider</th>
              <th>Hardware</th>
              <th>Capacity</th>
              <th>USDC / h</th>
              <th>Priced from</th>
              <th>Jobs</th>
              <th>State</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {gpus.map((g) => (
              <tr key={g.id}>
                <td className="l">{g.label}</td>
                <td className="l">{providerName(g.provider)}</td>
                <td className="l">{g.hardware}</td>
                <td className="l">{g.capacityType}</td>
                <td>{fmt(Number(g.pricePerHourUsdc), 4)}</td>
                <td className="l">{benchmarkLabel(g)}</td>
                <td>{g.state.activeJobs}</td>
                <td className="l">{g.state.available ? "Available" : g.state.reason === "RECLAIMED" ? "Reclaimed" : "Unavailable"}</td>
                <td>
                  {(g.interruptible || g.provider === "moonshift") && g.state.available && (
                    <Button variant="ghost" size="sm" onClick={() => doReclaim(g.id)}>
                      Reclaim
                    </Button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        <h3>Orders</h3>
        <table>
          <thead>
            <tr>
              <th>Order</th>
              <th>Mode</th>
              <th>Status</th>
              <th>USDC</th>
              <th>GPUs</th>
              <th>Moves</th>
            </tr>
          </thead>
          <tbody>
            {orders.map((o) => (
              <tr key={o.orderId}>
                <td>{o.orderId}</td>
                <td className="l">{o.mode}</td>
                <td className="l">{o.status}</td>
                <td>{fmt(Number(o.priceUsdc), 4)}</td>
                <td className="l">{[...new Set(o.segments.map((s) => s.label))].join(", ")}</td>
                <td className="l">
                  {o.moves.map((m) => `${m.toLabel} at ${fmtTime(m.at)}`).join(", ")}
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        {why && (
          <>
            <h3>Why</h3>
            <p className="why">{why}</p>
          </>
        )}

        <h3>Accounts</h3>
        <p className="why">Gives a wallet a fresh Moonshift account with the starting balance and no loan history. The old account stays on the ledger.</p>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center", marginBottom: 16 }}>
          <div className="inp" style={{ flex: "1 1 320px", maxWidth: 460 }}>
            <input
              placeholder="Wallet address (r...)"
              value={resetWallet}
              onChange={(e) => setResetWallet(e.target.value)}
              style={{ fontSize: 15 }}
              aria-label="Wallet address"
            />
          </div>
          <Button size="sm" disabled={resetting || !/^r\w{24,34}$/.test(resetWallet.trim())} onClick={doReset}>
            {resetting ? "Resetting..." : "Reset account for wallet"}
          </Button>
        </div>

        <h3>Loan stress test</h3>
        <p className="why">Moves a GPU&apos;s collateral price so open loans hit a margin call or liquidation. Restore puts the market price back.</p>
        {GPUS.map((g) => (
          <div key={g.id} className="trade card" style={{ marginBottom: 16 }}>
            <StressControls gpuId={g.id} label={g.id.toUpperCase()} />
          </div>
        ))}

        <h3>Infrastructure</h3>
        <InstantSwitchCard />

        <h3>Market benchmark</h3>
        <p className="why">
          Tasks run only on GPU-A and GPU-B. These offers are the market: each GPU is priced at the cheapest on-demand offer for the same GPU, so a
          customer never pays more than renting it elsewhere. Not shown to customers.
        </p>
        <table>
          <thead>
            <tr>
              <th>Provider</th>
              <th>Region</th>
              <th>Instance</th>
              <th>GPU</th>
              <th>Capacity</th>
              <th>USD / GPU h</th>
              <th>Availability</th>
              <th>As of</th>
            </tr>
          </thead>
          <tbody>
            {byPrice.map((o) => (
              <tr key={o.key}>
                <td className="l">{providerName(o.provider)}</td>
                <td className="l">{o.region}</td>
                <td className="l">{o.instanceType}</td>
                <td className="l">
                  {o.gpuCount > 1 ? `${o.gpuCount}x ` : ""}
                  {o.gpuModel}
                </td>
                <td className="l">{o.capacityType}</td>
                <td>{fmt(o.pricePerGpuHourUsd, 4)}</td>
                <td className="l">
                  {o.availability.count !== null ? `${o.availability.count} ` : ""}
                  {o.availability.status}
                  {o.availability.score !== null ? ` (${o.availability.score}/10)` : ""}
                </td>
                <td>{fmtTime(o.asOf)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </main>
  );
}
