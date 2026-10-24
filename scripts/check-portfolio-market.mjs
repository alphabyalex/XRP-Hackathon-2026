import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { writeFile } from "node:fs/promises";

let playwright;
try { playwright = await import("playwright"); }
catch {
  if (!process.env.PLAYWRIGHT_MODULE) throw new Error("Install Playwright or set PLAYWRIGHT_MODULE");
  playwright = await import(pathToFileURL(path.resolve(process.env.PLAYWRIGHT_MODULE)).href);
}
const api = process.env.API_URL || "http://localhost:4000";
const web = process.env.WEB_URL || "http://localhost:3000";
const results = [];
const errors = [];
const market = await (await fetch(`${api}/gpu-prices`)).json();
assert.equal(market.source.name, "GPU Economy");
assert.ok(market.gpus.length > 10);
assert.ok(market.gpus.find(g => g.id === "h100-sxm").weeklyHistory.length >= 2);
assert.ok(market.refreshSeconds >= 900);
assert.equal(market.stale, false);
const second = await (await fetch(`${api}/gpu-prices`)).json();
assert.equal(second.checkedAt, market.checkedAt, "Browser requests must share the upstream cache");
assert.deepEqual(second.gpus.map(g => g.observations), market.gpus.map(g => g.observations), "Reads must not manufacture price observations");
for (const days of [7, 30, 90]) {
  const response = await (await fetch(`${api}/account/ALICE/returns?days=${days}`)).json();
  assert.equal(response.series[0].days.length, days);
  assert.equal(response.series.reduce((sum, s) => sum + Number(s.totalEarned), 0).toFixed(6), response.totalEarned);
}
assert.equal((await fetch(`${api}/account/ALICE/returns?days=999`)).status, 400);
await writeFile("contracts/api/gpu-prices.json", JSON.stringify(market, null, 2) + "\n");
await writeFile("contracts/api/account-returns.json", JSON.stringify(await (await fetch(`${api}/account/ALICE/returns?days=30`)).json(), null, 2) + "\n");
results.push(`PASS real GPU Economy feed: ${market.gpus.length} models, source timestamp, shared cache, persistent observations, 7/30/90-day returns`);

const browser = await playwright.chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || "msedge", headless: true });
try {
  for (const width of [1280, 400]) {
    const page = await browser.newPage({ viewport: { width, height: 1000 } });
    page.on("pageerror", e => errors.push(e.message));
    page.on("console", m => { if (m.type() === "error") errors.push(m.text()); });
    await page.goto(`${web}/portfolio`);
    await page.getByTestId("net-worth").waitFor();
    const returns = page.getByTestId("portfolio-returns");
    await returns.locator(".portfolio-return-total").waitFor();
    await returns.getByRole("button", { name: "7D", exact: true }).click();
    await returns.locator(".portfolio-return-table th").filter({ hasText: "Received 7d" }).waitFor();
    await returns.getByLabel("Returns GPU").selectOption("gpu-b");
    assert.equal(await returns.locator("tbody tr").count(), 1);
    const prices = page.getByTestId("gpu-market-prices");
    await prices.getByRole("heading", { name: "NVIDIA H100 SXM", exact: true }).waitFor();
    await prices.getByRole("img", { name: "NVIDIA H100 SXM rental price history" }).focus();
    await page.keyboard.press("ArrowLeft");
    assert.ok(await prices.locator(".portfolio-history-readout").innerText());
    await prices.getByRole("button", { name: "NVIDIA RTX 4090", exact: true }).click();
    await prices.getByRole("heading", { name: "NVIDIA RTX 4090", exact: true }).waitFor();
    await prices.getByRole("img", { name: "NVIDIA RTX 4090 rental price history" }).waitFor();
    await prices.getByRole("button", { name: "Tracked 7D", exact: true }).click();
    await prices.getByText("Recorded source prices", { exact: true }).waitFor();
    const missing = market.gpus.find(g => g.rentalUsdPerHour === null);
    if (missing) {
      await prices.getByLabel("GPU price model").selectOption(missing.id);
      await prices.getByText("No published price", { exact: true }).waitFor();
    }
    await prices.getByRole("button", { name: "Weekly history", exact: true }).click();
    await prices.getByLabel("GPU price model").selectOption("h100-sxm");
    await returns.getByRole("button", { name: "30D", exact: true }).click();
    await returns.locator(".portfolio-return-table th").filter({ hasText: "Received 30d" }).waitFor();
    await returns.getByLabel("Returns GPU").selectOption("All");
    await page.evaluate(() => document.fonts.ready);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    if (width === 400) {
      assert.equal(await prices.locator('.account-table-scroll').evaluate(el => el.scrollWidth <= el.clientWidth + 1), true, 'Rental quotes fit on mobile');
      assert.equal(await returns.locator('.account-table-scroll').evaluate(el => el.scrollWidth <= el.clientWidth + 1), true, 'Per-GPU cash returns fit on mobile');
    }
    assert.equal(/\b(demo|simulated|mock|test|devnet|mainnet|testnet)\b/i.test(await page.locator("body").innerText()), false);
    await page.addStyleTag({ content: "nextjs-portal {display:none}" });
    await page.evaluate(() => scrollTo(0, 0));
    await page.screenshot({ path: `docs/screens/portfolio-${width}.png`, fullPage: true });
    results.push(`PASS ${width}px: USDC/shares, return ranges and GPU filter, rental models, weekly/tracked history, keyboard cursor, no overflow, screenshot`);
    await page.close();
  }

  // Advance a browser clock, keeping the real publisher unpolled.
  const page = await browser.newPage();
  let reads = 0;
  await page.clock.install();
  await page.route("**/gpu-prices", route => {
    reads++;
    const updated = structuredClone(market);
    updated.gpus.find(g => g.id === "h100-sxm").rentalUsdPerHour = String(3 + reads);
    return route.fulfill({ json: updated });
  });
  await page.goto(`${web}/portfolio`);
  await page.getByTestId("gpu-market-prices").locator(".portfolio-price-quote").waitFor();
  const initial = reads;
  await page.clock.runFor(60001);
  await page.waitForFunction(() => document.querySelector('.portfolio-price-quote p')?.textContent?.includes("5.0000"));
  assert.ok(reads > initial, "Visible prices refresh after 60 seconds");
  results.push("PASS automatic 60-second browser refresh updates the displayed quote");
  await page.close();
  assert.deepEqual(errors, []);
  results.push("PASS no browser errors");
  console.log(results.join("\n"));
} finally { await browser.close(); }
