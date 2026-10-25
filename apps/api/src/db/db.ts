// Node's built-in sqlite module (stable API shape, still flagged
// experimental by Node itself). Avoids needing a native build toolchain
// (node-gyp/Visual Studio) that better-sqlite3 would require on this machine.
import { DatabaseSync } from "node:sqlite";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, "..", "..", "moonshift.db");

export const db = new DatabaseSync(DB_PATH);
db.exec("PRAGMA journal_mode = WAL");

const schema = fs.readFileSync(path.join(__dirname, "schema.sql"), "utf8");
db.exec(schema);
// Columns added after the first release (ALTER fails harmlessly once they exist).
for (const sql of ["ALTER TABLE dividend_runs ADD COLUMN per_share TEXT", "ALTER TABLE share_reference ADD COLUMN reset_at TEXT"]) {
  try {
    db.exec(sql);
  } catch {
    // already there
  }
}

export function resetDb(): void {
  const tables = [
    "usage_events",
    "revenue_ledger",
    "dividend_runs",
    "payouts",
    "redemptions",
    "bookings",
    "loans",
    "tx_log",
    "holders_cache",
    "inference_credits",
    "xls_loans",
    "loan_quotes",
    "oracle_history",
    "keeper_actions",
    "credit_events",
  ];
  for (const t of tables) {
    db.exec(`DELETE FROM ${t}`);
  }
}
