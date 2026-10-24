// Money and tx-hash formatting per BRAND.md section 9.

export function fmt(n: number, d = 2): string {
  return Number(n).toLocaleString("en-US", {
    minimumFractionDigits: d,
    maximumFractionDigits: d,
  });
}

// "9F3A01…C21E"
export function shortHash(hash: string): string {
  if (hash.length <= 12) return hash;
  return `${hash.slice(0, 6)}…${hash.slice(-4)}`;
}

export function isMockHash(hash: string): boolean {
  return hash.startsWith("MOCK");
}

// Second line of a write-action toast per BRAND.md section 6: ends with
// "simulated" while apps/api is in mock mode (tx hash prefixed MOCK).
export function txToastLine(detail: string, hash: string): string {
  const sim = isMockHash(hash) ? " · simulated" : "";
  return `${detail} · tx ${shortHash(hash)}${sim}`;
}
