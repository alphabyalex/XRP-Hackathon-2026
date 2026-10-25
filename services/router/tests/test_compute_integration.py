"""Router + real services/compute (resume.py) over HTTP: reclaim mid-stream, resume on the other GPU.

Starts compute from its own venv (MOCK=1 model). Skipped when services/compute/.venv is missing.
"""

import dataclasses
import os
import socket
import subprocess
import time
from pathlib import Path

import httpx
import pytest

from router import config as C
from router.collectors.base import CollectContext
from router.orders import OrderCreate, Orders
from router.service import Service
from router.state import SqliteState

COMPUTE = Path(__file__).resolve().parents[2] / "compute"
PY = COMPUTE / ".venv" / "bin" / "python"
if not PY.exists():
    PY = Path(__file__).resolve().parents[3] / ".venv" / "bin" / "python"
KEY = "integration-key"
MSGS = [{"role": "user", "content": "Explain VWAP in one line please"}]

pytestmark = pytest.mark.skipif(not PY.exists(), reason="services/compute venv not set up")


@pytest.fixture
def compute(tmp_path):
    sock = socket.socket()
    sock.bind(("127.0.0.1", 0))
    port = sock.getsockname()[1]
    sock.close()
    env = {
        **os.environ,
        "MOCK": "1",
        "INTERNAL_API_KEY": KEY,
        "RESUME_MOCK_TIME_SCALE": "2",
        "COMPUTE_STATE_DIR": str(tmp_path),
        "STATE_DIR": str(tmp_path),
        "API_URL": "http://127.0.0.1:9",
    }
    proc = subprocess.Popen(
        [
            str(PY),
            "-m",
            "uvicorn",
            "compute.main:app",
            "--host",
            "127.0.0.1",
            "--port",
            str(port),
            "--log-level",
            "warning",
        ],
        cwd=COMPUTE,
        env=env,
    )
    url = f"http://127.0.0.1:{port}"
    for _ in range(100):
        try:
            if httpx.get(f"{url}/health", timeout=0.5).status_code == 200:
                break
        except httpx.HTTPError:
            time.sleep(0.1)
    yield url
    proc.terminate()
    proc.wait(timeout=10)


async def test_reclaim_on_compute_worker_resumes_on_the_other_gpu(compute, tmp_path, monkeypatch):
    monkeypatch.setattr(C, "INTERNAL_API_KEY", KEY)
    monkeypatch.setattr(C, "COMPUTE_URL", compute)
    svc = Service()
    svc.collect(ctx=CollectContext())
    # Point the two Moonshift GPUs at the running compute worker.
    svc.entries = [
        dataclasses.replace(e, endpoint=compute) if e.offer.provider == "moonshift" else e for e in svc.entries
    ]
    orders = Orders(svc, SqliteState(tmp_path / "s.db"))
    real_emit = orders.emit
    fired = []

    def emit(order, kind, data, persist=True):
        real_emit(order, kind, data, persist)
        if kind == "token" and data["index"] == 8 and not fired:
            fired.append(order["segments"][-1]["gpuId"])
            orders.reclaim(fired[0], 5, "RECLAIMED")

    orders.emit = emit
    order = await orders.create(
        OrderCreate(
            kind="inference",
            mode="balanced",
            maxTokens=200,
            requests=[MSGS],
            constraints={"excludeProviders": ["aws", "azure", "vast"]},
        )
    )
    await orders.pay(order["orderId"])
    order = await orders.execute(order["orderId"])
    assert order["status"] == "completed", order["events"][-1]
    first, second = order["segments"]
    assert {first["gpuId"], second["gpuId"]} == {"gpu-a1", "gpu-b1"}
    assert order["moves"][0]["resumedAt"] == first["served"] >= 8
    # One continuous reply: identical to an uninterrupted run on compute.
    r = httpx.post(
        f"{compute}/v1/resume/stream",
        headers={"X-MS-Internal-Key": KEY},
        json={"gpuId": "gpu-b", "messages": MSGS, "maxTokens": 200},
        timeout=30,
    )
    whole = [line for line in r.text.splitlines() if '"kind": "done"' in line][0]
    assert order["output"][0] in whole and len(order["output"][0]) > 20
    assert first["served"] + second["served"] == order["progress"]["done"]
