import json

import httpx
import pytest

from credit import config as C
from credit import mock as credit_mock
from credit import portfolio


@pytest.fixture(autouse=True)
def fresh(monkeypatch):
    portfolio._cache.clear()
    monkeypatch.setattr(C, "MOCK", False)


def risk(handler):
    return httpx.MockTransport(handler)


async def test_reads_risk_book_stats():
    seen = []

    def handler(req):
        seen.append(str(req.url))
        return httpx.Response(200, json={"grade": "B", "loans": 180, "defaults": 4, "defaultRatePct": "2.2"})

    out = await portfolio.context("B", risk(handler))
    assert seen == ["http://risk.test/book/stats?grade=B"]
    assert out == {
        "grade": "B",
        "defaultRatePct": "2.2",
        "loans": 180,
        "text": "borrowers in this grade defaulted 2.2% (simulated)",
        "simulated": True,
        "source": "risk",
    }


async def test_computes_rate_from_defaults():
    out = await portfolio.context("C", risk(lambda r: httpx.Response(200, json={"loans": 50, "defaults": 3})))
    assert out["defaultRatePct"] == "6.0" and out["source"] == "risk"


async def test_falls_back_to_mock_when_risk_is_down():
    def down(req):
        raise httpx.ConnectError("refused")

    out = await portfolio.context("D", risk(down))
    assert out["source"] == "mock"
    assert out["text"] == "borrowers in this grade defaulted 12.5% (simulated)"


async def test_mock_mode_never_calls_risk(monkeypatch):
    monkeypatch.setattr(C, "MOCK", True)

    def boom(req):
        raise AssertionError("risk called in MOCK mode")

    assert (await portfolio.context("A", risk(boom)))["source"] == "mock"


def test_contract_example_matches_mock_table():
    example = json.loads((C.CONTRACTS_DIR / "profile.json").read_text())["response"]["portfolio"]
    assert example == portfolio.mock(example["grade"])
    assert credit_mock.profile("testnet", "rHu4dJcC3DALsgvprvekBt9dG3poU95Rzb")["portfolio"] == example
