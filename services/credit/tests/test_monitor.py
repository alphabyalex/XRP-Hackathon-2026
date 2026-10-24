import gzip
import hashlib
import hmac
import json
import shutil
import subprocess
from datetime import timedelta

import httpx
import pytest
from fastapi.testclient import TestClient

from credit import config as C
from credit import monitor as M
from credit import streams
from credit.db import Store
from credit.events import EventBus
from credit.history import normalize
from credit.main import app
from tests.builders import BORROWER, NOW, POOL, iso, loan_entries
from tests.fakes import account_root, entry, ripple_time

PEER = "r3MngmkiUcdTYos1Q2LADyp6C8tpm8WLSH"
FILTER_JS = C.SERVICE_DIR / "quicknode" / "streams_filter.js"


def outflow(amount_xrp: int, before_xrp: int, h: str = "A" * 64):
    drops = amount_xrp * 1_000_000
    return normalize(
        entry(
            h,
            "Payment",
            BORROWER,
            iso(NOW),
            500,
            destination=PEER,
            amount=str(drops),
            nodes=[account_root(BORROWER, before_xrp * 1_000_000, (before_xrp - amount_xrp) * 1_000_000)],
        )
    )


def kinds(events):
    return [e["kind"] for e in events]


# ---- classify (pure) ----


def test_large_outflow_flagged_at_threshold():
    evs = M.classify("testnet", BORROWER, outflow(640, 1000), "streams", frozenset())
    assert kinds(evs) == ["LARGE_OUTFLOW"]
    assert evs[0]["detail"] == "Sent 640 XRP, 64% of the balance before the payment"
    assert evs[0]["amount"] == "640.000000"


def test_small_outflow_ignored():
    assert M.classify("testnet", BORROWER, outflow(100, 1000), "streams", frozenset()) == []


def test_failed_tx_ignored():
    t = outflow(900, 1000)
    t.result = "tecUNFUNDED_PAYMENT"
    assert M.classify("testnet", BORROWER, t, "streams", frozenset()) == []


def test_loan_lifecycle_events():
    due = NOW + timedelta(minutes=5)
    txs = [normalize(e) for e in loan_entries(1, due=due, repay_at=due, margin_call_at=due, liquidate_at=due)]
    evs = [e for t in txs for e in M.classify("testnet", BORROWER, t, "streams", frozenset({POOL}))]
    assert kinds(evs) == ["MS_LOAN_DISBURSE", "MS_REPAY", "MARGIN_CALL", "LIQUIDATION"]
    assert evs[0]["amount"] == "50" and evs[0]["currency"] == "TDX"
    assert "lending pool" in evs[3]["detail"]


def test_event_ids_are_stable():
    a = M.classify("testnet", BORROWER, outflow(640, 1000), "streams", frozenset())
    b = M.classify("testnet", BORROWER, outflow(640, 1000), "websocket", frozenset())
    assert a[0]["id"] == b[0]["id"]


# ---- Monitor (state, dedupe, overdue) ----


@pytest.fixture
def mon(tmp_path):
    posted = []

    async def poster(ev):
        posted.append(ev)

    m = M.Monitor(Store(tmp_path / "m.db"), EventBus(), poster)
    m.posted = posted
    return m


async def test_unwatched_address_produces_nothing(mon):
    assert mon.handle_tx("testnet", outflow(900, 1000), "streams") == []


async def test_duplicate_delivery_emits_once(mon):
    mon.add("testnet", BORROWER, [], NOW)
    assert len(mon.handle_tx("testnet", outflow(900, 1000), "streams")) == 1
    assert mon.handle_tx("testnet", outflow(900, 1000), "streams") == []
    assert kinds(list(e for _, e in mon.bus.recent)) == ["LARGE_OUTFLOW"]


async def test_escrow_on_ledger_starts_tracking_and_overdue_fires_once(mon):
    mon.add("testnet", BORROWER, [], NOW)
    due = NOW + timedelta(minutes=10)
    for e in loan_entries(1, due=due):
        mon.handle_tx("testnet", normalize(e), "streams")
    assert mon.watched()[0]["openLoans"] == 1
    assert mon.check_overdue(due - timedelta(seconds=1)) == []
    missed = mon.check_overdue(due + timedelta(seconds=1))
    assert kinds(missed) == ["MISSED_PAYMENT"]
    assert missed[0]["txHash"] == loan_entries(1, due=due)[0]["tx"]["hash"]
    assert mon.check_overdue(due + timedelta(minutes=5)) == []


async def test_repayment_cancels_missed_payment(mon):
    mon.add("testnet", BORROWER, [], NOW)
    due = NOW + timedelta(minutes=10)
    for e in loan_entries(1, due=due, repay_at=due - timedelta(minutes=1)):
        mon.handle_tx("testnet", normalize(e), "streams")
    assert mon.check_overdue(due + timedelta(hours=1)) == []


async def test_loans_passed_by_api_are_tracked(mon):
    mon.add("testnet", BORROWER, [{"loanId": "L1", "dueAt": iso(NOW), "principal": "50.000000"}], NOW)
    ev = mon.check_overdue(NOW + timedelta(minutes=1))[0]
    assert (ev["kind"], ev["amount"], ev["currency"]) == ("MISSED_PAYMENT", "50.000000", "TDX")


# ---- Streams receiver ----


def sign(token, nonce, ts, payload):
    return hmac.new(token.encode(), (nonce + ts).encode() + payload, hashlib.sha256).hexdigest()


def test_signature_verification():
    body = b'{"x":1}'
    good = sign("tok", "n1", "1700000000", body)
    assert streams.verify_signature("tok", "n1", "1700000000", body, good)
    assert not streams.verify_signature("tok", "n1", "1700000000", body + b" ", good)
    assert not streams.verify_signature("", "n1", "1700000000", body, good)


def filtered_payload(tx_entry, addresses):
    tx = {**tx_entry["tx"], "metaData": tx_entry["meta"]}
    return {
        "network": "xrpl-testnet",
        "matches": [{"ledgerIndex": 500, "closeTimeIso": iso(NOW), "addresses": addresses, "tx": tx}],
    }


@pytest.fixture
def api(monkeypatch, tmp_path):
    posted = []

    async def poster(ev):
        posted.append(ev)

    m = M.Monitor(Store(tmp_path / "api.db"), EventBus(), poster)
    monkeypatch.setattr(M, "_monitor", m)
    monkeypatch.setattr(C, "QUICKNODE_STREAMS_TOKEN", "stream-token")
    client = TestClient(app)
    client.posted = posted
    client.mon = m
    return client


def big_outflow_entry():
    return entry(
        "B" * 64,
        "Payment",
        BORROWER,
        iso(NOW),
        500,
        destination=PEER,
        amount="900000000",
        nodes=[account_root(BORROWER, 1_000_000_000, 100_000_000)],
    )


def post_signed(client, body: bytes, **headers):
    sig = sign("stream-token", "abc", "1700000000", body)
    h = {"X-QN-Nonce": "abc", "X-QN-Timestamp": "1700000000", "X-QN-Signature": sig, **headers}
    return client.post("/streams/xrpl", content=body, headers=h)


def test_streams_delivery_produces_event_and_api_post(api):
    api.post("/watch", json={"network": "testnet", "address": BORROWER})
    body = json.dumps(filtered_payload(big_outflow_entry(), [BORROWER])).encode()
    r = post_signed(api, body)
    assert r.json() == {"ok": True, "received": 1, "events": 1}
    assert api.posted[0]["kind"] == "LARGE_OUTFLOW"
    assert api.posted[0]["via"] == "streams"
    assert api.posted[0]["network"] == "testnet"


def test_streams_gzip_body(api):
    api.post("/watch", json={"network": "testnet", "address": BORROWER})
    raw = json.dumps(filtered_payload(big_outflow_entry(), [BORROWER])).encode()
    sig = sign("stream-token", "abc", "1700000000", raw)  # signed over the decompressed payload
    r = api.post(
        "/streams/xrpl",
        content=gzip.compress(raw),
        headers={
            "Content-Encoding": "gzip",
            "X-QN-Nonce": "abc",
            "X-QN-Timestamp": "1700000000",
            "X-QN-Signature": sig,
        },
    )
    assert r.json()["events"] == 1


def test_streams_bad_signature_rejected(api):
    r = api.post("/streams/xrpl", content=b"{}", headers={"X-QN-Signature": "00"})
    assert r.status_code == 401


def test_streams_unfiltered_ledger_payload(api):
    api.post("/watch", json={"network": "testnet", "address": BORROWER})
    e = big_outflow_entry()
    ledger = {
        "ledger_index": 500,
        "ledger": {
            "close_time_iso": iso(NOW),
            "transactions": [
                {**e["tx"], "metaData": e["meta"]},
                {
                    **entry("C" * 64, "Payment", PEER, iso(NOW), 500, destination=POOL, amount="1")["tx"],
                    "metaData": {},
                },
            ],
        },
    }
    r = post_signed(api, json.dumps({"data": [ledger], "metadata": {"network": "xrpl-testnet"}}).encode())
    assert r.json() == {"ok": True, "received": 2, "events": 1}


def test_streams_other_network_not_matched(api):
    api.post("/watch", json={"network": "testnet", "address": BORROWER})
    payload = filtered_payload(big_outflow_entry(), [BORROWER])
    payload["network"] = "xrpl-mainnet"
    assert post_signed(api, json.dumps(payload).encode()).json()["events"] == 0


def test_watch_list_and_unwatch(api):
    r = api.post(
        "/watch",
        json={
            "network": "testnet",
            "address": BORROWER,
            "loans": [{"loanId": "L9", "dueAt": "2099-01-01T00:00:00Z"}],
        },
    ).json()
    assert {k: r[k] for k in ("network", "address", "watching", "mode", "kvSynced")} == {
        "network": "testnet",
        "address": BORROWER,
        "watching": True,
        "mode": "off",
        "kvSynced": False,
    }
    assert r["feeds"][0] == {"network": "testnet", "address": BORROWER, "source": "public"}
    assert api.get("/watch").json()["watched"][0]["openLoans"] == 1
    api.delete(f"/watch/testnet/{BORROWER}")
    assert api.get("/watch").json()["watched"] == []


def test_simulated_event_is_labeled(api):
    ev = api.post(
        "/monitor/simulate", json={"network": "testnet", "address": BORROWER, "kind": "MISSED_PAYMENT"}
    ).json()
    assert ev["simulated"] is True and ev["via"] == "simulated" and ev["severity"] == "critical"
    assert api.posted[-1]["id"] == ev["id"]


# ---- Quicknode KV watchlist sync ----


async def test_kv_add_creates_list_when_missing(monkeypatch):
    monkeypatch.setattr(C, "QUICKNODE_API_KEY", "k")
    calls = []

    def handler(req: httpx.Request) -> httpx.Response:
        calls.append((req.method, req.url.path, json.loads(req.content), req.headers["x-api-key"]))
        return httpx.Response(404 if req.url.path.endswith("/items") else 201)

    assert await streams.kv_add(BORROWER, httpx.MockTransport(handler)) is True
    assert calls == [
        ("POST", "/kv/rest/v1/lists/moonshift-borrowers/items", {"item": BORROWER}, "k"),
        ("POST", "/kv/rest/v1/lists", {"key": "moonshift-borrowers", "items": [BORROWER]}, "k"),
    ]


async def test_kv_add_disabled_without_api_key():
    assert await streams.kv_add(BORROWER) is False


# ---- the JS filter itself, run in Node with a stubbed qnLib ----


@pytest.mark.skipif(shutil.which("node") is None, reason="node not installed")
def test_streams_filter_js_keeps_only_watched_borrowers():
    e = big_outflow_entry()
    other = entry("C" * 64, "Payment", PEER, iso(NOW), 500, destination=POOL, amount="1")
    stream = {
        "metadata": {"network": "xrpl-testnet"},
        "data": [
            {
                "ledger_index": "500",
                "ledger": {
                    "close_time_iso": iso(NOW),
                    "transactions": [{**e["tx"], "metaData": e["meta"]}, other["tx"], "HASHONLY"],
                },
            }
        ],
    }
    script = f"""
    globalThis.qnLib = {{ qnContainsListItems: async (list, items) =>
        items.map(a => list === 'moonshift-borrowers' && a === {json.dumps(BORROWER)}) }};
    const {{ main }} = require({json.dumps(str(FILTER_JS))});
    main({json.dumps(stream)}).then(r => console.log(JSON.stringify(r)));
    """
    out = json.loads(
        subprocess.run(["node", "-e", script], capture_output=True, text=True, check=True).stdout
    )
    assert out["network"] == "xrpl-testnet"
    assert len(out["matches"]) == 1
    m = out["matches"][0]
    assert (m["ledgerIndex"], m["addresses"], m["tx"]["hash"]) == (500, [BORROWER], "B" * 64)
    # The filter's output is exactly what the receiver parses.
    parsed = list(streams.iter_txs(out))
    assert parsed[0][0] == "testnet" and parsed[0][1].hash == "B" * 64 and parsed[0][2] == [BORROWER]


@pytest.mark.skipif(shutil.which("node") is None, reason="node not installed")
def test_streams_filter_js_returns_null_when_nothing_matches():
    stream = {"data": [{"ledger_index": 1, "ledger": {"transactions": []}}]}
    script = f"""
    globalThis.qnLib = {{ qnContainsListItems: async (l, items) => items.map(() => false) }};
    require({json.dumps(str(FILTER_JS))}).main({json.dumps(stream)})
      .then(r => console.log(JSON.stringify(r)));
    """
    assert (
        subprocess.run(["node", "-e", script], capture_output=True, text=True, check=True).stdout.strip()
        == "null"
    )


def test_ripple_time_helper_round_trip():
    assert ripple_time("2000-01-01T00:00:00Z") == 0
