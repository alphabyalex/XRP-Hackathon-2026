export interface BorrowScenario { shares: number; collateral: number; principal: number; interest: number; ltv: number }
export interface BorrowScenarioInputs {
  sharePrice: number; maxShares: number; available: number; apr: number;
  termSeconds: number; maxLtv: number; principalPerShare?: number; seed: number;
}

export function borrowingInterest(principal: number, apr: number, termSeconds: number) {
  if (![principal, apr, termSeconds].every(Number.isFinite) || principal < 0 || apr < 0 || termSeconds <= 0) return null;
  return principal * apr * termSeconds / (365 * 86400);
}

/** Varied what-if inputs, never observations or historical interest rates. */
export function borrowingScenarios(input: BorrowScenarioInputs): BorrowScenario[] {
  if (![input.sharePrice, input.maxShares, input.available, input.apr, input.termSeconds, input.maxLtv].every(Number.isFinite)
    || input.sharePrice <= 0 || input.maxShares < 1 || input.available <= 0 || input.apr < 0
    || input.termSeconds <= 0 || input.maxLtv <= 0 || input.maxLtv > 1) return [];
  const capacityPerShare = Math.min(input.sharePrice * input.maxLtv, input.principalPerShare ?? Infinity);
  if (!(capacityPerShare > 0)) return [];
  let seed = input.seed >>> 0;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
  const controls = Array.from({ length: 7 }, () => 0.25 + random() * 0.7);
  const count = Math.min(25, Math.floor(input.maxShares));
  return Array.from({ length: count }, (_, i) => {
    const fraction = count === 1 ? 0 : i / (count - 1);
    const position = fraction * (controls.length - 1);
    const index = Math.min(controls.length - 2, Math.floor(position));
    const blend = position - index;
    const smooth = blend * blend * (3 - 2 * blend);
    const borrowedFraction = controls[index] + (controls[index + 1] - controls[index]) * smooth;
    const shares = 1 + fraction * (input.maxShares - 1);
    const collateral = shares * input.sharePrice;
    const principal = Math.min(input.available, shares * capacityPerShare * borrowedFraction);
    return { shares, collateral, principal, interest: borrowingInterest(principal, input.apr, input.termSeconds)!, ltv: principal / collateral };
  });
}

export function availableBorrowTerm(redemptionDate: string, now = Date.now()) {
  const seconds = Math.floor((Date.parse(redemptionDate) - now) / 1000) - 3 * 3600;
  if (!Number.isFinite(seconds) || seconds < 120) return null;
  const term = Math.min(30 * 86400, Math.floor(seconds / 3600) * 3600);
  return term >= 120 ? term : null;
}
