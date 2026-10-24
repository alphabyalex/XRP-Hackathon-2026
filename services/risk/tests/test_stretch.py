import json
from pathlib import Path

from fastapi.testclient import TestClient

from app.config import Settings
from app.main import create_app


def test_rate_curve_matches_contract_and_increases_with_risk() -> None:
    contract = Path(__file__).resolve().parents[3] / "contracts" / "risk" / "rates_curve.json"
    expected = json.loads(contract.read_text())["response"]
    client = TestClient(create_app(Settings()))

    response = client.get("/rates/curve")

    assert response.status_code == 200
    assert response.json() == expected
    grades = response.json()["grades"]
    assert grades[0]["points"][-1]["apr"] > grades[0]["points"][0]["apr"]
    assert grades[0]["points"][0]["apr"] < grades[-1]["points"][0]["apr"]


def test_vault_health_matches_contract_and_is_labeled_simulated(tmp_path) -> None:
    contract = Path(__file__).resolve().parents[3] / "contracts" / "risk" / "vault_health.json"
    expected = json.loads(contract.read_text())["response"]
    client = TestClient(create_app(Settings(state_dir=tmp_path)))

    response = client.get("/vault/health")

    assert response.status_code == 200
    assert response.json() == expected
    assert response.json()["simulated"] is True
