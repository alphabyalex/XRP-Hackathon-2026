"""MOCK=0 through the HTTP API, with the XRPL replaced by tests.fakes.FakeLedger."""

import pytest
from fastapi.testclient import TestClient

from credit import config as C
from credit import profile
from credit.db import Store
from credit.main import app
from credit.xrpl_client import XrplClient
from tests.builders import BORROWER, old_active_entries
from tests.fakes import FakeLedger

client = TestClient(app)
MISSING = "r3MngmkiUcdTYos1Q2LADyp6C8tpm8WLSH"


@pytest.fixture
def fake(monkeypatch, tmp_path):
    ledger = FakeLedger(page_size=100)
    ledger.accounts[BORROWER] = {"Account": BORROWER, "Balance": "1000000000"}
    ledger.txs[BORROWER] = sorted(old_active_entries(), key=lambda e: -e["tx"]["ledger_index"])
    ledger.lines[BORROWER] = [{"account": "rIssuer", "currency": "TDX", "balance": "10"}]
    db = Store(tmp_path / "live.db")
    monkeypatch.setattr(C, "MOCK", False)
    monkeypatch.setattr(C, "RETRY_BASE_SECONDS", 0)
    monkeypatch.setattr(profile, "XrplClient", lambda network: XrplClient(network, ledger.transport(), db))
    return ledger


def test_live_profile_has_contract_shape_and_real_numbers(fake):
    r = client.get(f"/profile/testnet/{BORROWER}")
    assert r.status_code == 200
    body = r.json()
    assert body["simulated"] is False
    assert body["source"] == "public"
    assert body["readOnly"] is False
    assert body["history"]["txFetched"] == 300
    assert body["history"]["pages"] == 3
    assert body["features"]["trustlines"]["value"] == 1
    assert 0 <= body["score"] <= 100
    assert body["grade"] in "ABCDE"


def test_repeat_call_served_from_cache(fake):
    client.get(f"/profile/testnet/{BORROWER}")
    n = len(fake.requests)
    client.get(f"/profile/testnet/{BORROWER}")
    assert len(fake.requests) == n


def test_missing_account_is_404(fake):
    r = client.get(f"/profile/testnet/{MISSING}")
    assert r.status_code == 404
    assert r.json()["error"]["code"] == "ACCOUNT_NOT_FOUND"


def test_mainnet_profiles_are_read_only(fake):
    fake.accounts[MISSING] = {"Account": MISSING, "Balance": "1"}
    assert client.get(f"/profile/mainnet/{MISSING}").json()["readOnly"] is True


def test_obligations_from_account_objects_and_offers(fake):
    fake.objects[BORROWER] = [
        {"LedgerEntryType": "Escrow"},
        {"LedgerEntryType": "Escrow"},
        {"LedgerEntryType": "Loan"},
        {"LedgerEntryType": "RippleState"},
    ]
    fake.offers[BORROWER] = [{"seq": 7}]
    owed = client.get(f"/profile/testnet/{BORROWER}").json()["history"]["obligations"]
    assert owed["escrows"] == 2
    assert owed["loans"] == 1
    assert owed["offers"] == 1
    assert owed["ownerCount"] == 4
    methods = {r["method"] for r in fake.requests}
    assert {"account_objects", "account_offers"} <= methods
