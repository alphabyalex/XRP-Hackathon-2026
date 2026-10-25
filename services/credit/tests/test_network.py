"""Live network status: ledger closes, server_info, the NETWORK_STATUS event and GET /network."""

from fastapi.testclient import TestClient

from credit import network
from credit.main import app


def test_ledger_close_and_server_info_build_one_status():
    s = network.NetworkStatus()
    s.on_server_info(
        "testnet",
        {"server_state": "full", "load_factor": 1, "validated_ledger": {"seq": 100, "hash": "AA", "base_fee_xrp": 0.00001, "reserve_base_xrp": 1}},
        "quicknode",
    )
    s.on_ledger("testnet", {"ledger_index": 101, "ledger_hash": "BB", "fee_base": 10, "reserve_base": 1000000, "txn_count": 7}, "quicknode")
    s.on_ledger("testnet", {"ledger_index": 99, "ledger_hash": "OLD"}, "quicknode")  # late message: ignored
    t = s.get("testnet")
    assert t["ledgerIndex"] == 101
    assert t["ledgerHash"] == "BB"
    assert t["feeXrp"] == "0.000010"
    assert t["reserveBaseXrp"] == "1"
    assert t["serverState"] == "full"
    assert t["txnCount"] == 7
    ev = network.status_event(t)
    assert ev["kind"] == "NETWORK_STATUS" and ev["ledgerIndex"] == 101 and ev["id"] == "net_testnet_101"
    assert ev["address"]  # the api requires one


def test_network_route_returns_the_snapshot(monkeypatch):
    s = network.NetworkStatus()
    s.on_ledger("testnet", {"ledger_index": 5, "fee_base": 10}, "quicknode")
    monkeypatch.setattr(network, "status", s)
    body = TestClient(app).get("/network").json()
    assert body["networks"][0]["ledgerIndex"] == 5
    assert "http" not in str(body)  # never an endpoint URL
