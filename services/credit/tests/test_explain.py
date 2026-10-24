import json
from datetime import timedelta

from fastapi.testclient import TestClient

from credit import config as C
from credit import explain, profile
from credit.main import app
from tests.builders import BORROWER, NOW, history, loan_entries, old_active_entries


def contract(name):
    return json.loads((C.CONTRACTS_DIR / f"{name}.json").read_text())


def live_profile(entries):
    meta = {
        "txFetched": len(entries),
        "pages": 1,
        "truncated": False,
        "firstTxAt": None,
        "lastTxAt": None,
        "ledgerIndex": 1,
    }
    return profile.assemble("testnet", BORROWER, "quicknode", history(entries), meta)


def test_factors_split_and_ranked():
    due = NOW - timedelta(days=2)
    p = live_profile(old_active_entries() + loan_entries(1, due=due, liquidate_at=due))
    out = explain.factors(p)
    assert set(out) == set(contract("explain")["response"])
    assert len(out["positive"]) == 3
    assert out["negative"][0]["feature"] == "msLiquidations"
    assert out["negative"][0]["points"] == -20
    assert out["negative"][0]["txHashes"]
    pts = [f["points"] for f in out["positive"]]
    assert pts == sorted(pts, reverse=True)
    assert all(f["points"] > 0 for f in out["positive"])


def test_explain_matches_profile_numbers():
    p = live_profile(old_active_entries())
    out = explain.factors(p)
    for f in out["positive"] + out["negative"]:
        assert p["features"][f["feature"]]["points"] == f["points"]


def test_texts_are_readable():
    assert explain._text("largestOutflowRatio", 0.58) == (
        "Largest single payment sent was 58% of the balance before it"
    )
    assert explain._text("paymentVolumeInXrp", "8420.500000") == "Received 8420.5 XRP in payments"


def test_mock_explain_endpoint_matches_contract():
    body = TestClient(app).get(f"/explain/testnet/{BORROWER}").json()
    expected = contract("explain")["response"]
    assert set(body) == set(expected)
    assert body["address"] == BORROWER and body["simulated"] is True
