// npm run history:clear (once, with the stack stopped): delete every piece of
// GPU history that no GPU actually served, so calendars, revenue and dividends
// start from real work only. Backs up first (apps/api/backups/, gitignored as
// *.db; services/compute/.state-backup-<time>/).
//
// Deleted: the old 24-hour backfill (usage sim_*, bookings simbk_*), the load
// simulator's requests that compute's mock answered (simulated = 1), their
// revenue, a mock booking's revenue (ref MOCK*), and the dividends paid from
// that revenue (dividend_runs, payouts). Kept: customers' task orders (ord_*),
// loans, trades, prices, accounts, tx_log. The ledger is not touched.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DB = path.join(ROOT, "apps", "api", "moonshift.db");
const STATE = path.join(ROOT, "services", "compute", ".state");
const stamp = new Date().toISOString().replace(/[:.]/g, "-");

const db = new DatabaseSync(DB);
const backups = path.join(ROOT, "apps", "api", "backups");
fs.mkdirSync(backups, { recursive: true });
const backup = path.join(backups, `moonshift-before-clear-${stamp}.db`);
db.exec(`VACUUM INTO '${backup.replace(/'/g, "''")}'`);
console.log(`backup: ${path.relative(ROOT, backup)}`);

const count = (sql) => db.prepare(sql).get().n;
const before = {
  usage: count(`SELECT COUNT(*) n FROM usage_events WHERE simulated = 1 OR request_id LIKE 'sim\\_%' ESCAPE '\\'`),
  bookings: count(`SELECT COUNT(*) n FROM bookings WHERE holder = 'SIM' OR id LIKE 'simbk\\_%' ESCAPE '\\'`),
  dividends: count(`SELECT COUNT(*) n FROM dividend_runs`),
  payouts: count(`SELECT COUNT(*) n FROM payouts`),
};

db.exec("BEGIN");
try {
  // Revenue that came from the requests and bookings deleted below (or a mock booking).
  const revenue = db
    .prepare(
      `DELETE FROM revenue_ledger WHERE ref LIKE 'MOCK%'
         OR ref IN (SELECT request_id FROM usage_events WHERE simulated = 1 OR request_id LIKE 'sim\\_%' ESCAPE '\\')
         OR ref IN (SELECT id FROM bookings WHERE holder = 'SIM' OR id LIKE 'simbk\\_%' ESCAPE '\\')`
    )
    .run().changes;
  db.prepare(`DELETE FROM usage_events WHERE simulated = 1 OR request_id LIKE 'sim\\_%' ESCAPE '\\'`).run();
  db.prepare(`DELETE FROM bookings WHERE holder = 'SIM' OR id LIKE 'simbk\\_%' ESCAPE '\\'`).run();
  db.prepare(`DELETE FROM payouts`).run();
  db.prepare(`DELETE FROM dividend_runs`).run();
  db.prepare(`UPDATE revenue_ledger SET dividend_run_id = NULL`).run();
  db.exec("COMMIT");
  console.log(
    `deleted: ${before.usage} requests, ${before.bookings} bookings, ${revenue} revenue entries, ${before.dividends} dividend runs, ${before.payouts} payouts`
  );
} catch (e) {
  db.exec("ROLLBACK");
  throw e;
}
const kept = db.prepare(`SELECT COUNT(*) n, ROUND(COALESCE(SUM(CAST(amount AS REAL)), 0), 6) amt FROM revenue_ledger`).get();
console.log(`kept: ${kept.n} revenue entries (${kept.amt} USDC, customers' task orders)`);
db.close();

// compute's persisted calendars (bookings and served requests while it ran in mock mode)
if (fs.existsSync(STATE)) {
  const dest = path.join(ROOT, "services", "compute", `.state-backup-${stamp}`);
  fs.renameSync(STATE, dest);
  console.log(`compute calendars moved to ${path.relative(ROOT, dest)}`);
}
