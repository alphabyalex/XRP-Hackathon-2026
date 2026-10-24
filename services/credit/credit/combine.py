"""Combined profile: a devnet borrower's Moonshift history plus a linked mainnet payment history.

Quicknode serves XRPL mainnet and testnet, not devnet. Moonshift's XLS-66 loans live on devnet,
so a borrower's loan record (repayments, margin calls, liquidations: the ms* features) is read
from the public devnet node. Their real-world payment history (age, volume, counterparties,
stability) comes from a linked mainnet address read through Quicknode. One score is computed
over the merged features, and every part says where it came from.

A link is either verified (signed-message flow in link.py) or a labeled demo link
("unverified, demo") for addresses nobody on the team holds the key to.
"""

from __future__ import annotations

from typing import Any

from credit import features as F
from credit import profile, scoring
from credit.profile import iso

MOONSHIFT_FEATURES = (
    "msRepaysOnTime",
    "msRepaysLate",
    "msMarginCalls",
    "msLiquidations",
    "msDividendsReceived",
    "msShareTrades",
)


def merge(borrower: dict[str, F.Feature], linked: dict[str, F.Feature]) -> dict[str, F.Feature]:
    """Payment-history features from the linked address, Moonshift features from the borrower."""
    out = dict(linked)
    for k in MOONSHIFT_FEATURES:
        out[k] = borrower[k]
    return out


async def build(
    network: str,
    address: str,
    link: dict[str, Any],
    refresh: bool = False,
) -> dict[str, Any]:
    """link = {"mainnetAddress", "ownership": {"verified": bool, "status": str, ...}}"""
    own_body, own_hist = await profile.build(network, address, refresh)
    linked_body, linked_hist = await profile.build("mainnet", link["mainnetAddress"], refresh)
    feats = merge(F.extract(own_hist), F.extract(linked_hist))
    s = scoring.score(feats)
    reasons = list(s.reasons)
    if linked_body["history"]["truncated"]:
        reasons.append("HISTORY_TRUNCATED")
    general = [k for k in s.features if k not in MOONSHIFT_FEATURES]
    for k, v in s.features.items():
        v["from"] = network if k in MOONSHIFT_FEATURES else "mainnet"
    return {
        "address": address,
        "network": network,
        "readOnly": False,
        "source": "combined",
        "simulated": False,
        "combined": True,
        "score": s.score,
        "grade": s.grade,
        "confidence": s.confidence,
        "features": s.features,
        "reasons": reasons,
        "scorecard": {
            "version": scoring.scorecard()["version"],
            "basePoints": scoring.scorecard()["basePoints"],
            "rawPoints": s.raw_points,
            "cap": s.cap,
        },
        "components": [
            {
                "part": "Moonshift loan history",
                "network": network,
                "address": address,
                "source": own_body["source"],  # "public": Quicknode has no devnet
                "features": list(MOONSHIFT_FEATURES),
                "history": own_body["history"],
                "ownScore": {"score": own_body["score"], "grade": own_body["grade"], "confidence": own_body["confidence"]},
            },
            {
                "part": "Linked payment history",
                "network": "mainnet",
                "address": link["mainnetAddress"],
                "source": linked_body["source"],  # "quicknode" when configured
                "readOnly": True,
                "features": general,
                "history": linked_body["history"],
                "ownScore": {"score": linked_body["score"], "grade": linked_body["grade"], "confidence": linked_body["confidence"]},
                "ownership": link["ownership"],
            },
        ],
        "history": own_body["history"],
        "portfolio": None,
        "ownership": link["ownership"],
        "asOf": iso(own_hist.now),
    }
