import pytest

from credit import config as C
from credit.db import Store
from credit.xrpl_client import AccountNotFound, UpstreamError, XrplClient
from tests.fakes import FakeLedger, entry

ADDR = "rHu4dJcC3DALsgvprvekBt9dG3poU95Rzb"
OTHER = "r3MngmkiUcdTYos1Q2LADyp6C8tpm8WLSH"


@pytest.fixture(autouse=True)
def no_backoff(monkeypatch):
    monkeypatch.setattr(C, "RETRY_BASE_SECONDS", 0)


@pytest.fixture
def db(tmp_path):
    return Store(tmp_path / "t.db")


def ledger_with(n: int) -> FakeLedger:
    fake = FakeLedger(page_size=2)
    fake.accounts[ADDR] = {"Account": ADDR, "Balance": "50000000"}
    fake.txs[ADDR] = [
        entry(
            f"{i:064X}", "Payment", OTHER, "2026-01-01T00:00:00Z", 100 - i, destination=ADDR, amount="1000000"
        )
        for i in range(n)
    ]
    return fake


async def test_account_tx_follows_marker_until_done(db):
    fake = ledger_with(5)
    page = await XrplClient("testnet", fake.transport(), db).account_tx(ADDR)
    assert len(page.transactions) == 5
    assert page.pages == 3
    assert page.truncated is False


async def test_account_tx_stops_at_max_pages(db, monkeypatch):
    monkeypatch.setattr(C, "ACCOUNT_TX_MAX_PAGES", 2)
    page = await XrplClient("testnet", ledger_with(9).transport(), db).account_tx(ADDR)
    assert len(page.transactions) == 4
    assert page.truncated is True


async def test_cache_makes_repeat_calls_free(db):
    fake = ledger_with(3)
    await XrplClient("testnet", fake.transport(), db).account_tx(ADDR)
    first = len(fake.requests)
    again = XrplClient("testnet", fake.transport(), db)
    await again.account_tx(ADDR)
    await again.account_info(ADDR)
    await again.account_info(ADDR)
    assert len(fake.requests) == first + 1  # only the first account_info went upstream
    assert again.calls == 1


async def test_refresh_bypasses_cache(db):
    fake = ledger_with(1)
    c = XrplClient("testnet", fake.transport(), db)
    await c.account_info(ADDR)
    await c.account_info(ADDR, refresh=True)
    assert len(fake.requests) == 2


async def test_backs_off_and_retries_on_rate_limit(db):
    fake = ledger_with(1)
    fake.rate_limit_first = 2
    info = await XrplClient("testnet", fake.transport(), db).account_info(ADDR)
    assert info["account_data"]["Account"] == ADDR
    assert len(fake.requests) == 3


async def test_gives_up_after_retries(db):
    fake = ledger_with(1)
    fake.rate_limit_first = 99
    with pytest.raises(UpstreamError) as e:
        await XrplClient("testnet", fake.transport(), db).account_info(ADDR)
    assert "http" not in str(e.value).lower().replace("http 429", "")  # no URL leaks into errors


async def test_unknown_account(db):
    with pytest.raises(AccountNotFound):
        await XrplClient("testnet", FakeLedger().transport(), db).account_info(ADDR)


async def test_only_read_methods_allowed(db):
    with pytest.raises(ValueError):
        await XrplClient("mainnet", FakeLedger().transport(), db).rpc("submit", {"tx_blob": "00"})


def test_source_is_public_without_quicknode_env(monkeypatch):
    monkeypatch.delenv("QUICKNODE_XRPL_MAINNET_URL", raising=False)
    assert C.endpoint("mainnet") == ("https://xrplcluster.com/", "public")


def test_source_is_quicknode_when_env_set(monkeypatch):
    monkeypatch.setenv("QUICKNODE_XRPL_TESTNET_URL", "https://example.xrp-testnet.quiknode.pro/tok/")
    assert C.endpoint("testnet")[1] == "quicknode"
    assert C.ws_endpoint("testnet")[0].startswith("wss://example.xrp-testnet")
    assert C.quicknode_configured() == {"mainnet": False, "testnet": True, "devnet": False}


def test_devnet_is_public_unless_a_quicknode_devnet_url_is_set(monkeypatch):
    assert C.endpoint("devnet") == ("https://s.devnet.rippletest.net:51234/", "public")
    monkeypatch.setenv("QUICKNODE_XRPL_DEVNET_URL", "https://example.xrp-devnet.quiknode.pro/tok/")
    assert C.endpoint("devnet")[1] == "quicknode"
