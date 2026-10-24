"""MOCK=1 responses. Built from the contract examples in contracts/credit so the shapes never drift."""

from __future__ import annotations

import copy
import json
from functools import cache
from typing import Any

from credit import config as C


@cache
def _example(name: str) -> dict[str, Any]:
    return json.loads((C.CONTRACTS_DIR / f"{name}.json").read_text())


def profile(network: str, address: str) -> dict[str, Any]:
    body = copy.deepcopy(_example("profile")["response"])
    body.update(address=address, network=network, readOnly=C.NETWORKS[network].read_only, simulated=True)
    return body


def explain(network: str, address: str) -> dict[str, Any]:
    body = copy.deepcopy(_example("explain")["response"])
    body.update(address=address, network=network, simulated=True)
    return body
