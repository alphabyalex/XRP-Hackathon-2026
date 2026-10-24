// npm run demo:check: run the judges' demo path against a running api
// (npm run demo) and print each step with its tx hash and explorer link, as
// a markdown table for docs/DEMO.md. Exits non-zero if any step fails.
// Same calls the web pages make: /lend deposit, /borrow quote + open,
// stress to margin call, stress to liquidation, restore, second loan, repay.

const API = process.env.API_URL || "http://localhost:4000";
const rows = [];
let failed = false;

async function call(method, path, body) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${method} ${path}: ${json?.error?.code ?? res.status} ${json?.error?.message ?? ""}`);
  return json;
}

function explorer(network, hash) {
  if (!hash || hash.startsWith("MOCK")) return "simulated";
  return `https://${network === "testnet" ? "testnet" : "devnet"}.xrpl.org/transactions/${hash}`;
}

function row(step, proves, hash, network) {
  rows.push({ step, proves, hash: hash ?? "", url: explorer(network, hash) });
  console.log(`ok  ${step.padEnd(44)} ${hash ?? ""}`);
}

async function step(name, fn) {
  try {
    return await fn();
  } catch (e) {
    failed = true;
    console.log(`FAIL ${name}: ${e.message}`);
    rows.push({ step: name, proves: "FAILED", hash: "", url: e.message });
    return null;
  }
}

const t0 = Date.now();
const health = await call("GET", "/health/services");
const net = health.network;
console.log(`api network: ${net}, lending: ${health.lending}, mocks: ${JSON.stringify(health.mocks)}`);

await step("deposit", async () => {
  const r = await call("POST", "/vault/deposit", { lender: "BOB", amount: "50" });
  row(`Lender deposits 50 USDC (round ${r.round})`, "XLS-65 VaultDeposit into a closed-ended vault", r.tx.hash, net);
});

const quote = await step("quote", async () => {
  // Same default the /borrow page uses: the largest amount risk approves.
  const max = await call("POST", "/loans/max", { borrower: "ALICE", gpuId: "gpu-a", collateralShares: "100" });
  const q = await call("POST", "/loans/quote", { borrower: "ALICE", gpuId: "gpu-a", collateralShares: "100", principal: max.maxPrincipal });
  console.log(
    `    quote: ${q.quote.decision}, APR ${(q.quote.apr * 100).toFixed(2)}%, LTV ${(q.quote.ltv * 100).toFixed(1)}%, margin call ${(q.quote.marginCallLtv * 100).toFixed(1)}%, liquidation ${(q.quote.liquidationLtv * 100).toFixed(1)}%, grade ${q.credit.grade}, sources ${JSON.stringify(q.sources)}`
  );
  return q;
});

const loan = quote && (await step("open", async () => {
  const l = await call("POST", "/loans/open", { quoteId: quote.quoteId });
  row("Borrower escrows 100 GPA shares", "GPU shares locked as collateral (EscrowCreate, MS_COLLATERAL)", l.txs.escrow, net);
  row(`Loan opens: ${Number(l.principal).toFixed(0)} USDC from the vault`, "XLS-66 LoanSet, broker signs, borrower countersigns", l.txs.loanSet, net);
  return l;
}));

if (loan) {
  await step("stress margin call", async () => {
    const r = await call("POST", "/demo/stress", { gpuId: "gpu-a", level: "margin_call", loanId: loan.id });
    row(`GPU price crash ${Number(r.priceBefore).toFixed(2)} to ${Number(r.priceAfter).toFixed(2)}`, "On-ledger PriceOracle update (OracleSet)", r.oracleTx.hash, net);
    const a = r.actions.find((x) => x.action === "margin_call");
    if (!a) throw new Error("no margin call fired");
    row(`Margin call at ${(a.ltv * 100).toFixed(1)}% LTV`, "MS_MARGIN_CALL memo on the borrower's ledger history", a.tx?.hash, net);
  });
  await step("stress liquidation", async () => {
    const r = await call("POST", "/demo/stress", { gpuId: "gpu-a", level: "liquidation", loanId: loan.id });
    row(`GPU price crash to ${Number(r.priceAfter).toFixed(2)}`, "OracleSet", r.oracleTx.hash, net);
    const a = r.actions.find((x) => x.action === "liquidate");
    if (!a) throw new Error("no liquidation fired");
    row(`Liquidation at ${(a.ltv * 100).toFixed(1)}% LTV`, "Escrowed shares seized (EscrowFinish, MS_LIQUIDATION); XLS-66 default follows after grace", a.tx?.hash, net);
  });
  await step("restore", async () => {
    const r = await call("POST", "/demo/stress/restore", { gpuId: "gpu-a" });
    row(`Oracle restored to ${Number(r.price).toFixed(2)}`, "OracleSet", r.tx.hash, net);
  });
}

const q2 = await step("quote 2", async () => {
  const max = await call("POST", "/loans/max", { borrower: "ALICE", gpuId: "gpu-a", collateralShares: "80" });
  return call("POST", "/loans/quote", { borrower: "ALICE", gpuId: "gpu-a", collateralShares: "80", principal: String(Math.max(1, Math.floor(Number(max.maxPrincipal) * 0.8))) });
});
const loan2 = q2 && (await step("open 2", async () => {
  const l = await call("POST", "/loans/open", { quoteId: q2.quoteId });
  row(`Second loan: ${Number(l.principal).toFixed(0)} USDC against 80 GPA`, "XLS-66 LoanSet", l.txs.loanSet, net);
  return l;
}));
if (loan2) {
  await step("repay", async () => {
    const l = await call("POST", `/loans/${loan2.id}/repay`, { mode: "full" });
    row("Borrower pays off early", "XLS-66 LoanPay with real interest (MS_REPAY)", l.txs.pay, net);
    row("Collateral back in the same ledger", "Batch (all or nothing): EscrowFinish + Payment back to borrower", l.txs.release, net);
    row("Loan closed", "XLS-66 LoanDelete", l.txs.delete, net);
  });
}

console.log(`\nfinished in ${Math.round((Date.now() - t0) / 1000)} s${failed ? " WITH FAILURES" : ""}\n`);
console.log("| # | Step | What it proves | Tx |");
console.log("|---|---|---|---|");
rows.forEach((r, i) => console.log(`| ${i + 1} | ${r.step} | ${r.proves} | ${r.url === "simulated" ? `${r.hash.slice(0, 12)} (simulated)` : r.url.startsWith("http") ? `[${r.hash.slice(0, 8)}](${r.url})` : r.url} |`));
process.exit(failed ? 1 : 0);
