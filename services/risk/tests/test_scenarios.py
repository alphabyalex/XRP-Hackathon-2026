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


def test_demo_steps_target_gpu_a_and_respect_keeper_rules(tmp_path):
    app = create_app(Settings(state_dir=tmp_path))
    client = TestClient(app)
    assert len(client.get("/scenarios?preset=demo").json()["steps"]) == 2
    first = client.post("/scenarios/run", json={"preset": "demo", "step": 1})
    assert first.status_code == 200
    assert first.json()["loans"][0]["state"] == "MARGIN_CALL"
    assert first.json()["loans"][1]["ltv"] == "0.550000"  # GPU-B is untouched.
    second = client.post("/scenarios/run", json={"preset": "demo", "step": 2})
    assert second.status_code == 200
    assert second.json()["loans"][0]["state"] == "LIQUIDATE"
    assert Decimal(second.json()["priceAfter"]) < Decimal(first.json()["priceAfter"])


def test_demo_is_gated_and_missing_loan_is_reported(tmp_path):
    client = TestClient(create_app(Settings(mock=False, state_dir=tmp_path)))
    assert client.post("/scenarios/run", json={"preset": "demo", "step": 1}).status_code == 403
    client = TestClient(create_app(Settings(state_dir=tmp_path)))
    assert client.post("/scenarios/run", json={"preset": "demo", "step": 1, "loanId": "missing"}).status_code == 409
