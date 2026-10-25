import json

import pytest
from pydantic import ValidationError

from app.agent import task_estimate as T


@pytest.fixture(autouse=True)
def enable_injected_bedrock(monkeypatch):
    # Tests inject _converse below. No test performs a paid AWS request.
    monkeypatch.setenv("BEDROCK_ENABLED", "1")


def test_bedrock_is_disabled_without_explicit_opt_in(monkeypatch):
    monkeypatch.delenv("BEDROCK_ENABLED", raising=False)
    monkeypatch.setattr(T.C, "MOCK", False)
    monkeypatch.setattr(T, "_has_local_credentials", lambda: True)
    monkeypatch.setattr(T, "_converse", lambda _: pytest.fail("Bedrock is disabled"))
    assert T.estimate_task(T.TaskEstimateRequest(description="Summarize"))["source"] == "fallback"


def test_without_credentials_never_calls_bedrock(monkeypatch):
    monkeypatch.setattr(T.C, "MOCK", False)
    monkeypatch.setattr(T, "_has_local_credentials", lambda: False)
    monkeypatch.setattr(T, "_converse", lambda _: pytest.fail("Bedrock must not be called"))
    req = T.TaskEstimateRequest(description="Summarize a short document", type="inference")
    first = T.estimate_task(req)
    second = T.estimate_task(req)
    assert first["source"] == "fallback"
    assert first["sizing"] == second["sizing"]
    assert first["sizing"]["model"] == T.SERVING_MODEL
    assert "price" not in json.dumps(first).lower()


@pytest.mark.parametrize("field,value", [("gpus", 0), ("gpus", 9), ("vcpu", 129),
    ("ramGb", -1), ("storageGb", 10001), ("durationSeconds", 604801),
    ("gpus", True), ("durationSeconds", "3600")])
def test_invalid_bedrock_numbers_fall_back(monkeypatch, field, value):
    monkeypatch.setattr(T.C, "MOCK", False)
    monkeypatch.setattr(T, "_has_local_credentials", lambda: True)
    req = T.TaskEstimateRequest(description="Summarize a short document", type="inference")
    data = T.fallback_sizing(req).model_dump()
    data[field] = value
    monkeypatch.setattr(T, "_converse", lambda _: json.dumps(data))
    assert T.estimate_task(req)["source"] == "fallback"


def test_valid_bedrock_sizing_is_labelled(monkeypatch):
    monkeypatch.setattr(T.C, "MOCK", False)
    monkeypatch.setattr(T, "_has_local_credentials", lambda: True)
    req = T.TaskEstimateRequest(description="Summarize a short document", type="inference")
    data = T.fallback_sizing(req).model_dump()
    monkeypatch.setattr(T, "_converse", lambda _: json.dumps(data))
    result = T.estimate_task(req)
    assert result["source"] == "bedrock"
    assert result["region"] == "us-east-2"
    assert result["modelId"] == T.C.BEDROCK_MODEL_ID


@pytest.mark.parametrize("extra", [{"price": 0.01}, {"model": "undeployed/model"}])
def test_bedrock_cannot_add_prices_or_undeployed_models(monkeypatch, extra):
    monkeypatch.setattr(T.C, "MOCK", False)
    monkeypatch.setattr(T, "_has_local_credentials", lambda: True)
    req = T.TaskEstimateRequest(description="Summarize", type="inference")
    data = {**T.fallback_sizing(req).model_dump(), **extra}
    monkeypatch.setattr(T, "_converse", lambda _: json.dumps(data))
    assert T.estimate_task(req)["source"] == "fallback"


def test_invalid_input_is_rejected():
    with pytest.raises(ValidationError):
        T.TaskEstimateRequest(description="   ")
    with pytest.raises(ValidationError):
        T.TaskEstimateRequest(description="work", type="unknown")
