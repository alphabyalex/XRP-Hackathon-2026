import json

import pytest
from fastapi.testclient import TestClient

from credit import config as C
from credit.events import EventBus, format_sse
from credit.main import app

client = TestClient(app)
GENESIS = "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh"
ALICE = "rHu4dJcC3DALsgvprvekBt9dG3poU95Rzb"


def contract(name: str) -> dict:
    return json.loads((C.CONTRACTS_DIR / f"{name}.json").read_text())


def test_health_reports_booleans_only():
    body = client.get("/health").json()
    assert body["ok"] is True
    assert body["quicknode"] == {"mainnet": False, "testnet": False, "devnet": False}


def test_mock_profile_matches_contract_shape():
    expected = contract("profile")["response"]
    body = client.get(f"/profile/mainnet/{GENESIS}").json()
    assert set(body) == set(expected)
    assert set(body["features"]) == set(expected["features"])
    assert body["simulated"] is True
    assert body["readOnly"] is True


def test_mock_profile_uses_request_network_and_address():
    body = client.get(f"/profile/testnet/{ALICE}").json()
    assert body["address"] == ALICE
    assert body["network"] == "testnet"
    assert body["readOnly"] is False


@pytest.mark.parametrize(
    ("path", "code"),
    [
        ("/profile/moonnet/" + GENESIS, "INVALID_NETWORK"),
        ("/profile/mainnet/not-an-address", "INVALID_ADDRESS"),
    ],
)
def test_bad_targets_rejected(path, code):
    r = client.get(path)
    assert r.status_code == 422
    assert r.json()["error"]["code"] == code


def test_batch_collects_errors_without_failing():
    req = contract("profiles_batch")["request"]
    body = client.post("/profiles", json=req).json()
    assert len(body["profiles"]) == 2
    assert body["errors"] == contract("profiles_batch")["response"]["errors"]


def test_internal_key_enforced_when_set(monkeypatch):
    monkeypatch.setattr(C, "INTERNAL_API_KEY", "secret")
    assert client.get(f"/profile/mainnet/{GENESIS}").status_code == 401
    ok = client.get(f"/profile/mainnet/{GENESIS}", headers={"X-MS-Internal-Key": "secret"})
    assert ok.status_code == 200


def test_sse_format():
    assert format_sse("profile", {"a": 1}) == 'event: profile\ndata: {"a":1}\n\n'


async def test_bus_delivers_to_subscriber():
    bus = EventBus()
    gen = bus.stream(ping_seconds=5)
    assert await anext(gen) == ": connected\n\n"
    bus.publish("credit_event", {"kind": "MS_REPAY"})
    assert await anext(gen) == 'event: credit_event\ndata: {"kind":"MS_REPAY"}\n\n'
    await gen.aclose()
