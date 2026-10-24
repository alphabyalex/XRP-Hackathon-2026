import json
from decimal import Decimal
import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.agent import guardrails, fallback, bedrock
from app import config as C

client = TestClient(app)


def test_allowed_numbers_extraction():
    data = {
        "score": 75,
        "ltv": "0.450000",
        "principal": 5000,
        "rate_bps": 850,
        "items": ["a", "b", "c"],
    }
    allowed = guardrails.allowed_numbers(data)
    assert Decimal("75") in allowed
    assert Decimal("0.45") in allowed
    assert Decimal("45") in allowed  # 0.45 * 100 percentage restatement
    assert Decimal("5000") in allowed
    assert Decimal("850") in allowed
    assert Decimal("8.5") in allowed  # rate_bps / 100
    assert Decimal("3") in allowed  # len(items)


def test_number_guard_accepts_valid_text():
    allowed = {Decimal("75"), Decimal("0.45"), Decimal("45"), Decimal("5000")}
    valid_text = "Borrower has a score of 75 and requested 5000 TDX at 45% LTV."
    assert not guardrails.has_unverified_numbers(valid_text, allowed)


def test_number_guard_rejects_hallucinated_numbers():
    allowed = {Decimal("75"), Decimal("0.45"), Decimal("5000")}
    # 99% and 9999 are hallucinated
    invalid_text = "Borrower has score 75 and requested 5000 TDX with a 99% approval rating and $9999 bonus."
    assert guardrails.has_unverified_numbers(invalid_text, allowed)
    unknown = guardrails.unknown_numbers(invalid_text, allowed)
    assert "99" in unknown
    assert "9999" in unknown


def test_no_em_dashes_in_parsed_text():
    raw_with_em_dash = json.dumps({"memo": "Loan approved \u2014 verified by on-chain credit."})
    parsed = guardrails.parse_single_text(raw_with_em_dash, ("memo",))
    assert "\u2014" not in parsed
    assert "—" not in parsed


from pathlib import Path

CONTRACTS_DIR = Path(__file__).resolve().parent.parent.parent.parent / "contracts" / "pricing"


def test_credit_memo_endpoint_mock_and_fallback():
    with open(CONTRACTS_DIR / "credit_memo.json") as f:
        contract = json.load(f)

    resp = client.post(
        "/agent/credit-memo",
        json=contract["request"],
        headers={"X-MS-Internal-Key": C.INTERNAL_API_KEY} if C.INTERNAL_API_KEY else {},
    )
    assert resp.status_code == 200
    data = resp.json()
    assert "memo" in data
    assert isinstance(data["memo"], str)
    assert len(data["memo"]) > 20
    assert "—" not in data["memo"]
    assert data["modelId"] == C.BEDROCK_MODEL_ID
    assert isinstance(data["fellBack"], bool)
    assert isinstance(data["latencyMs"], int)


def test_risk_alert_endpoint():
    with open(CONTRACTS_DIR / "risk_alert.json") as f:
        contract = json.load(f)

    resp = client.post(
        "/agent/risk-alert",
        json=contract["request"],
        headers={"X-MS-Internal-Key": C.INTERNAL_API_KEY} if C.INTERNAL_API_KEY else {},
    )
    assert resp.status_code == 200
    data = resp.json()
    assert "alert" in data
    assert isinstance(data["alert"], str)
    assert "margin call" in data["alert"].lower()
    assert "—" not in data["alert"]
    assert data["modelId"] == C.BEDROCK_MODEL_ID
    assert isinstance(data["fellBack"], bool)
    assert isinstance(data["latencyMs"], int)


def test_credit_memo_number_guard_triggers_fallback_on_bad_bedrock_output(monkeypatch):
    profile = {"score": 80, "grade": "A"}
    quote = {"principal": "100.000000", "apr": "0.080000", "ltv": "0.300000"}
    req = {"borrower": "rTestBorrower", "gpuId": "gpu-a"}

    # Mock _converse_custom to return invented numbers (99999 and 42.7)
    monkeypatch.setattr(
        bedrock,
        "_converse_custom",
        lambda sys_prompt, user_msg: json.dumps(
            {"memo": "Borrower approved for 99999 TDX with invented 42.7% rate."}
        ),
    )
    monkeypatch.setattr(C, "MOCK", False)

    res = bedrock.generate_credit_memo(profile, quote, req)
    assert res.fell_back is True
    # The returned memo must be the deterministic fallback, not the invented text
    assert "99999" not in res.memo
    assert "42.7" not in res.memo
    assert "rTestBorrower" in res.memo
