"use client";
// Rent tab (Tharun's layout): what each listed GPU costs to run, by component, from the api's
// per-GPU breakdown. The api sends a breakdown only for real hardware, so the mock GPU has no row;
// a GPU appears here once its endpoint is healthy. Renting is a task: the button goes to the checkout.
import { GPUS, type GpuResourceBreakdown } from "@moonshift/shared";
import { useLiveGpus, usePolled } from "@/lib/liveData";
import { Button } from "./Button";
import { num, useCatalog } from "@/lib/catalog";
import { fmt } from "@/lib/format";

interface ClusterRow {
  id: string;
  label: string;
  hw: string;
  state: string;
  res: GpuResourceBreakdown;
  ramGb: number;
  storageGb: number;
}

// The GPU's live state from compute, in plain words.
const STATUS: Record<string, string> = { READY: "Available", SERVING: "Available", BOOKED: "Busy", DRAINING: "Busy", OFFLINE: "Not connected" };

// GET /catalog/aws (contracts/compute/aws_sse.json): live AWS rates, refreshed on the aws event.
interface AwsRate {
  usdPerHour?: string | number;
  instanceType?: string;
  region?: string;
}
interface AwsFeed {
  updatedAt: string | null;
  spot: AwsRate[];
  onDemand: AwsRate[];
}
const usd = (v: unknown) => (Number.isFinite(Number(v)) && v !== null ? `$${Number(v).toFixed(3)}` : null);

const count = (spec: string, re: RegExp, fallback: number) => Number(re.exec(spec)?.[1] ?? fallback);
const rate = (usd: number, per: number, unit: string) => `$${(usd / Math.max(per, 1)).toFixed(4)}/${unit}`;

export function RentTabContent({ checkoutHref = "/market" }: { checkoutHref?: string }) {
  const gpus = useLiveGpus();
  // One price everywhere: the rental rate per hour from GET /catalog/gpus, as on Market and the GPU page.
  const { data: catalog } = useCatalog();
  const rental = (id: string) => num(catalog?.gpus.find((c) => c.id === id)?.prices.rentalUsdPerHour);
  const { data: aws } = usePolled<AwsFeed>("/catalog/aws", { ms: 5000, on: ["aws"] });
  const onDemand = usd(aws?.onDemand?.[0]?.usdPerHour);
  const spot = usd(aws?.spot?.[0]?.usdPerHour);
  const rows: ClusterRow[] = GPUS.flatMap((g) => {
    const res = gpus[g.id]?.resources;
    // Only health-checked GPUs are listed: a GPU compute reports OFFLINE drops off until it is back.
    if (!res || gpus[g.id].state === "OFFLINE") return [];
    return [
      {
        id: g.id,
        label: g.id.toUpperCase(),
        hw: gpus[g.id].hw,
        state: gpus[g.id].state,
        res,
        ramGb: count(res.components.ram.spec, /(\d+)\s*GiB/, 16),
        storageGb: count(res.components.storage.spec, /(\d+)\s*GB/, 100),
      },
    ];
  });

  return (
    <div className="rent-tab">
      <div className="rent-head">
        <div>
          <h3>GPU rentals</h3>
          <p>
            What each GPU costs by the hour, and whether it is free right now.
            {onDemand && (
              <>
                {" "}
                The same card on AWS costs {onDemand} an hour on demand{spot ? `, ${spot} on spot` : ""}.
              </>
            )}
          </p>
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
                <th>RAM</th>
                <th>Storage</th>
                <th className="r">USD / hour</th>
                <th className="r">Status</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((c) => {
                const hourly = rental(c.id);
                return (
                  <tr key={c.id}>
                    <td>
                      <b>{c.hw}</b>
                      <span className="where">
                        {c.label}, {c.res.provider.replace(/\s*\(.*\)$/, "")}
                      </span>
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
                      {hourly !== null ? `$${hourly.toFixed(3)}` : "–"}
                      {hourly !== null && <span className="sub">${fmt(hourly * 730, 0)}/mo</span>}
                    </td>
                    <td className="r">{STATUS[c.state] ?? "Not connected"}</td>
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
