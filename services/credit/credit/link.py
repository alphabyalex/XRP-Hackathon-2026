"""Prove a borrower controls a mainnet address (off-ledger signed message, verified with xrpl-py).

Nothing here sends a transaction. The borrower signs the challenge's messageHex with the mainnet
account's key (xrpl-py keypairs.sign or ripple-keypairs sign), and we check that:
  1. the signature verifies against the given public key, and
  2. the public key is the account's master key (derives the address) or its current RegularKey
     (read-only account_info on mainnet, through Quicknode when configured).
"""

from __future__ import annotations

import json
import secrets
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Any

from xrpl.core import keypairs

from credit import config as C
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
        if rows:
            return {
                "verified": True,
                "status": "verified",
                "borrower": rows[0]["borrower"],
                "verifiedAt": rows[0]["verified_at"],
            }
        demo = self.db.execute("SELECT * FROM demo_links WHERE mainnet_address = ?", (mainnet_address,))
        if demo:
            return {
                "verified": False,
                "status": "unverified, demo",
                "borrower": demo[0]["borrower"],
                "linkedAt": demo[0]["created_at"],
            }
        return None

    # Demo links: nobody on the team holds the key for a mainnet address with real history, so the
    # demo can attach one without a signature. Always labeled "unverified, demo"; a verified link for
    # the same borrower takes precedence.
    def demo_link(self, borrower: str, mainnet_address: str, now: datetime) -> dict[str, Any]:
        at = now.strftime("%Y-%m-%dT%H:%M:%SZ")
        self.db.execute("INSERT OR REPLACE INTO demo_links VALUES (?, ?, ?)", (borrower, mainnet_address, at))
        return {"borrower": borrower, "mainnetAddress": mainnet_address, "verified": False, "status": "unverified, demo", "linkedAt": at}

    def link_for(self, borrower: str) -> dict[str, Any] | None:
        """The mainnet address to combine with this borrower's profile, verified first."""
        rows = self.db.execute("SELECT * FROM links WHERE borrower = ? ORDER BY verified_at DESC", (borrower,))
        if rows:
            return {"mainnetAddress": rows[0]["mainnet_address"], "ownership": self.ownership(rows[0]["mainnet_address"])}
        demo = self.db.execute("SELECT * FROM demo_links WHERE borrower = ?", (borrower,))
        if demo:
            return {"mainnetAddress": demo[0]["mainnet_address"], "ownership": self.ownership(demo[0]["mainnet_address"])}
        for d in configured_demo_links():
            if d["borrowerAddress"] == borrower:
                return {
                    "mainnetAddress": d["mainnetAddress"],
                    "ownership": {
                        "verified": False,
                        "status": "unverified, demo",
                        "borrower": borrower,
                        "borrowerName": d["borrowerName"],
                        "via": "demo_addresses.json",
                    },
                }
        return None


    def links_for(self, borrower: str) -> list[dict[str, Any]]:
        rows = self.db.execute("SELECT * FROM links WHERE borrower = ? ORDER BY verified_at", (borrower,))
        return [{"mainnetAddress": r["mainnet_address"], "verifiedAt": r["verified_at"]} for r in rows]


def configured_demo_links() -> list[dict[str, Any]]:
    """demoLinks from services/credit/demo_addresses.json, with each borrower name resolved to its
    current address in contracts/accounts.<network>.json."""
    path = C.SERVICE_DIR / "demo_addresses.json"
    try:
        links = json.loads(path.read_text()).get("demoLinks", [])
    except (OSError, json.JSONDecodeError):
        return []
    out = []
    for d in links:
        try:
            accounts = json.loads((C.REPO_ROOT / "contracts" / f"accounts.{d['network']}.json").read_text())
            addr = accounts.get(d["borrowerName"], {}).get("address")
        except (OSError, json.JSONDecodeError, KeyError, AttributeError):
            continue
        if addr:
            out.append({**d, "borrowerAddress": addr})
    return out


def linker() -> Linker:
    return Linker(store())
