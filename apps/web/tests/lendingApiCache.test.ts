import test from "node:test";
import assert from "node:assert/strict";

test("actual quote wrapper scopes cached responses by wallet and invalidates after loan actions", async () => {
  const originalFetch = globalThis.fetch;
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { configurable: true, value: { location: { hostname: "localhost", origin: "http://localhost" } } });
  let identity = "wallet-a", quotes = 0;
  globalThis.fetch = async (url, init) => {
    const path = new URL(String(url)).pathname;
    if (path === "/wallet/me") return Response.json({ wallet: { address: identity }, account: { address: `${identity}-account` } });
    if (path === "/loans/quote") { quotes++; return Response.json({ borrower: identity, quoteId: `fixture-quote-${quotes}` }); }
    if (path === "/loans/open") { assert.equal(init?.method, "POST"); return Response.json({ id: "fixture-loan" }); }
    assert.fail(`Unexpected read boundary ${path}`);
  };
  try {
    const api = await import("../src/lib/lendingApi");
    await api.walletGet();
    const [one, two] = await Promise.all([api.quoteLoan("gpu-a", "10", "20"), api.quoteLoan("gpu-a", "10.0", "20.0")]);
    assert.equal(one.quoteId, two.quoteId);
    assert.equal(quotes, 1);
    await api.openFromQuote(one.quoteId);
    await api.quoteLoan("gpu-a", "10", "20");
    assert.equal(quotes, 2, "A consumed quote must not be reused after a loan action");
    identity = "wallet-b";
    await api.walletGet();
    const next = await api.quoteLoan("gpu-a", "10", "20");
    assert.equal(next.borrower, "wallet-b");
    assert.equal(quotes, 3, "Another wallet cannot receive the prior wallet's cached quote");
    api.invalidateLendingReads();
  } finally {
    globalThis.fetch = originalFetch;
    if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
    else Reflect.deleteProperty(globalThis, "window");
  }
});
