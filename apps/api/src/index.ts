import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import express from "express";
import cors from "cors";

// .env lives at the monorepo root, not apps/api/, and process.cwd() here is
// apps/api/ when npm runs this workspace's script. Load it explicitly.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, "..", "..", "..", ".env") });
import { PORTS } from "@moonshift/shared";
import { gpusRouter } from "./routes/gpus.js";
import { portfolioRouter } from "./routes/portfolio.js";
import { txRouter } from "./routes/tx.js";
import { sharesRouter } from "./routes/shares.js";
import { contractsRouter } from "./routes/contracts.js";
import { inferenceRouter } from "./routes/inference.js";
import { loansRouter } from "./routes/loans.js";
import { adminRouter } from "./routes/admin.js";
import { internalRouter } from "./routes/internal.js";
import { eventsRouter } from "./routes/events.js";
import { requireAdminKey, requireInternalKey } from "./middleware/auth.js";
import { startBackgroundJobs } from "./jobs.js";
import "./db/db.js"; // ensures schema is created on boot

const app = express();

const webOrigin = process.env.WEB_ORIGIN ?? `http://localhost:${PORTS.web}`;
app.use(cors({ origin: webOrigin }));
app.use(express.json());

// public reads
app.use(gpusRouter);
app.use(portfolioRouter);
app.use(txRouter);

// public writes
app.use(sharesRouter);
app.use(contractsRouter);
app.use(inferenceRouter);
app.use(loansRouter);

// admin (gated)
app.use("/admin", requireAdminKey, adminRouter);

// internal (gated)
app.use("/internal", requireInternalKey, internalRouter);

// live updates
app.use(eventsRouter);

app.get("/health", (_req, res) => res.json({ ok: true }));

const PORT = Number(process.env.PORT ?? PORTS.api);
app.listen(PORT, () => {
  console.log(`apps/api listening on http://localhost:${PORT}`);
  console.log(
    `mocks: MOCK_XRPL=${process.env.MOCK_XRPL ?? "1"} MOCK_COMPUTE=${process.env.MOCK_COMPUTE ?? "1"} MOCK_PRICING=${process.env.MOCK_PRICING ?? "1"}`
  );
  startBackgroundJobs();
});
