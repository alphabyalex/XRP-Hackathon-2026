"""Router-signed XRPL transactions: the order escrow and its settlement (devnet or testnet only).

Money flow for one order (TDX, shown as USDC):
  1. MS_ORDER   EscrowCreate buyer -> order treasury (PROTOCOL_FEES) for the cap, locked by a
                PREIMAGE-SHA-256 condition only the router can fulfil. CancelAfter is the buyer's safety
                valve: past it the buyer (or anyone) can cancel and the whole cap goes back to the buyer.
  2. Settlement, one all-or-nothing Batch from the order treasury (several if over 8 inner txs):
                EscrowFinish for every escrow on the order (cap + top-ups), then
                MS_SETTLE  -> TREASURY_GPU_A / TREASURY_GPU_B   (Moonshift GPUs, and the margin on external work)
                MS_SETTLE  -> PROVIDER_<NAME>                   (the external provider's cost share)
                MS_REFUND  -> buyer                             (cap minus what the served work cost)
     If Batch is not enabled or is rejected, the same steps run one by one; each step records its hash, so
     a retry never repeats a step that already landed.

The preimage is HMAC(order treasury private key, nonce) and the nonce is in the escrow memo, so nothing
secret is stored and every escrow can be finished from ledger data alone (same scheme as
packages/xrpl/src/collateral.ts uses for loan collateral).

Signing keys come from the repo .env with the same names packages/xrpl uses (DEVNET_<NAME>_SEED on devnet,
<NAME>_SEED on testnet). Seeds are never logged; only hashes are. Provider payable accounts are created by
the router from the network faucet and kept in services/router/data (gitignored).
"""

from __future__ import annotations

import asyncio
import hashlib
import hmac
import json
import logging
import os
import secrets
from dataclasses import dataclass, field
from decimal import Decimal
from pathlib import Path
from typing import Any, Protocol

from router import config as C

log = logging.getLogger("router.ledger")

# Some Python installs (python.org on macOS) ship without CA certificates, so TLS to the public XRPL nodes
# and faucet fails. Fall back to certifi's bundle unless the machine already set one.
try:
    import certifi

    os.environ.setdefault("SSL_CERT_FILE", certifi.where())
except ImportError:  # pragma: no cover
    pass

NETWORKS = {
    "devnet": {"wss": "wss://s.devnet.rippletest.net:51233", "faucet": "faucet.devnet.rippletest.net"},
    "testnet": {"wss": "wss://s.altnet.rippletest.net:51233", "faucet": "faucet.altnet.rippletest.net"},
}
MAX_BATCH = 8  # inner transactions per Batch (BatchV1_1)
RIPPLE_EPOCH = 946684800
TDX = "TDX"
TRUST_LIMIT = "1000000000"


class LedgerError(Exception):
    pass


@dataclass
class Step:
    """One settlement transaction. `kind` is finish | pay | cancel."""

    kind: str
    tag: str = ""  # what the step settles, e.g. pool:gpu-a, provider:gpu-a2, refund, escrow:0
    to: str = ""  # account name or address (pay)
    amount: str = ""  # 6-decimal TDX (pay)
    memo_type: str = ""
    memo: dict[str, Any] = field(default_factory=dict)
    escrow: dict[str, Any] = field(default_factory=dict)  # owner, sequence, nonce (finish / cancel)
    hash: str | None = None
    result: str | None = None
    batch: str | None = None  # outer Batch hash when it landed inside one

    def to_dict(self) -> dict[str, Any]:
        return dict(self.__dict__)

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> Step:
        return cls(**d)


class Backend(Protocol):
    def can_sign(self, name: str) -> bool: ...
    def condition(self, nonce: str) -> dict[str, str]: ...
    def address(self, name: str) -> str: ...
    async def close_time(self) -> int: ...
    async def escrow_create(
        self, owner: str, destination: str, amount: str, condition: str, cancel_after: int, memo: tuple[str, dict]
    ) -> dict[str, Any]: ...
    async def run_steps(self, account: str, steps: list[Step]) -> None: ...
    async def ensure_provider_account(self, provider: str) -> str: ...


# ---- pure helpers -----------------------------------------------------------------------------


def network() -> str:
    net = C.NETWORK
    if net not in NETWORKS:
        raise LedgerError(f"NETWORK must be devnet or testnet, got {net!r}. Mainnet is never used.")
    return net


def seed_env_key(name: str, net: str | None = None) -> str:
    net = net or network()
    return f"{name}_SEED" if net == "testnet" else f"{net.upper()}_{name}_SEED"


def new_nonce() -> str:
    return secrets.token_hex(12).upper()


def condition_for(nonce: str, private_key: str) -> dict[str, str]:
    """PREIMAGE-SHA-256 condition and fulfillment for a 32-byte preimage (the only type XRPL supports)."""
    preimage = hmac.new(private_key.encode(), f"moonshift-order:{nonce}".encode(), hashlib.sha256).digest()
    digest = hashlib.sha256(preimage).hexdigest().upper()
    return {"condition": "A0258020" + digest + "810120", "fulfillment": "A0228020" + preimage.hex().upper()}


def memos(memo_type: str, data: dict[str, Any]) -> list[dict[str, Any]]:
    """Same encoding as packages/xrpl: text/plain MemoType, JSON {type, ...} MemoData, both hex."""
    body = json.dumps({"type": memo_type, **data}, separators=(",", ":"))
    return [{"memo": {"memo_type": b"text/plain".hex().upper(), "memo_data": body.encode().hex().upper()}}]


def provider_account_name(provider: str) -> str:
    return "PROVIDER_" + "".join(ch if ch.isalnum() else "_" for ch in provider.upper())


def chunks(steps: list[Step]) -> list[list[Step]]:
    """Batches of at most MAX_BATCH. Every escrow finish goes in the first chunk so later payments are funded."""
    finishes = [s for s in steps if s.kind == "finish"]
    rest = [s for s in steps if s.kind != "finish"]
    if len(finishes) >= MAX_BATCH:
        raise LedgerError("too many escrows on one order to settle")
    out = [finishes + rest[: MAX_BATCH - len(finishes)]]
    rest = rest[MAX_BATCH - len(finishes) :]
    out += [rest[i : i + MAX_BATCH] for i in range(0, len(rest), MAX_BATCH)]
    return [c for c in out if c]


# ---- xrpl-py backend --------------------------------------------------------------------------


class XrplBackend:
    """Signs with wallets from .env and submits over the public devnet/testnet websocket."""

    def __init__(self) -> None:
        self._locks: dict[str, asyncio.Lock] = {}
        self._accounts: dict[str, str] | None = None
        self._providers_path = C.SERVICE_DIR / "data" / f"provider_accounts.{network()}.json"

    # -- accounts --

    def _accounts_file(self) -> dict[str, str]:
        if self._accounts is None:
            path = C.REPO_ROOT / "contracts" / f"accounts.{network()}.json"
            raw = json.loads(path.read_text()) if path.exists() else {}
            self._accounts = {k: v["address"] for k, v in raw.items() if isinstance(v, dict) and v.get("address")}
        return self._accounts

    def _providers(self) -> dict[str, dict[str, str]]:
        p = self._providers_path
        return json.loads(p.read_text()) if p.exists() else {}

    def _seed(self, name: str) -> str | None:
        if name.startswith("PROVIDER_"):
            return self._providers().get(name, {}).get("seed")
        return os.getenv(seed_env_key(name))

    def can_sign(self, name: str) -> bool:
        return bool(self._seed(name))

    def condition(self, nonce: str) -> dict[str, str]:
        """The escrow lock for one order: only the order treasury's key can produce the fulfillment."""
        return condition_for(nonce, self.wallet(C.ORDER_TREASURY).private_key)

    def wallet(self, name: str):  # noqa: ANN201 (xrpl Wallet)
        from xrpl.constants import CryptoAlgorithm
        from xrpl.wallet import Wallet

        seed = self._seed(name)
        if not seed:
            raise LedgerError(f"no signing key for {name} ({seed_env_key(name)} is not set)")
        # Seeds not starting with sEd are secp256k1; the default would derive the wrong address.
        algo = CryptoAlgorithm.ED25519 if seed.startswith("sEd") else CryptoAlgorithm.SECP256K1
        return Wallet.from_seed(seed.strip(), algorithm=algo)

    def address(self, name: str) -> str:
        if name.startswith("r") and len(name) >= 25 and name.isalnum():
            return name
        if name.startswith("U_"):  # custodial user account: the address is in the name
            return name[2:]
        if name.startswith("PROVIDER_"):
            addr = self._providers().get(name, {}).get("address")
            if not addr:
                raise LedgerError(f"{name} has no account yet")
            return addr
        addr = self._accounts_file().get(name)
        if not addr:
            raise LedgerError(f"{name} is not in contracts/accounts.{network()}.json")
        return addr

    def tdx(self, value: str):  # noqa: ANN201
        from xrpl.models.amounts import IssuedCurrencyAmount

        return IssuedCurrencyAmount(currency=TDX, issuer=self.address("TDX_ISSUER"), value=value)

    def _lock(self, account: str) -> asyncio.Lock:
        return self._locks.setdefault(account, asyncio.Lock())

    # -- network --

    def _client(self):  # noqa: ANN201
        from xrpl.asyncio.clients import AsyncWebsocketClient

        return AsyncWebsocketClient(os.getenv("DEVNET_WSS") if network() == "devnet" and os.getenv("DEVNET_WSS")
                                    else NETWORKS[network()]["wss"])

    async def close_time(self) -> int:
        from xrpl.models.requests import Ledger

        async with self._client() as client:
            r = await client.request(Ledger(ledger_index="validated"))
        return int(r.result["ledger"]["close_time"])

    async def _submit(self, client, tx, wallet) -> dict[str, Any]:  # noqa: ANN001
        from xrpl.asyncio.transaction import autofill_and_sign, submit_and_wait

        signed = await autofill_and_sign(tx, client, wallet)
        r = await submit_and_wait(signed, client)
        meta = r.result.get("meta") or {}
        out = {
            "hash": r.result.get("hash"),
            "result": meta.get("TransactionResult", "unknown"),
            "validated": bool(r.result.get("validated")),
            "sequence": signed.sequence,
        }
        log.info("ledger %s %s %s", tx.transaction_type.value, out["result"], out["hash"])
        return out

    async def escrow_create(
        self, owner: str, destination: str, amount: str, condition: str, cancel_after: int, memo: tuple[str, dict]
    ) -> dict[str, Any]:
        from xrpl.models.transactions import EscrowCreate

        w = self.wallet(owner)
        tx = EscrowCreate(
            account=w.address,
            destination=self.address(destination),
            amount=self.tdx(amount),
            condition=condition,
            cancel_after=cancel_after,
            memos=memos(*memo),
        )
        async with self._lock(w.address), self._client() as client:
            out = await self._submit(client, tx, w)
        if not str(out["result"]).startswith("tes"):
            raise LedgerError(f"EscrowCreate {out['result']}")
        return {**out, "owner": w.address}

    def _inner(self, account_addr: str, step: Step, treasury_key: str, in_batch: bool = False):  # noqa: ANN201
        from xrpl.models.transactions import EscrowCancel, EscrowFinish, Payment

        # Inside a Batch the outer transaction pays every fee and carries the only signature.
        extra: dict[str, Any] = {"fee": "0", "signing_pub_key": ""} if in_batch else {}
        if step.kind == "finish":
            keys = condition_for(step.escrow["nonce"], treasury_key)
            return EscrowFinish(
                account=account_addr,
                owner=step.escrow["owner"],
                offer_sequence=int(step.escrow["sequence"]),
                condition=keys["condition"],
                fulfillment=keys["fulfillment"],
                memos=memos(step.memo_type or "MS_ORDER_FINISH", step.memo),
                **extra,
            )
        if step.kind == "cancel":
            return EscrowCancel(
                account=account_addr, owner=step.escrow["owner"], offer_sequence=int(step.escrow["sequence"]),
                memos=memos(step.memo_type or "MS_ORDER_CANCEL", step.memo),
                **extra,
            )
        return Payment(
            account=account_addr,
            destination=self.address(step.to),
            amount=self.tdx(step.amount),
            memos=memos(step.memo_type, step.memo),
            **extra,
        )

    async def _batch_results(self, client, account_addr: str, batch_hash: str) -> dict[int, tuple[str, str]]:  # noqa: ANN001
        """Inner transactions of one Batch, by Sequence: (hash, result). They carry ParentBatchID."""
        from xrpl.models.requests import AccountTx

        r = await client.request(AccountTx(account=account_addr, limit=40))
        found: dict[int, tuple[str, str]] = {}
        for item in r.result.get("transactions", []):
            tx = item.get("tx_json") or item.get("tx") or {}
            meta = item.get("meta") or {}
            parent = meta.get("ParentBatchID") or tx.get("ParentBatchID")  # rippled puts it in the metadata
            if parent == batch_hash and tx.get("Account") == account_addr:
                found[int(tx["Sequence"])] = (item.get("hash") or tx.get("hash"), meta.get("TransactionResult"))
        return found

    async def run_steps(self, account: str, steps: list[Step]) -> None:
        """Submit every step not yet landed: Batches first, then one by one for anything a Batch did not apply."""
        from xrpl.models.transactions import Batch, BatchFlag

        w = self.wallet(account)
        key = w.private_key
        async with self._lock(w.address), self._client() as client:
            for group in chunks([s for s in steps if not s.hash]):
                if len(group) >= 2 and C.LEDGER_BATCH:
                    inner = [self._inner(w.address, s, key, in_batch=True) for s in group]
                    try:
                        out = await self._submit(
                            client, Batch(account=w.address, flags=BatchFlag.TF_ALL_OR_NOTHING, raw_transactions=inner), w
                        )
                    except Exception as e:  # noqa: BLE001 (Batch disabled or rejected: fall back below)
                        log.info("batch not used: %s", type(e).__name__)
                        out = {"result": "error", "sequence": None, "hash": None}
                    if str(out["result"]).startswith("tes") and out["sequence"] is not None:
                        # The outer Batch succeeds even when all-or-nothing applied nothing, so read what landed.
                        landed = await self._batch_results(client, w.address, out["hash"])
                        for i, s in enumerate(group):
                            h, res = landed.get(out["sequence"] + 1 + i, (None, None))
                            if h and str(res).startswith("tes"):
                                s.hash, s.result, s.batch = h, res, out["hash"]
                        if landed and any(not s.hash for s in group):
                            # Never re-send a payment that may already be on the ledger.
                            raise LedgerError(f"Batch {out['hash']} applied only part of its steps; check it before retrying")
                for s in group:  # anything the Batch did not apply goes one by one, in order
                    if not s.hash:
                        res = await self._submit(client, self._inner(w.address, s, key), w)
                        if not str(res["result"]).startswith("tes"):
                            raise LedgerError(f"{s.kind} {s.memo_type} {res['result']}")
                        s.hash, s.result = res["hash"], res["result"]

    async def ensure_provider_account(self, provider: str) -> str:
        """A router-owned payable account per external provider: faucet-funded, with a TDX trustline."""
        from xrpl.asyncio.wallet import generate_faucet_wallet
        from xrpl.models.transactions import TrustSet

        name = provider_account_name(provider)
        async with self._lock(name):
            have = self._providers()
            if name in have:
                return name
            async with self._client() as client:
                w = await generate_faucet_wallet(client, faucet_host=NETWORKS[network()]["faucet"])
                trust = TrustSet(account=w.address, limit_amount=self.tdx(TRUST_LIMIT))
                out = await self._submit(client, trust, w)
            if not str(out["result"]).startswith("tes"):
                raise LedgerError(f"TrustSet for {name} {out['result']}")
            have[name] = {"provider": provider, "address": w.address, "seed": w.seed}
            path: Path = self._providers_path
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(json.dumps(have, indent=2))
            path.chmod(0o600)
            log.info("provider account %s created at %s", name, w.address)
            return name


_backend: Backend | None = None


def backend() -> Backend:
    global _backend
    if _backend is None:
        _backend = XrplBackend()
    return _backend


def set_backend(b: Backend | None) -> None:
    """Tests swap in a fake ledger."""
    global _backend
    _backend = b


def explorer(tx_hash: str | None) -> str | None:
    return f"{C.EXPLORER}/transactions/{tx_hash}" if tx_hash else None


def as_decimal(v: str | float | Decimal) -> Decimal:
    return v if isinstance(v, Decimal) else Decimal(str(v))
