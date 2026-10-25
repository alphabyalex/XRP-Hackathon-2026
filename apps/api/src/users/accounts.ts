// Moonshift accounts: the connected wallet is the user. Each wallet gets one
// devnet account the api holds for it (custodial, like a brokerage account):
// funded, trust lines set, and a starting balance (10,000 USDC, 500 GPU-A and
// 200 GPU-B shares) so the user can borrow and rent right away.
//
// The devnet seed is encrypted at rest with MOONSHIFT_ACCOUNT_KEY (generated
// into .env on first start if missing). Seeds are never logged or returned.
// A small pool of ready accounts makes the first connect instant.

import { createCipheriv, createDecipheriv, createHash, randomBytes } from "crypto";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import type { AccountName } from "@moonshift/shared";
import * as realXrpl from "@moonshift/xrpl";
import { db } from "../db/db.js";
import { MOCK } from "../adapters/lendingAdapter.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ENV_FILE = path.join(__dirname, "..", "..", "..", "..", ".env");
const POOL_SIZE = Number(process.env.ACCOUNT_POOL_SIZE ?? 3);
const SESSION_DAYS = 30;

export interface UserAccount {
  wallet: string;
  walletNetwork: string;
  name: AccountName;
  address: string;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Seed encryption (AES-256-GCM)
// ---------------------------------------------------------------------------

function accountKey(): Buffer {
  let hex = process.env.MOONSHIFT_ACCOUNT_KEY;
  if (!hex) {
    // First start: generate the key into .env (never printed).
    hex = randomBytes(32).toString("hex");
    const prefix = fs.existsSync(ENV_FILE) && !fs.readFileSync(ENV_FILE, "utf8").endsWith("\n") ? "\n" : "";
    fs.appendFileSync(ENV_FILE, `${prefix}MOONSHIFT_ACCOUNT_KEY=${hex}\n`);
    process.env.MOONSHIFT_ACCOUNT_KEY = hex;
    console.log("generated MOONSHIFT_ACCOUNT_KEY into .env (value not shown)");
  }
  const key = Buffer.from(hex, "hex");
  if (key.length !== 32) throw new Error("MOONSHIFT_ACCOUNT_KEY must be 32 bytes of hex");
  return key;
}

function seal(seed: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", accountKey(), iv);
  const body = Buffer.concat([c.update(seed, "utf8"), c.final()]);
  return ["v1", iv.toString("base64"), c.getAuthTag().toString("base64"), body.toString("base64")].join(":");
}

function open(sealed: string): string {
  const [v, iv, tag, body] = sealed.split(":");
  if (v !== "v1") throw new Error("unknown seed encoding");
  const d = createDecipheriv("aes-256-gcm", accountKey(), Buffer.from(iv, "base64"));
  d.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([d.update(Buffer.from(body, "base64")), d.final()]).toString("utf8");
}

// ---------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------

function rowToUser(r: any): UserAccount {
  return {
    wallet: r.wallet_address,
    walletNetwork: r.wallet_network,
    name: realXrpl.userAccountName(r.account_address),
    address: r.account_address,
    createdAt: r.created_at,
  };
}

// Every stored account can sign again after a restart.
export function loadAccounts(): number {
  if (MOCK) return 0;
  const rows = db.prepare(`SELECT account_address, seed_enc FROM users`).all() as any[];
  for (const r of rows) {
    try {
      realXrpl.registerUserAccount(open(r.seed_enc));
    } catch (e) {
      console.warn(`account ${r.account_address}: could not load (${(e as Error).message})`);
    }
  }
  return rows.length;
}

export function userForWallet(wallet: string): UserAccount | null {
  const r = db.prepare(`SELECT * FROM users WHERE wallet_address = ?`).get(wallet);
  return r ? rowToUser(r) : null;
}

export function userForAccount(name: string): UserAccount | null {
  if (!realXrpl.isUserAccount(name)) return null;
  const r = db.prepare(`SELECT * FROM users WHERE account_address = ?`).get(name.slice(2));
  return r ? rowToUser(r) : null;
}

let creating: Promise<void> | null = null;

// The wallet's Moonshift account: existing, a ready one from the pool, or a new one.
export async function accountForWallet(wallet: string, walletNetwork: string): Promise<{ user: UserAccount; created: boolean; setupMs: number }> {
  const existing = userForWallet(wallet);
  if (existing) return { user: existing, created: false, setupMs: 0 };
  if (MOCK) throw new Error("ACCOUNTS_NEED_LEDGER: Moonshift accounts need the devnet ledger (MOCK_XRPL=0)");
  const t0 = Date.now();
  const pooled = db.prepare(`SELECT * FROM account_pool ORDER BY created_at LIMIT 1`).get() as any;
  let address: string;
  let sealed: string;
  if (pooled && Number(db.prepare(`DELETE FROM account_pool WHERE account_address = ?`).run(pooled.account_address).changes) === 1) {
    address = pooled.account_address;
    sealed = pooled.seed_enc;
  } else {
    const made = await realXrpl.createUserAccount();
    address = made.address;
    sealed = seal(made.seed);
    console.log(`account ${address} created for a new wallet in ${made.ms.total} ms`);
  }
  const setupMs = Date.now() - t0;
  db.prepare(
    `INSERT INTO users (wallet_address, wallet_network, account_address, seed_enc, created_at, setup_ms) VALUES (?, ?, ?, ?, ?, ?)`
  ).run(wallet, walletNetwork, address, sealed, new Date().toISOString(), setupMs);
  realXrpl.registerUserAccount(open(sealed));
  void refillPool();
  return { user: userForWallet(wallet)!, created: true, setupMs };
}

// Keep POOL_SIZE funded accounts ready (one at a time; the faucet is the bottleneck).
export function refillPool(): Promise<void> {
  if (MOCK || POOL_SIZE <= 0) return Promise.resolve();
  if (creating) return creating;
  creating = (async () => {
    try {
      for (;;) {
        const n = (db.prepare(`SELECT COUNT(*) AS n FROM account_pool`).get() as any).n as number;
        if (n >= POOL_SIZE) return;
        const made = await realXrpl.createUserAccount();
        db.prepare(`INSERT INTO account_pool (account_address, seed_enc, created_at, setup) VALUES (?, ?, ?, ?)`).run(
          made.address,
          seal(made.seed),
          new Date().toISOString(),
          JSON.stringify({ ms: made.ms, txs: made.txs })
        );
        console.log(`account pool: ${n + 1}/${POOL_SIZE} ready (set up in ${Math.round(made.ms.total / 100) / 10} s)`);
      }
    } catch (e) {
      console.warn(`account pool refill paused: ${(e as Error).message}`);
    } finally {
      creating = null;
    }
  })();
  return creating;
}

// ---------------------------------------------------------------------------
// Sessions (httpOnly cookie; the token is stored hashed)
// ---------------------------------------------------------------------------

export const SESSION_COOKIE = "ms_session";
const hash = (t: string) => createHash("sha256").update(t).digest("hex");

export function createSession(wallet: string): { token: string; maxAgeSeconds: number } {
  const token = randomBytes(32).toString("hex");
  const now = Date.now();
  db.prepare(`INSERT INTO sessions (token_hash, wallet_address, created_at, expires_at) VALUES (?, ?, ?, ?)`).run(
    hash(token),
    wallet,
    new Date(now).toISOString(),
    new Date(now + SESSION_DAYS * 86400e3).toISOString()
  );
  return { token, maxAgeSeconds: SESSION_DAYS * 86400 };
}

export function userForSession(token: string | undefined): UserAccount | null {
  if (!token) return null;
  const s = db.prepare(`SELECT wallet_address, expires_at FROM sessions WHERE token_hash = ?`).get(hash(token)) as any;
  if (!s || new Date(s.expires_at).getTime() < Date.now()) return null;
  return userForWallet(s.wallet_address);
}

export function endSession(token: string | undefined): void {
  if (token) db.prepare(`DELETE FROM sessions WHERE token_hash = ?`).run(hash(token));
}
