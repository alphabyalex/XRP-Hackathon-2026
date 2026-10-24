import asyncio
from datetime import UTC, datetime, timedelta
from decimal import Decimal

from app.config import Settings
from app.events import EventLog
from app.keeper import Keeper
from app.models import OpenLoan


class FakeData:
    def __init__(self, loan: OpenLoan, price: Decimal = Decimal("1.000000")) -> None:
        self.loan = loan
        self.price = price
        self.actions: list[tuple[str, dict[str, object]]] = []

    async def list_open_loans(self) -> list[OpenLoan]:
        return [self.loan]

    async def current_price(self, _: str) -> Decimal:
        return self.price

    async def submit_action(self, path: str, body: dict[str, object]) -> None:
        self.actions.append((path, body))


def loan(balance: str, *, margin: str = "0.700000", liquidation: str = "0.900000") -> OpenLoan:
    return OpenLoan.model_validate(
        {
            "loanId": "loan-1",
            "borrower": "ALICE",
            "gpuId": "gpu-a",
            "collateralShares": "100.000000",
            "outstandingBalance": balance,
            "marginCallLtv": margin,
            "liquidationLtv": liquidation,
            "apr": "0.080000",
            "status": "open",
            "simulated": True,
        }
    )


def test_margin_call_is_recorded_in_dry_run_without_api_action(tmp_path) -> None:
    settings = Settings(mock=False, keeper_dry_run=True, state_dir=tmp_path)
    data = FakeData(loan("75.000000"))
    events = EventLog(tmp_path)
    keeper = Keeper(settings, data, events)

    result = asyncio.run(keeper.check_once())

    assert result["loans"][0]["state"] == "MARGIN_CALL"
    assert data.actions == []
    assert any(item["type"] == "margin_call" and item["dryRun"] for item in events.history())


def test_cure_expiry_liquidates_once(tmp_path) -> None:
    settings = Settings(mock=False, keeper_dry_run=True, cure_seconds=120, state_dir=tmp_path)
    data = FakeData(loan("91.000000"))
    events = EventLog(tmp_path)
    keeper = Keeper(settings, data, events)
    keeper._state["loan-1"] = {
        "marginCallAt": (datetime.now(UTC) - timedelta(seconds=180)).isoformat(),
        "marginCallRequested": True,
    }

    first = asyncio.run(keeper.check_once())
    second = asyncio.run(keeper.check_once())

    assert first["loans"][0]["state"] == "LIQUIDATE"
    assert second["loans"][0]["state"] == "LIQUIDATE"
    assert sum(item["type"] == "liquidation" for item in events.history()) == 1
    assert data.actions == []


def test_live_action_retries_until_api_accepts_then_stays_idempotent(tmp_path) -> None:
    settings = Settings(mock=False, keeper_dry_run=False, state_dir=tmp_path)
    data = FakeData(loan("75.000000"))
    keeper = Keeper(settings, data, EventLog(tmp_path))

    asyncio.run(keeper.check_once())
    asyncio.run(keeper.check_once())

    assert len(data.actions) == 1
    assert data.actions[0][0] == "/internal/loans/loan-1/margin-call"
    first_key = data.actions[0][1]["idempotencyKey"]
    assert str(first_key).startswith("risk-margin-call-loan-1-")

    data.loan = loan("60.000000")
    asyncio.run(keeper.check_once())
    data.loan = loan("75.000000")
    asyncio.run(keeper.check_once())

    assert len(data.actions) == 2
    assert data.actions[1][1]["idempotencyKey"] != first_key


def test_far_above_liquidation_threshold_triggers_immediately(tmp_path) -> None:
    keeper = Keeper(
        Settings(mock=False, keeper_dry_run=True, state_dir=tmp_path),
        FakeData(loan("120.000000")),
        EventLog(tmp_path),
    )

    result = asyncio.run(keeper.check_once())

    assert result["loans"][0]["state"] == "LIQUIDATE"


def test_event_log_persists_and_bounds_history(tmp_path) -> None:
    events = EventLog(tmp_path, capacity=2)
    events.publish("one", value=1)
    events.publish("two", value=2)
    events.publish("three", value=3)

    restored = EventLog(tmp_path, capacity=2)

    assert [event["type"] for event in restored.history()] == ["two", "three"]
    async def read_one_event() -> str:
        stream = restored.stream()
        try:
            return await stream.__anext__()
        finally:
            await stream.aclose()

    first_sse = asyncio.run(read_one_event())
    assert "event: risk" in first_sse
    assert '"type":"two"' in first_sse
