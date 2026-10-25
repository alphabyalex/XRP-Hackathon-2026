// Public rental data is built only from observed service state and published rates.
export interface LiveRate {
  usdPerHour: string;
  updatedAt: string;
  source: string;
  sourceUrl: string;
  region?: string;
  instanceType?: string;
}

export interface FleetRow {
  id: string;
  moonshiftGpuId?: string | null;
  computeGpuId?: string | null;
  endpoint?: boolean;
  state?: { available?: boolean; activeJobs?: number };
}

export interface AwsOffer {
  provider?: string;
  gpuModel?: string;
  gpuCount?: number;
  capacityType?: string;
  priceSource?: string;
  pricePerHourUsd?: number;
  asOf?: string;
  region?: string;
  instanceType?: string;
}

export function liveAwsRates(offers: AwsOffer[], now = Date.now()): { spot: LiveRate[]; onDemand: LiveRate[] } {
  const rows = offers.filter(o => o.provider === "aws" && o.priceSource === "live" &&
    o.gpuModel === "T4" && typeof o.asOf === "string" && Number.isFinite(Date.parse(o.asOf)) &&
    Date.parse(o.asOf) <= now + 60_000 && now - Date.parse(o.asOf) < (o.capacityType === "spot" ? 30 * 60_000 : 48 * 3600_000) &&
    Number.isInteger(o.gpuCount) && o.gpuCount! > 0 && typeof o.pricePerHourUsd === "number" &&
    Number.isFinite(o.pricePerHourUsd) && o.pricePerHourUsd > 0);
  const rates = (kind: string) => rows.filter(o => o.capacityType === kind).map(o => ({
    usdPerHour: (o.pricePerHourUsd! / o.gpuCount!).toFixed(6), updatedAt: o.asOf!,
    source: kind === "spot" ? "AWS DescribeSpotPriceHistory" : "AWS Price List API",
    sourceUrl: kind === "spot" ? "https://aws.amazon.com/ec2/spot/pricing/" : "https://aws.amazon.com/ec2/pricing/on-demand/",
    region: o.region, instanceType: o.instanceType,
  })).sort((a, b) => Number(a.usdPerHour) - Number(b.usdPerHour));
  return { spot: rates("spot"), onDemand: rates("on-demand") };
}

export function nodeAvailability(gpuId: string, fleet: FleetRow[] | null, updatedAt: string | null) {
  // One configured endpoint represents one physical card. Multiple router slots do
  // not become additional physical GPUs.
  const matching = fleet?.filter(row => row.endpoint === true &&
    (row.computeGpuId === gpuId || row.moonshiftGpuId === gpuId || row.id === gpuId));
  if (!matching?.length || matching.some(row => !row.state || !Number.isInteger(row.state.activeJobs) || row.state.activeJobs! < 0)) {
    return { total: 1, free: null, busy: null, reserved: null, updatedAt: null };
  }
  const busy = matching.some(row => row.state!.activeJobs! > 0) ? 1 : 0;
  const free = !busy && matching.some(row => row.state!.available === true) ? 1 : 0;
  return { total: 1, free, busy, reserved: 1 - free - busy, updatedAt };
}

export function observedChange24h(observations: { time: string; rentalUsdPerHour: string | null }[], current: string | null, now = Date.now()): string | null {
  if (!current || !(Number(current) > 0)) return null;
  const target = now - 24 * 3600_000;
  // No older point means no 24-hour change, rather than inventing a flat history.
  const before = observations.filter(o => Date.parse(o.time) <= target && Date.parse(o.time) >= target - 2 * 3600_000 && Number(o.rentalUsdPerHour) > 0)
    .sort((a, b) => b.time.localeCompare(a.time))[0];
  return before ? ((Number(current) / Number(before.rentalUsdPerHour) - 1) * 100).toFixed(2) : null;
}
