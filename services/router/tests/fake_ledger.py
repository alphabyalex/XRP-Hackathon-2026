"""An in-memory XRPL for the router-signed path: TDX balances, escrows, and all-or-nothing Batches.

It enforces the rules the real ledger does for this flow, so a settlement that would fail on devnet
fails here too: an escrow pays only its destination and only with the right fulfillment, it cannot be
finished after CancelAfter, a payment needs funds, and an all-or-nothing Batch applies every inner
transaction or none.
"""

from __future__ import annotations

import hashlib
import secrets
from decimal import Decimal

from router import ledger as L

TREASURY_KEY = "fake-order-treasury-private-key"


class FakeLedger:
    def __init__(self, balances: dict[str, str] | None = None, batch: bool = True, now: int = 800_000_000):
        self.balances: dict[str, Decimal] = {k: Decimal(v) for k, v in (balances or {}).items()}
        self.escrows: dict[tuple[str, int], dict] = {}
        self.txs: list[dict] = []  # every applied transaction, in order
        self.batches: list[list[str]] = []  # inner tags per Batch that landed
        self.batch = batch
        self.now = now
        self.seq = 1
        self.fail_tag: str | None = None  # fail the step with this tag once (a transient error)
        self.providers: set[str] = set()

    # -- Backend --

    def can_sign(self, name: str) -> bool:
        return not name.startswith("U_")

    def condition(self, nonce: str) -> dict[str, str]:
        return L.condition_for(nonce, TREASURY_KEY)

    def address(self, name: str) -> str:
        return name

    async def close_time(self) -> int:
        return self.now

    def bal(self, name: str) -> Decimal:
        return self.balances.get(name, Decimal(0))

    async def escrow_create(self, owner, destination, amount, condition, cancel_after, memo):  # noqa: ANN001
        if self.bal(owner) < Decimal(amount):
            raise L.LedgerError("EscrowCreate tecUNFUNDED")
        self.seq += 1
        self.balances[owner] = self.bal(owner) - Decimal(amount)
        self.escrows[(owner, self.seq)] = {
            "destination": destination, "amount": Decimal(amount), "condition": condition, "cancelAfter": cancel_after,
            "memo": memo,
        }
        h = secrets.token_hex(32).upper()
        self.txs.append({"type": "EscrowCreate", "from": owner, "to": destination, "amount": amount, "memo": memo, "hash": h})
        return {"hash": h, "result": "tesSUCCESS", "validated": True, "sequence": self.seq, "owner": owner}

    async def ensure_provider_account(self, provider: str) -> str:
        name = L.provider_account_name(provider)
        self.providers.add(name)
        return name

    def _apply(self, account: str, step: L.Step, scratch: dict[str, Decimal], escrows: dict) -> None:
        if self.fail_tag and step.tag == self.fail_tag:
            self.fail_tag = None
            raise L.LedgerError(f"{step.tag} tecPATH_DRY")
        if step.kind in ("finish", "cancel"):
            key = (step.escrow["owner"], int(step.escrow["sequence"]))
            e = escrows.get(key)
            if e is None:
                raise L.LedgerError("tecNO_TARGET")
            if step.kind == "finish":
                if self.now >= e["cancelAfter"]:
                    raise L.LedgerError("EscrowFinish tecNO_PERMISSION (past CancelAfter)")
                keys = L.condition_for(step.escrow["nonce"], TREASURY_KEY)
                pre = bytes.fromhex(keys["fulfillment"][8:])
                if keys["condition"] != e["condition"] or hashlib.sha256(pre).hexdigest().upper() != e["condition"][8:72]:
                    raise L.LedgerError("tecCRYPTOCONDITION_ERROR")
                if e["destination"] != account:
                    raise L.LedgerError("EscrowFinish to the wrong account")
                scratch[account] = scratch.get(account, self.bal(account)) + e["amount"]
            else:
                if self.now < e["cancelAfter"]:
                    raise L.LedgerError("EscrowCancel tecNO_PERMISSION (before CancelAfter)")
                owner = step.escrow["owner"]
                scratch[owner] = scratch.get(owner, self.bal(owner)) + e["amount"]
            del escrows[key]
            return
        amount = Decimal(step.amount)
        have = scratch.get(account, self.bal(account))
        if amount <= 0 or have < amount:
            raise L.LedgerError(f"Payment {step.tag} tecUNFUNDED_PAYMENT")
        scratch[account] = have - amount
        scratch[step.to] = scratch.get(step.to, self.bal(step.to)) + amount

    def _commit(self, account: str, group: list[L.Step], batch_hash: str | None) -> None:
        scratch: dict[str, Decimal] = {}
        escrows = dict(self.escrows)
        for s in group:
            self._apply(account, s, scratch, escrows)  # raises: nothing below is committed
        self.balances.update(scratch)
        self.escrows = escrows
        for s in group:
            s.hash, s.result, s.batch = secrets.token_hex(32).upper(), "tesSUCCESS", batch_hash
            self.txs.append({"type": s.kind, "from": account, "to": s.to, "amount": s.amount, "memo_type": s.memo_type,
                             "memo": s.memo, "tag": s.tag, "hash": s.hash, "batch": batch_hash})

    async def run_steps(self, account: str, steps: list[L.Step]) -> None:
        for group in L.chunks([s for s in steps if not s.hash]):
            if self.batch and len(group) >= 2:
                try:
                    bh = secrets.token_hex(32).upper()
                    self._commit(account, group, bh)
                    self.batches.append([s.tag for s in group])
                    continue
                except L.LedgerError:
                    pass  # all-or-nothing: nothing applied, settle one by one below
            for s in group:
                if not s.hash:
                    self._commit(account, [s], None)
