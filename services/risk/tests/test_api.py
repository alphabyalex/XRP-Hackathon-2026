from fastapi.testclient import TestClient

from app.config import Settings
from app.main import create_app


def test_health_reports_safe_defaults() -> None:
    client = TestClient(create_app(Settings()))

    response = client.get("/health")

    assert response.status_code == 200
    assert response.json() == {"ok": True, "mock": True, "keeperDryRun": True}


def test_configured_internal_key_protects_quote_route() -> None:
    client = TestClient(create_app(Settings(internal_api_key="test-only-key")))

    response = client.post("/quote")

    assert response.status_code == 401

