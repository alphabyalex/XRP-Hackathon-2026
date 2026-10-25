import { randomBytes, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { deriveAddress, verifyKeypairSignature } from "xrpl";
import { TaskError } from "./tasksCore.js";

export interface BookingIdentity { holder: string; wallet: string; account: string }
export interface BookingTerms { gpuId: string; slotStart: string; durationSeconds: number; priceCap: string }
export interface BookingConsentRow {
  id: string; holder: string; wallet: string; account: string; gpu_id: string; slot_start: string;
  slot_end: string; duration_seconds: number; price_cap: string; message: string; expires_at: string; consumed_at: string | null;
  public_key?: string; signature?: string;
}
const LIFETIME_MS = 5 * 60000;

export class BookingConsents {
  constructor(private db: DatabaseSync, private clock = Date.now) {
    db.exec(`CREATE TABLE IF NOT EXISTS booking_consents (
      id TEXT PRIMARY KEY, holder TEXT NOT NULL, wallet TEXT NOT NULL, account TEXT NOT NULL,
      gpu_id TEXT NOT NULL, slot_start TEXT NOT NULL, slot_end TEXT NOT NULL, duration_seconds INTEGER NOT NULL,
      price_cap TEXT NOT NULL, message TEXT NOT NULL, expires_at TEXT NOT NULL, consumed_at TEXT,
      public_key TEXT, signature TEXT
    )`);
    const columns = new Set((db.prepare("PRAGMA table_info(booking_consents)").all() as Array<{ name: string }>).map(row => row.name));
    for (const column of ["public_key", "signature"]) if (!columns.has(column)) db.exec(`ALTER TABLE booking_consents ADD COLUMN ${column} TEXT`);
  }
  issue(identity: BookingIdentity, terms: BookingTerms, quotedAmount: string) {
    const id = randomUUID();
    const expiresAt = new Date(this.clock() + LIFETIME_MS).toISOString();
    const slotEnd = new Date(Date.parse(terms.slotStart) + terms.durationSeconds * 1000).toISOString();
    const message = ["Moonshift GPU booking consent v1", "Purpose: reserve GPU time and authorize one rental payment.",
      `Wallet: ${identity.wallet}`, `Account: ${identity.account}`, `GPU: ${terms.gpuId}`,
      `Start: ${terms.slotStart}`, `End: ${slotEnd}`, `Quoted total: ${quotedAmount} USDC`,
      `Maximum payment: ${terms.priceCap} USDC`, `Request: ${id}`, `Nonce: ${randomBytes(32).toString("hex")}`,
      `Expires: ${expiresAt}`].join("\n");
    this.db.prepare(`INSERT INTO booking_consents (id,holder,wallet,account,gpu_id,slot_start,slot_end,duration_seconds,price_cap,message,expires_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(id, identity.holder, identity.wallet, identity.account, terms.gpuId,
        terms.slotStart, slotEnd, terms.durationSeconds, terms.priceCap, message, expiresAt);
    return { challengeId: id, message, messageHex: Buffer.from(message).toString("hex").toUpperCase(), expiresAt,
      ...terms, slotEnd, account: identity.account, wallet: identity.wallet, quotedAmount };
  }
  verify(identity: BookingIdentity, terms: BookingTerms, proof: Record<string, unknown>): BookingConsentRow {
    const id = typeof proof.challengeId === "string" ? proof.challengeId : "";
    const row = this.db.prepare("SELECT * FROM booking_consents WHERE id=?").get(id) as BookingConsentRow | undefined;
    if (!row || row.holder !== identity.holder || row.wallet !== identity.wallet || row.account !== identity.account) {
      throw new TaskError("BOOKING_CONSENT_REQUIRED", "Approve this booking with your connected wallet.", 403);
    }
    if (row.gpu_id !== terms.gpuId || row.slot_start !== terms.slotStart || row.duration_seconds !== terms.durationSeconds || row.price_cap !== terms.priceCap) {
      throw new TaskError("BOOKING_CONSENT_CHANGED", "The booking changed. Approve the new range and price cap.", 403);
    }
    try {
      if (typeof proof.publicKey !== "string" || typeof proof.signature !== "string" || proof.publicKey.length > 130 || proof.signature.length > 160
          || deriveAddress(proof.publicKey) !== identity.wallet
          || !verifyKeypairSignature(Buffer.from(row.message).toString("hex"), proof.signature, proof.publicKey)) throw new Error("Invalid signature");
    } catch { throw new TaskError("INVALID_BOOKING_SIGNATURE", "The wallet signature does not approve this booking.", 403); }
    return { ...row, public_key: proof.publicKey as string, signature: proof.signature as string };
  }
  consume(row: BookingConsentRow): void {
    if (Date.parse(row.expires_at) <= this.clock()) throw new TaskError("BOOKING_CONSENT_EXPIRED", "The approval expired. Approve this booking again.", 409);
    const result = this.db.prepare("UPDATE booking_consents SET consumed_at=?,public_key=?,signature=? WHERE id=? AND consumed_at IS NULL AND expires_at>?")
      .run(new Date(this.clock()).toISOString(), row.public_key ?? null, row.signature ?? null, row.id, new Date(this.clock()).toISOString());
    if (Number(result.changes) !== 1) throw new TaskError("BOOKING_CONSENT_USED", "This approval was already used. Check its reservation before trying again.", 409);
  }
}
