import json
from pathlib import Path
from decimal import Decimal
from unittest.mock import AsyncMock

import pytest
from fastapi.testclient import TestClient

from app.config import Settings
from app.data import RiskDataClient, MOCK_LOANS
from app.main import create_app
from app.models import OpenLoan


PARAMS = {"round": 1, "assets": "10000", "lentOut": "150", "weightedApr": "0.086667"}


def test_contract_and_target_exceeds_sparse_realized_yield(tmp_path):
    client = TestClient(create_app(Settings(state_dir=tmp_path)))
    result = client.get("/vault/round-apy", params=PARAMS)
    assert result.status_code == 200
    contract = Path(__file__).resolve().parents[3] / "contracts/risk/round_apy.json"
    assert result.json() == json.loads(contract.read_text())["response"]
    assert result.json()["realizedApy"] == "0.001300"
    assert Decimal(result.json()["targetApy"]) > Decimal(result.json()["realizedApy"])


def test_loss_is_scaled_to_target_exposure_and_annualized(tmp_path):
    settings = Settings(state_dir=tmp_path)
    data = RiskDataClient(settings)
    loan = OpenLoan.model_validate(MOCK_LOANS[0]).model_copy(update={
        "outstanding_balance": Decimal(100), "pd": Decimal("0.1"),
    })
    data.list_open_loans = AsyncMock(return_value=[loan])
    data.current_price = AsyncMock(return_value=Decimal(1))
    client = TestClient(create_app(settings, data_client=data))
    result = client.get("/vault/round-apy", params=PARAMS).json()
    assert result["bookExpectedLoss"] == "1.000000"
    assert result["expectedLoss"] == "80.000000"
    expected = Decimal("0.086667") * Decimal("0.8") - Decimal("0.008") * 365 / 14
    assert abs(Decimal(result["targetApy"]) - expected) < Decimal("0.000001")
    # Negative net targets remain visible instead of hiding losses at zero.
    assert Decimal(result["targetApy"]) < 0


def test_empty_book_and_zero_lending(tmp_path):
    settings = Settings(state_dir=tmp_path)
    data = RiskDataClient(settings)
    data.list_open_loans = AsyncMock(return_value=[])
    client = TestClient(create_app(settings, data_client=data))
    result = client.get("/vault/round-apy", params={**PARAMS, "lentOut": 0}).json()
    assert result["realizedApy"] == "0.000000"
    assert result["expectedLoss"] == "0.000000"
    assert result["lossBasis"] == "empty-book"


@pytest.mark.parametrize("changes", [{"assets": "0"}, {"assets": "NaN"}, {"lentOut": "-1"},
    {"lentOut": "10001"}, {"weightedApr": "Infinity"}, {"roundSeconds": "0"}])
def test_invalid_inputs(changes, tmp_path):
    client = TestClient(create_app(Settings(state_dir=tmp_path)))
    assert client.get("/vault/round-apy", params={**PARAMS, **changes}).status_code == 422


def test_internal_auth(tmp_path):
    import secrets
    client = TestClient(create_app(Settings(state_dir=tmp_path, internal_api_key=secrets.token_urlsafe(32))))
    assert client.get("/vault/round-apy", params=PARAMS).status_code == 401
