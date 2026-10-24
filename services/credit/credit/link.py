"""Prove a borrower controls a mainnet address (off-ledger signed message, verified with xrpl-py).

Nothing here sends a transaction. The borrower signs the challenge's messageHex with the mainnet
account's key (xrpl-py keypairs.sign or ripple-keypairs sign), and we check that:
  1. the signature verifies against the given public key, and
  2. the public key is the account's master key (derives the address) or its current RegularKey
     (read-only account_info on mainnet, through Quicknode when configured).
"""

from __future__ import annotations

import secrets
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Any

from xrpl.core import keypairs

from credit.db import Store, store
from credit.errors import CreditError as LinkError
from credit.xrpl_client import XrplClient

CHALLENGE_TTL = timedelta(minutes=10)


@dataclass
class Linker:
    db: Store

    def challenge(self, borrower: str, mainnet_address: str, now: datetime) -> dict[str, Any]:
        nonce = secrets.token_hex(4)
        expires = now + CHALLENGE_TTL
        expires_iso = expires.strftime("%Y-%m-%dT%H:%M:%SZ")
        message = (
            f"Moonshift link: borrower {borrower} controls {mainnet_address}. "
            f"Nonce {nonce}. Expires {expires_iso}"
        )
        cid = "lc_" + secrets.token_hex(6)
        self.db.execute(
            "INSERT INTO link_challenges VALUES (?, ?, ?, ?, ?)",
            (cid, borrower, mainnet_address, message, expires.isoformat()),
        )
        return {
            "challengeId": cid,
            "message": message,
            "messageHex": message.encode().hex().upper(),
            "expiresAt": expires_iso,
        }

    async def verify(
        self,
        challenge_id: str,
        public_key: str,
        signature: str,
        now: datetime,
        client: XrplClient | None = None,
    ) -> dict[str, Any]:
        rows = self.db.execute("SELECT * FROM link_challenges WHERE id = ?", (challenge_id,))
        if not rows or datetime.fromisoformat(rows[0]["expires_at"]) < now:
            raise LinkError(404, "CHALLENGE_NOT_FOUND", "unknown or expired challengeId")
        ch = rows[0]
        try:
            derived = keypairs.derive_classic_address(public_key)
            valid = keypairs.is_valid_message(ch["message"].encode(), bytes.fromhex(signature), public_key)
        except Exception:  # malformed key or signature hex
            raise LinkError(422, "BAD_SIGNATURE", "public key or signature is malformed") from None
        if derived != ch["mainnet_address"]:
            client = client or XrplClient("mainnet")
            info = await client.account_info(ch["mainnet_address"], refresh=True)
            if info.get("account_data", {}).get("RegularKey") != derived:
                raise LinkError(
                    422, "KEY_ADDRESS_MISMATCH", "publicKey is neither the master key nor the RegularKey"
                )
        if not valid:
            raise LinkError(422, "BAD_SIGNATURE", "signature does not verify")
        verified_at = now.strftime("%Y-%m-%dT%H:%M:%SZ")
        self.db.execute(
            "INSERT OR REPLACE INTO links VALUES (?, ?, ?, ?)",
            (ch["mainnet_address"], ch["borrower"], public_key, verified_at),
        )
        self.db.execute("DELETE FROM link_challenges WHERE id = ?", (challenge_id,))
        return {
            "verified": True,
            "borrower": ch["borrower"],
            "mainnetAddress": ch["mainnet_address"],
            "verifiedAt": verified_at,
        }

    def ownership(self, mainnet_address: str) -> dict[str, Any] | None:
        rows = self.db.execute("SELECT * FROM links WHERE mainnet_address = ?", (mainnet_address,))
        if not rows:
            return None
        return {"verified": True, "borrower": rows[0]["borrower"], "verifiedAt": rows[0]["verified_at"]}

    def links_for(self, borrower: str) -> list[dict[str, Any]]:
        rows = self.db.execute("SELECT * FROM links WHERE borrower = ? ORDER BY verified_at", (borrower,))
        return [{"mainnetAddress": r["mainnet_address"], "verifiedAt": r["verified_at"]} for r in rows]


def linker() -> Linker:
    return Linker(store())
