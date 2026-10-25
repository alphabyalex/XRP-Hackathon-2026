"""Deployment settings tests use inert in-memory fixtures, never the operator's environment."""
from __future__ import annotations

import importlib.util
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch


class RuntimeSettingsTests(unittest.TestCase):
    def setUp(self):
        path = Path(__file__).resolve().parents[1] / "prepare.py"
        spec = importlib.util.spec_from_file_location("test_backend_prepare", path)
        self.module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.module)
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.module.PRIVATE = Path(self.temp.name)
        self.fixture = {"MOONSHIFT_ACCOUNT_KEY": "0" * 64, "GPU_NODES": ",".join(f"gpu-{x}" for x in "abcdefgh"),
                        "AWS_SECRET_ACCESS_KEY": "fixture-excluded", "AKASH_MNEMONIC": "fixture-excluded",
                        "GPU_I_VLLM_URL": "http://unsupported"}
        for letter in "ABCDEFGH":
            prefix = f"GPU_{letter}"
            for suffix, value in {"MODE": "real", "VLLM_URL": f"http://worker-{letter.lower()}",
                "MODEL_ID": "Qwen/Qwen2.5-3B-Instruct", "WIRE_MODEL": f"wire-{letter.lower()}",
                "TOKENS_PER_SEC": "12", "PLANNING_TOKENS_PER_SEC": "12", "PLANNING_MODEL_ID": "Qwen/Qwen2.5-3B-Instruct",
                "PLANNING_SAMPLE_COUNT": "2", "PLANNING_OBSERVED_AT": "2026-10-25T15:00:00Z"}.items():
                self.fixture[f"{prefix}_{suffix}"] = value

    def settings(self):
        with patch.object(self.module, "dotenv", return_value=self.fixture):
            return self.module.runtime_settings()

    def test_eight_node_model_modes_and_measured_planning_fields_survive_allowlist(self):
        result = self.settings()
        for letter in "ABCDEFGH":
            prefix = f"GPU_{letter}"
            for suffix in ("MODE", "MODEL_ID", "WIRE_MODEL", "TOKENS_PER_SEC", "PLANNING_TOKENS_PER_SEC",
                           "PLANNING_MODEL_ID", "PLANNING_OBSERVED_AT", "PLANNING_SAMPLE_COUNT"):
                self.assertEqual(result[f"{prefix}_{suffix}"], self.fixture[f"{prefix}_{suffix}"])
        self.assertEqual(result["GPU_NODES"], self.fixture["GPU_NODES"])
        for key in ("AWS_SECRET_ACCESS_KEY", "AKASH_MNEMONIC", "GPU_I_VLLM_URL"):
            self.assertNotIn(key, result)

    def test_duplicate_endpoint_alias_never_activates_twice(self):
        self.fixture["GPU_C_VLLM_URL"] = "http://localhost:8123/v1/"
        self.fixture["GPU_D_VLLM_URL"] = "http://127.0.0.1:8123"
        with self.assertRaisesRegex(RuntimeError, "own verified endpoint"):
            self.settings()

    def test_enabled_unverified_model_or_mode_is_rejected(self):
        for field, value in (("GPU_H_MODEL_ID", ""), ("GPU_H_MODE", "simulated")):
            with self.subTest(field=field):
                original = self.fixture[field]
                self.fixture[field] = value
                with self.assertRaisesRegex(RuntimeError, "canonical model and real mode"):
                    self.settings()
                self.fixture[field] = original


if __name__ == "__main__":
    unittest.main()
