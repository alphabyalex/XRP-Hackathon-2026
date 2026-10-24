"""Sign a Moonshift link challenge offline, for the demo.

Reads the mainnet seed from the LINK_SEED environment variable (never from an argument, never
printed). Nothing is sent to any network. Prints only the public key and the signature.

    LINK_SEED=... python scripts/sign_link.py <messageHex>
"""

from __future__ import annotations

import json
import os
import sys

from xrpl.core import keypairs
from xrpl.wallet import Wallet


def main() -> None:
    if len(sys.argv) != 2:
        sys.exit("usage: LINK_SEED=... python scripts/sign_link.py <messageHex>")
    seed = os.environ.get("LINK_SEED", "")
    if not seed:
        sys.exit("LINK_SEED is not set")
    # xrpl-py reads the algorithm from the seed encoding (sEd = ed25519), so the xrpl.js
    # fromSeed bug in docs/CONTRACTS.md A10 does not apply here (checked for both algorithms).
    wallet = Wallet.from_seed(seed)
    signature = keypairs.sign(sys.argv[1], wallet.private_key)
    print(
        json.dumps(
            {"address": wallet.classic_address, "publicKey": wallet.public_key, "signature": signature}
        )
    )


if __name__ == "__main__":
    main()
