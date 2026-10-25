// Must stay the first import: loads the monorepo .env before any module
// reads process.env (ESM evaluates imports in order).
import "./env.js";
import express from "express";
import cors from "cors";
import { PORTS } from "@moonshift/shared";
import { gpusRouter } from "./routes/gpus.js";
import { portfolioRouter } from "./routes/portfolio.js";
import { accountRouter } from "./routes/account.js";
import { gpuPricesRouter } from "./routes/gpuPrices.js";
import { startGpuPricePolling } from "./marketData/gpuPrices.js";
import { startHealthChecks } from "./gpuHealth.js";
import { txRouter } from "./routes/tx.js";
import { sharesRouter } from "./routes/shares.js";
import { contractsRouter } from "./routes/contracts.js";
import { inferenceRouter } from "./routes/inference.js";
import { loansRouter } from "./routes/loans.js";
import { lendingRouter } from "./routes/lending.js";
import { adminRouter } from "./routes/admin.js";
import { internalRouter } from "./routes/internal.js";
import { eventsRouter } from "./routes/events.js";
import { routerInternal, routerPublic } from "./routes/router.js";
import { requireAdminKey, requireInternalKey } from "./middleware/auth.js";
import { sessionUser } from "./middleware/session.js";
import { loadAccounts, refillPool } from "./users/accounts.js";
import { startBackgroundJobs } from "./jobs.js";
import "./db/db.js"; // ensures schema is created on boot

const app = express();

const webOrigin = process.env.WEB_ORIGIN ?? `http://localhost:${PORTS.web}`;
// credentials: the session cookie (the signed-in wallet) rides along from the web app.
app.use(cors({ origin: webOrigin, credentials: true }));
app.use(express.json());
app.use(sessionUser);

// public reads
app.use(gpusRouter);
app.use(portfolioRouter);
app.use(accountRouter);
app.use(gpuPricesRouter);
app.use(txRouter);

// public writes
app.use(sharesRouter);
app.use(contractsRouter);
app.use(inferenceRouter);
app.use(lendingRouter);
app.use(loansRouter);
app.use(routerPublic); // order router (services/router)

// admin (gated)
app.use("/admin", requireAdminKey, adminRouter);

// internal (gated)
app.use("/internal", requireInternalKey, internalRouter);
app.use("/internal", requireInternalKey, routerInternal);

// live updates
app.use(eventsRouter);

app.get("/health", (_req, res) => res.json({ ok: true }));

// Which GPUs are listed depends on their endpoints answering: check before serving.
void startHealthChecks();

const PORT = Number(process.env.PORT ?? PORTS.api);
app.listen(PORT, () => {
  console.log(`apps/api listening on http://localhost:${PORT}`);
  console.log(
    `network: ${process.env.NETWORK ?? "testnet"}  mocks: MOCK_XRPL=${process.env.MOCK_XRPL ?? "1"} MOCK_COMPUTE=${process.env.MOCK_COMPUTE ?? "1"} MOCK_PRICING=${process.env.MOCK_PRICING ?? "1"} MOCK_RISK=${process.env.MOCK_RISK ?? "1"} MOCK_CREDIT=${process.env.MOCK_CREDIT ?? "1"}`
  );
  const accounts = loadAccounts();
  if (accounts) console.log(`loaded ${accounts} Moonshift accounts`);
  void refillPool();
  startBackgroundJobs();
  startGpuPricePolling();
});
