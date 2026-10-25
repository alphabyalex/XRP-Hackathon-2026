// Public rental data is built only from observed service state and published rates.
export interface LiveRate {
  usdPerHour: string;
  updatedAt: string;
  source: string;
  sourceUrl: string;
  region?: string;
  instanceType?: string;
  publishedAt?: string | null;
}

export interface OwnRentalRate {
  usdPerHour: string; updatedAt: string; source: "Akash lease plus margin";
  priceBasis: "akash_lease_plus_margin"; expiresAt: null;
  costUsdPerHour: string; marginPct: string;
}
export interface RentalPrices {
  rentalUsdPerHour: string | null; rental?: OwnRentalRate | null;
  awsSpot?: { usdPerHour: string; updatedAt?: string } | null;
  awsOnDemand?: { usdPerHour: string; updatedAt?: string } | null;
}
export function configuredRentalRate(costValue: unknown, marginValue: unknown, updatedAt: string): OwnRentalRate | null {
  const cost = Number(costValue), margin = Number(marginValue);
  if (!Number.isFinite(cost) || cost <= 0 || !Number.isFinite(margin) || margin < 0 ||
      !Number.isFinite(Date.parse(updatedAt)) || Date.parse(updatedAt) > Date.now() + 300_000) return null;
  const hourly = cost * (1 + margin);
  if (!Number.isFinite(hourly) || hourly <= 0) return null;
  return { usdPerHour: hourly.toFixed(6), updatedAt, source: "Akash lease plus margin",
    priceBasis: "akash_lease_plus_margin", expiresAt: null, costUsdPerHour: cost.toFixed(6), marginPct: (margin * 100).toFixed(2) };
}
export function rentalModePricing(prices: RentalPrices, now = Date.now()) {
  const own = prices.rental;
  if (!own || own.priceBasis !== "akash_lease_plus_margin" || own.source !== "Akash lease plus margin" ||
      !Number.isFinite(Date.parse(own.updatedAt)) || Date.parse(own.updatedAt) > now + 300_000 ||
      !Number.isFinite(Number(own.usdPerHour)) || Number(own.usdPerHour) <= 0 ||
      Number(prices.rentalUsdPerHour) !== Number(own.usdPerHour)) return null;
  const valid = (rate: RentalPrices["awsSpot"], age: number) => !!rate && Number.isFinite(Number(rate.usdPerHour)) && Number(rate.usdPerHour) > 0 &&
    Number.isFinite(Date.parse(rate.updatedAt ?? "")) && now - Date.parse(rate.updatedAt!) < age && Date.parse(rate.updatedAt!) <= now + 60_000;
  const pair = valid(prices.awsSpot, 30 * 60_000) && valid(prices.awsOnDemand, 48 * 3600_000);
  const ratio = pair ? Math.min(1, Number(prices.awsSpot!.usdPerHour) / Number(prices.awsOnDemand!.usdPerHour)) : null;
  const full = Number(own.usdPerHour);
  const discountUpdatedAt = pair ? [own.updatedAt, prices.awsSpot!.updatedAt!, prices.awsOnDemand!.updatedAt!].sort().at(-1)! : own.updatedAt;
  return { own, ratio, rates: { cheapest: full * (ratio ?? 1), balanced: full * (ratio === null ? 1 : (1 + ratio) / 2), fastest: full },
    updatedAt: { cheapest: discountUpdatedAt, balanced: discountUpdatedAt, fastest: own.updatedAt },
    discountExpiresAt: pair ? new Date(Math.min(Date.parse(prices.awsSpot!.updatedAt!) + 30 * 60_000, Date.parse(prices.awsOnDemand!.updatedAt!) + 48 * 3600_000)).toISOString() : null };
}

export interface FleetRow {
  id: string;
  moonshiftGpuId?: string | null;
  computeGpuId?: string | null;
  endpoint?: boolean;
  state?: { available?: boolean; activeJobs?: number; reason?: string | null; bookedWindows?: { start: string; end: string }[] };
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
  extra?: { source?: string; publishedAt?: string | null };
}

export function liveAwsRates(offers: AwsOffer[], now = Date.now()): { spot: LiveRate[]; onDemand: LiveRate[] } {
  const rows = offers.filter(o => o.provider === "aws" && o.priceSource === "live" &&
    o.gpuModel === "T4" && typeof o.asOf === "string" && Number.isFinite(Date.parse(o.asOf)) &&
    Date.parse(o.asOf) <= now + 60_000 && now - Date.parse(o.asOf) < (o.capacityType === "spot" ? 30 * 60_000 : 48 * 3600_000) &&
    Number.isInteger(o.gpuCount) && o.gpuCount! > 0 && typeof o.pricePerHourUsd === "number" &&
    Number.isFinite(o.pricePerHourUsd) && o.pricePerHourUsd > 0);
  const rates = (kind: string) => rows.filter(o => o.capacityType === kind).map(o => ({
    usdPerHour: (o.pricePerHourUsd! / o.gpuCount!).toFixed(6), updatedAt: o.asOf!,
    source: o.extra?.source ? (kind === "spot" ? "AWS public spot price feed" : "AWS public on-demand price feed")
      : kind === "spot" ? "AWS DescribeSpotPriceHistory" : "AWS Price List API",
    sourceUrl: o.extra?.source ?? (kind === "spot" ? "https://aws.amazon.com/ec2/spot/pricing/" : "https://aws.amazon.com/ec2/pricing/on-demand/"),
    publishedAt: o.extra?.publishedAt ?? null,
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
  const now = updatedAt ? Date.parse(updatedAt) : Date.now();
  const booked = matching.some(row => row.state?.bookedWindows?.some(window => Date.parse(window.start) <= now && now < Date.parse(window.end)));
  const available = matching.some(row => row.state!.available === true);
  // Offline or unpriced does not mean reserved. Only an actual current booking
  // may be counted as a reservation, and a booked card is never counted as free.
  const reserved = booked ? 1 : available || busy ? 0 : null;
  const free = !busy && !booked && available ? 1 : 0;
  return { total: 1, free, busy, reserved, updatedAt };
}

export function observedChange24h(observations: { time: string; rentalUsdPerHour: string | null }[], current: string | null, now = Date.now()): string | null {
  if (!current || !(Number(current) > 0)) return null;
  const target = now - 24 * 3600_000;
  // No older point means no 24-hour change, rather than inventing a flat history.
  const before = observations.filter(o => Date.parse(o.time) <= target && Date.parse(o.time) >= target - 2 * 3600_000 && Number(o.rentalUsdPerHour) > 0)
    .sort((a, b) => b.time.localeCompare(a.time))[0];
  return before ? ((Number(current) / Number(before.rentalUsdPerHour) - 1) * 100).toFixed(2) : null;
}
