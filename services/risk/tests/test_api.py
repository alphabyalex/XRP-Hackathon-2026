import json
from pathlib import Path
import secrets

from fastapi.testclient import TestClient

from app.config import Settings
from app.main import create_app


def test_health_reports_safe_defaults() -> None:
    client = TestClient(create_app(Settings()))

    response = client.get("/health")

    assert response.status_code == 200
    assert response.json() == {"ok": True, "mock": True, "keeperDryRun": True}


def test_configured_internal_key_protects_quote_route() -> None:
    client = TestClient(create_app(Settings(internal_api_key=secrets.token_urlsafe(32))))
    contract = Path(__file__).resolve().parents[3] / "contracts" / "risk" / "quote.json"
    payload = json.loads(contract.read_text())["request"]

    response = client.post("/quote", json=payload)

    assert response.status_code == 401


def test_quote_response_matches_contract_shape() -> None:
    client = TestClient(create_app(Settings()))
    contract = Path(__file__).resolve().parents[3] / "contracts" / "risk" / "quote.json"
    example = json.loads(contract.read_text())

    response = client.post("/quote", json=example["request"])

    assert response.status_code == 200
    assert response.json() == example["response"]


def test_loans_health_reports_mock_loans(tmp_path) -> None:
    with TestClient(create_app(Settings(state_dir=tmp_path))) as client:
        response = client.get("/loans/health")

    assert response.status_code == 200
    assert response.json()["simulated"] is True
    assert len(response.json()["loans"]) == 3


def test_internal_health_route_requires_configured_key(tmp_path) -> None:
    key = secrets.token_urlsafe(32)
    client = TestClient(create_app(Settings(internal_api_key=key, state_dir=tmp_path)))

    assert client.get("/loans/health").status_code == 401


def test_live_keeper_reports_missing_api_without_exposing_credentials(tmp_path) -> None:
    client = TestClient(create_app(Settings(mock=False, state_dir=tmp_path)))

    response = client.get("/loans/health")

    assert response.status_code == 503
    assert response.json()["error"]["code"] == "UPSTREAM_UNAVAILABLE"
    assert response.json()["error"]["message"] == "API_URL_NOT_CONFIGURED"

