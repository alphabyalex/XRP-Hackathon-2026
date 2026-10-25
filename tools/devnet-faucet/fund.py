"""Refill existing public Devnet (default) or Testnet accounts. Never creates a wallet."""
import argparse
import json
import os
from pathlib import Path
import re
import time
from decimal import Decimal
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

NODE = "https://s.devnet.rippletest.net:51234"
FAUCET = "https://faucet.devnet.rippletest.net/accounts"
# --network testnet: same request shape ({"destination": address}) on the Testnet faucet.
NETWORKS = {
    "devnet": (NODE, FAUCET),
    "testnet": ("https://s.altnet.rippletest.net:51234", "https://faucet.altnet.rippletest.net/accounts"),
}


def post(url, payload):
    for attempt in range(7):
        try:
            req = Request(url, json.dumps(payload).encode(), {"Content-Type": "application/json"})
            with urlopen(req, timeout=30) as response:
                return json.load(response)
        except HTTPError as exc:
            if exc.code != 429 and exc.code < 500:
                raise RuntimeError("request failed") from None
            delay = max(2 ** attempt, float(exc.headers.get("Retry-After", "0")))
        except (URLError, TimeoutError):
            delay = 2 ** attempt
        time.sleep(min(delay, 60))
    raise RuntimeError("request unavailable")


def balance(address):
    result = post(NODE, {"method": "account_info", "params": [{"account": address, "ledger_index": "validated"}]})["result"]
    if result.get("error") == "actNotFound":
        return Decimal(0)
    if "account_data" not in result:
        raise RuntimeError("balance unavailable")
    return Decimal(result["account_data"]["Balance"]) / 1_000_000


def fund(address, minimum, target, pause):
    before = after = balance(address)
    if before < minimum:
        # Each refill adds a fixed amount (100 XRP today); allow enough calls for large targets.
        for _ in range(max(50, int((target - before) / 50) + 10)):
            if after >= target:
                break
            # Refill responses may omit balance. Always verify on ledger.
            post(FAUCET, {"destination": address})
            for _ in range(12):
                time.sleep(pause)
                updated = balance(address)
                if updated > after:
                    after = updated
                    break
            else:
                raise RuntimeError("funding not confirmed")
        if after < target:
            raise RuntimeError("target not reached")
    return before, after


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--address")
    parser.add_argument("--min-xrp", type=Decimal, default=Decimal(os.getenv("MIN_XRP", "100")))
    parser.add_argument("--target-xrp", type=Decimal, default=Decimal(os.getenv("TARGET_XRP", "300")))
    parser.add_argument("--pause", type=float, default=5)
    parser.add_argument("--network", choices=sorted(NETWORKS), default=os.getenv("FAUCET_NETWORK", "devnet"))
    args = parser.parse_args()
    global NODE, FAUCET
    NODE, FAUCET = NETWORKS[args.network]
    if not args.min_xrp.is_finite() or not args.target_xrp.is_finite() or not 0 < args.min_xrp <= args.target_xrp or args.pause < 1:
        return 1
    if args.address:
        accounts = {"EXTRA": {"address": args.address}}
    else:
        accounts = json.loads((Path(__file__).resolve().parents[2] / f"contracts/accounts.{args.network}.json").read_text())
    print("| name | address | XRP before | XRP after |", flush=True)
    print("| --- | --- | ---: | ---: |", flush=True)
    failed = False
    for name, account in accounts.items():
        if not isinstance(account, dict):
            continue
        address = account.get("address", "")
        if not re.fullmatch(r"r[1-9A-HJ-NP-Za-km-z]{24,34}", address):
            failed = True
            continue
        try:
            before, after = fund(address, args.min_xrp, args.target_xrp, args.pause)
            print(f"| {name} | {address} | {before:f} | {after:f} |", flush=True)
        except Exception:
            failed = True
            print(f"| {name} | {address} | unavailable | unavailable |", flush=True)
    return int(failed)


if __name__ == "__main__":
    raise SystemExit(main())
