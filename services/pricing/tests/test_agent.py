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
    monkeypatch.setattr(C, "BEDROCK_ENABLED", True)

    res = bedrock.generate_credit_memo(profile, quote, req)
    assert res.fell_back is True
    # The returned memo must be the deterministic fallback, not the invented text
    assert "99999" not in res.memo
    assert "42.7" not in res.memo
    # The plain memo uses formatted values and leaves the address out.
    assert "100.00 USDC" in res.memo and "8.00% APR" in res.memo and "30.00% LTV" in res.memo
    assert "rTestBorrower" not in res.memo


def test_formatted_memo_numbers_pass_the_guard():
    """A memo written from the formatted inputs (200.00 USDC, 34.08% APR, 1.18x, 14 days) is accepted."""
    from app.agent.memo_format import present

    profile = {"score": 66, "grade": "B", "features": {"paymentVolumeInXrp": {"value": "1234.500000"}}}
    quote = {"apr": "0.340800", "ltv": "0.400000", "maxLtv": "0.470675", "coverageRatio": "1.176687", "pd": "0.06"}
    req = {"principal": "200.000000", "collateralShares": "100.000000", "gpuId": "gpu-a", "termSeconds": 1209600, "currency": "USDC"}
    p = present(profile, quote, req)
    assert p["loan"] == {"principal": "200.00 USDC", "collateral": "100 GPU-A shares", "term": "14 days"}
    assert p["quote"]["apr"] == "34.08%" and p["quote"]["maxLtv"] == "47.07%" and p["quote"]["dividendCoverage"] == "1.18x"
    assert p["borrower"]["factors"]["paymentVolumeInXrp"] == "1,234.50 XRP"
    allowed = guardrails.allowed_numbers({"credit_profile": profile, "quote": quote, "loan_request": req}) | guardrails.allowed_numbers(p)
    memo = (
        "The borrower (grade B, score 66) asks for 200.00 USDC at 34.08% APR for 14 days against 100 GPU-A shares. "
        "The loan opens at 40.00% LTV against a 47.07% maximum, with 1.18x dividend coverage and 1,234.50 XRP received."
    )
    assert guardrails.unknown_numbers(memo, allowed) == []


def test_credit_memo_scrubs_one_bad_sentence_instead_of_falling_back(monkeypatch):
    profile = {"score": 80, "grade": "A"}
    quote = {"principal": "100.000000", "apr": "0.080000", "ltv": "0.300000"}
    req = {"borrower": "rTestBorrower", "gpuId": "gpu-a"}
    text = (
        "Borrower holds grade A credit with a score of 80. "
        "The loan carries an APR of 8% at an LTV of 30%. "
        "The term is 13.8 days."
    )
    monkeypatch.setattr(bedrock, "_converse_custom", lambda s, u: json.dumps({"memo": text}))
    monkeypatch.setattr(C, "MOCK", False)
    monkeypatch.setattr(C, "BEDROCK_ENABLED", True)
    res = bedrock.generate_credit_memo(profile, quote, req)
    assert res.fell_back is False and res.outcome == "ok_scrubbed"
    assert "13.8" not in res.memo and "score of 80" in res.memo


def test_credit_memo_retries_once_when_nothing_survives(monkeypatch):
    profile = {"score": 80, "grade": "A"}
    quote = {"principal": "100.000000", "apr": "0.080000", "ltv": "0.300000"}
    req = {"borrower": "rTestBorrower", "gpuId": "gpu-a"}
    calls = []

    def fake(sys_prompt, user_msg):
        calls.append(user_msg)
        if len(calls) == 1:
            return json.dumps({"memo": "Approved for 99999 TDX."})
        return json.dumps({"memo": "Borrower holds grade A credit with a score of 80. The APR is 8% at an LTV of 30%."})

    monkeypatch.setattr(bedrock, "_converse_custom", fake)
    monkeypatch.setattr(C, "MOCK", False)
    monkeypatch.setattr(C, "BEDROCK_ENABLED", True)
    res = bedrock.generate_credit_memo(profile, quote, req)
    assert len(calls) == 2 and "Use only numbers" in calls[1]
    assert res.fell_back is False and res.outcome == "ok_retry"


def test_bedrock_is_opt_in_for_all_prose_routes(monkeypatch):
    monkeypatch.setattr(C, "MOCK", False)
    monkeypatch.setattr(C, "BEDROCK_ENABLED", False)
    def forbidden(*args):
        raise AssertionError("Bedrock must not be called without explicit opt-in")
    monkeypatch.setattr(bedrock, "_converse", forbidden)
    monkeypatch.setattr(bedrock, "_converse_custom", forbidden)
    assert bedrock.explain("nav", {}, []).source == "fallback"
    assert bedrock.generate_credit_memo({"score": 80}, {"apr": "0.08"}, {}).fell_back
    assert bedrock.generate_risk_alert({"type": "MARGIN_CALL"}).fell_back
