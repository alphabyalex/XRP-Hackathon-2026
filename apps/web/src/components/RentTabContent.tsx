"use client";
// Rent tab (Tharun's layout): what each listed GPU costs to run, by component, from the api's
// per-GPU breakdown. The api sends a breakdown only for real hardware, so the mock GPU has no row;
// a GPU appears here once its endpoint is healthy. Renting is a task: the button goes to the checkout.
import { GPUS, type GpuResourceBreakdown } from "@moonshift/shared";
import { useLiveGpus } from "@/lib/liveData";
import { Button } from "./Button";

interface ClusterRow {
  id: string;
  label: string;
  hw: string;
  res: GpuResourceBreakdown;
  vcpuCount: number;
  ramGb: number;
  storageGb: number;
}

const count = (spec: string, re: RegExp, fallback: number) => Number(re.exec(spec)?.[1] ?? fallback);
const rate = (usd: number, per: number, unit: string) => `$${(usd / Math.max(per, 1)).toFixed(4)}/${unit}`;

export function RentTabContent({ checkoutHref = "/market#run-task" }: { checkoutHref?: string }) {
  const gpus = useLiveGpus();
  const rows: ClusterRow[] = GPUS.flatMap((g) => {
    const res = gpus[g.id]?.resources;
    if (!res) return [];
    return [
      {
        id: g.id,
        label: g.id.toUpperCase(),
        hw: gpus[g.id].hw,
        res,
        vcpuCount: count(res.components.cpu.spec, /(\d+)\s*vCPU/, 4),
        ramGb: count(res.components.ram.spec, /(\d+)\s*GiB/, 16),
        storageGb: count(res.components.storage.spec, /(\d+)\s*GB/, 100),
      },
    ];
  });

  return (
    <div className="rent-tab">
      <div className="rent-head">
        <div>
          <h3>GPU rental</h3>
          <p>What each GPU costs to run, per vCPU, GB of RAM and TB of storage.</p>
        </div>
        <Button size="sm" href={checkoutHref} arrow>
          Run a task
        </Button>
      </div>
      {rows.length === 0 ? (
        <p className="note">No GPU with a published cost breakdown is online right now.</p>
      ) : (
        <div className="tbl">
          <table>
            <thead>
              <tr>
                <th>GPU</th>
                <th>vCPU</th>
                <th>RAM</th>
                <th>Storage</th>
                <th className="r">USD / hour</th>
                <th className="r">vs AWS</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((c) => {
                const total = Number(c.res.totalHourlyUsd);
                return (
                  <tr key={c.id}>
                    <td>
                      <b>{c.hw}</b>
                      <span className="sub">
                        {c.label} &middot; {c.res.provider}
                      </span>
                    </td>
                    <td>
                      {c.vcpuCount} vCPUs
                      <span className="sub">{rate(Number(c.res.components.cpu.hourlyUsd), c.vcpuCount, "vCPU-hr")}</span>
                    </td>
                    <td>
                      {c.ramGb} GiB
                      <span className="sub">{rate(Number(c.res.components.ram.hourlyUsd), c.ramGb, "GB-hr")}</span>
                    </td>
                    <td>
                      {c.storageGb} GB NVMe
                      <span className="sub">{rate(Number(c.res.components.storage.hourlyUsd), c.storageGb / 1000, "TB-hr")}</span>
                    </td>
                    <td className="r num">
                      ${total.toFixed(3)}
                      <span className="sub">${c.res.monthlyUsd}/mo</span>
                    </td>
                    <td className="r num">{c.res.indexedSavingsVsAwsPct && c.res.indexedSavingsVsAwsPct !== "0.0%" ? `-${c.res.indexedSavingsVsAwsPct}` : "Benchmark"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
