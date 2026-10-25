"""Additional physical workers need their own verified lease and model observations."""
from __future__ import annotations

import pytest

from router import config as C
from router.catalog import iso, now_utc
from router.fleet import load_entries


@pytest.fixture(autouse=True)
def isolated_expansion(monkeypatch):
    monkeypatch.setattr(C, "FLEET_SOURCE", "own")
    for letter in "CDEFGH":
        for key in list(__import__("os").environ):
            if key.startswith(f"GPU_{letter}_"):
                monkeypatch.delenv(key)


def configure(monkeypatch, letter="C", **overrides):
    values = {"VLLM_URL": f"http://verified-{letter.lower()}/v1/", "MODE": "real",
              "CARD": "NVIDIA Tesla V100", "VRAM_GB": "32", "VCPU": "4",
              "RAM_GB": "16", "STORAGE_GB": "50", "MODEL_ID": "Qwen/Qwen2.5-3B-Instruct",
              "LEASE_USD_PER_HOUR": "0.2", "PRICE_UPDATED_AT": iso(now_utc()),
              "PLANNING_TOKENS_PER_SEC": "53.25", "PLANNING_MODEL_ID": "Qwen/Qwen2.5-3B-Instruct",
              "PLANNING_OBSERVED_AT": iso(now_utc()), "PLANNING_SAMPLE_COUNT": "2"}
    values.update(overrides)
    for key, value in values.items():
        monkeypatch.setenv(f"GPU_{letter}_{key}", value)


def test_six_distinct_nodes_keep_actual_hardware_identity_and_own_cost(monkeypatch):
    for letter in "CDEFGH":
        configure(monkeypatch, letter)
    entries = load_entries({})
    assert [e.id for e in entries] == [f"gpu-{letter}" for letter in "abcdefgh"]
    for e in entries[2:]:
        assert e.moonshiftGpuId == e.computeGpuId == e.id
        assert e.hardware == "NVIDIA Tesla V100 32GB (Akash Network)"
        assert e.offerFound and e.offer.tokensPerSec == 53.25
        assert e.offer.pricePerHourUsd == 0.25
        assert e.planningObservation["modelId"] == "Qwen/Qwen2.5-3B-Instruct"


@pytest.mark.parametrize("key", ["MODEL_ID", "CARD", "VRAM_GB", "VCPU", "RAM_GB", "STORAGE_GB", "LEASE_USD_PER_HOUR", "PRICE_UPDATED_AT"])
def test_incomplete_new_node_never_inherits_another_nodes_spec_or_cost(monkeypatch, key):
    configure(monkeypatch)
    monkeypatch.delenv(f"GPU_C_{key}")
    assert "gpu-c" not in {e.id for e in load_entries({})}


@pytest.mark.parametrize("key,value", [("PLANNING_TOKENS_PER_SEC", "0"), ("PLANNING_MODEL_ID", "other-model"),
                                      ("PLANNING_SAMPLE_COUNT", "1"), ("PLANNING_OBSERVED_AT", "")])
def test_unmeasured_or_wrong_model_cannot_execute_even_on_a_known_card(monkeypatch, key, value):
    configure(monkeypatch, CARD="NVIDIA GeForce RTX 4090", **{key: value})
    e = next(e for e in load_entries({}) if e.id == "gpu-c")
    assert not e.offerFound and e.offer.tokensPerSec == 0


def test_an_existing_endpoint_cannot_be_recounted_under_a_new_letter(monkeypatch):
    monkeypatch.setenv("GPU_A_VLLM_URL", "http://same-node/")
    configure(monkeypatch, VLLM_URL="http://same-node/v1/")
    assert "gpu-c" not in {e.id for e in load_entries({})}
