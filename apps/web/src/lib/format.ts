// Money and tx-hash formatting per BRAND.md section 9.

export function fmt(n: number, d = 2): string {
  return Number(n).toLocaleString("en-US", {
    minimumFractionDigits: d,
    maximumFractionDigits: d,
  });
}

// Money everywhere: 2 decimals; an amount under a cent reads "< 0.01" instead of "0.00".
export function usdc(n: number | string): string {
  const v = Number(n) || 0;
  return v > 0 && v < 0.005 ? "< 0.01" : fmt(v, 2);
}

// Typed-only amount fields (no spinner arrows, no wheel or arrow-key stepping):
// keep digits, plus one decimal point when decimals are allowed.
export function typedAmount(raw: string, decimals = true): string {
  const s = raw.replace(decimals ? /[^0-9.]/g : /[^0-9]/g, "");
  if (!decimals) return s;
  const [head, ...rest] = s.split(".");
  return rest.length ? `${head}.${rest.join("")}` : head;
}

// "9F3A01…C21E"
export function shortHash(hash: string): string {
  if (hash.length <= 12) return hash;
  return `${hash.slice(0, 6)}…${hash.slice(-4)}`;
}

export function isMockHash(hash: string): boolean {
  return hash.startsWith("MOCK");
}
