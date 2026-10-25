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
    reference: dict[str, Any] | None = None,
    refresh_link: bool = False,
) -> dict[str, Any]:
    """link = {"mainnetAddress", "ownership": {...}} (a mainnet history), or a connected wallet
    {"network": "testnet", "address", "ownership": {...}}. reference: a mainnet link shown as its
    own line (own score) but not part of this score, used when a connected wallet replaces it."""
    link_net = link.get("network", "mainnet")
    link_addr = link.get("address") or link["mainnetAddress"]
    own_body, own_hist = await profile.build(network, address, refresh)
    linked_body, linked_hist = await profile.build(link_net, link_addr, refresh or refresh_link)
    feats = merge(F.extract(own_hist), F.extract(linked_hist))
    s = scoring.score(feats)
    reasons = list(s.reasons)
    if linked_body["history"]["truncated"]:
        reasons.append("HISTORY_TRUNCATED")
    general = [k for k in s.features if k not in MOONSHIFT_FEATURES]
    for k, v in s.features.items():
        v["from"] = network if k in MOONSHIFT_FEATURES else link_net
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
                "part": "Connected wallet" if link_net != "mainnet" else "Linked payment history",
                "network": link_net,
                "address": link_addr,
                "source": linked_body["source"],  # "quicknode" when configured
                "readOnly": True,
                "features": general,
                "history": linked_body["history"],
                "ownScore": {"score": linked_body["score"], "grade": linked_body["grade"], "confidence": linked_body["confidence"]},
                "ownership": link["ownership"],
            },
            *([await reference_line(reference)] if reference else []),
        ],
        "history": own_body["history"],
        "portfolio": None,
        "ownership": link["ownership"],
        "asOf": iso(own_hist.now),
    }


async def reference_line(link: dict[str, Any]) -> dict[str, Any]:
    """A mainnet history kept for context next to a connected wallet: its own score, no weight."""
    body, _ = await profile.build("mainnet", link["mainnetAddress"])
    return {
        "part": "Mainnet history",
        "role": "reference",
        "network": "mainnet",
        "address": link["mainnetAddress"],
        "source": body["source"],
        "readOnly": True,
        "features": [],
        "history": body["history"],
        "ownScore": {"score": body["score"], "grade": body["grade"], "confidence": body["confidence"]},
        "ownership": link["ownership"],
    }


# Weight of a connected wallet's history, by its confidence: a thin wallet nudges the borrower's
# score, a long history moves it. Changes seen after connecting count at least LIVE_WEIGHT, so a
# payment or an outflow always shows.
WALLET_WEIGHT = {"low": 0.2, "medium": 0.5, "high": 0.8}
LIVE_WEIGHT = 0.5


def blend(base: dict[str, Any], wallet: dict[str, Any], connect_score: int) -> dict[str, Any]:
    """base: the borrower's profile without the wallet. wallet: the profile with the wallet's history.
    score = base + w * (wallet at connect - base) + max(w, LIVE_WEIGHT) * (wallet now - wallet at connect)"""
    w = WALLET_WEIGHT.get(wallet["confidence"], 0.2)
    live = max(w, LIVE_WEIGHT)
    raw = base["score"] + w * (connect_score - base["score"]) + live * (wallet["score"] - connect_score)
    final = max(0, min(100, int(raw + 0.5)))
    out = dict(wallet)
    out.update(
        {
            "score": final,
            "grade": scoring.grade_for(final),
            "confidence": base["confidence"],
            "blend": {
                "baseScore": base["score"],
                "walletScore": wallet["score"],
                "walletConfidence": wallet["confidence"],
                "connectScore": connect_score,
                "weight": w,
                "liveWeight": live,
            },
        }
    )
    out["components"] = [
        {**c, "weight": w} if c.get("part") == "Connected wallet" else c for c in wallet["components"]
    ]
    return out
