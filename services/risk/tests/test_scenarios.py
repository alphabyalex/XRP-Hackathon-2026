import json
from decimal import Decimal
from pathlib import Path

from fastapi.testclient import TestClient

from app.config import Settings
from app.main import create_app


def scenario_payload() -> dict[str, object]:
    contract = Path(__file__).resolve().parents[3] / "contracts" / "risk" / "scenarios_run.json"
    return json.loads(contract.read_text())["request"]


def test_stress_is_blocked_without_mock_or_demo_flag(tmp_path) -> None:
    client = TestClient(
        create_app(Settings(mock=False, demo_shock_enabled=False, state_dir=tmp_path))
    )

    response = client.post("/scenarios/run", json=scenario_payload())

    assert response.status_code == 403


def test_mock_stress_shocks_keeper_and_labels_every_loan(tmp_path) -> None:
    app = create_app(Settings(state_dir=tmp_path))
    with TestClient(app) as client:
        response = client.post("/scenarios/run", json=scenario_payload())
        health = client.get("/loans/health").json()

    assert response.status_code == 200
    result = response.json()
    expected = json.loads(
        Path(__file__).resolve().parents[3].joinpath("contracts", "risk", "scenarios_run.json").read_text()
    )["response"]
    assert result == expected
    assert result["simulated"] is True
    assert all(row["simulated"] is True for row in result["loans"])
    assert result["marginCalls"] >= 1
    assert all(Decimal(row["ltv"]) > Decimal("0.500000") for row in result["loans"])
    assert health["simulated"] is True
    assert any(event["type"] == "scenario_run" for event in app.state.events.history())
