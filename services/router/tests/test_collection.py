import json
import shutil
import subprocess
import sys
from datetime import UTC, datetime, timedelta
from pathlib import Path

import boto3
from moto import mock_aws

from router import config as C
from router import secrets
from router.catalog import iso
from router.collectors.base import CollectContext
from router.lambdas import collect_handler
from router.scheduler import collect_group, initial_load
from router.service import Service
from router.store import DynamoCatalogStore, SqliteCatalogStore, offer_from_json, offer_to_json

NOW = datetime(2026, 10, 24, 22, 0, tzinfo=UTC)
INFRA = Path(__file__).resolve().parent.parent / "infra"


def make_aws_resources():
    ddb = boto3.client("dynamodb", region_name=C.AWS_REGION)
    ddb.create_table(
        TableName=C.CATALOG_TABLE,
        BillingMode="PAY_PER_REQUEST",
        AttributeDefinitions=[
            {"AttributeName": "pk", "AttributeType": "S"},
            {"AttributeName": "sk", "AttributeType": "S"},
        ],
        KeySchema=[{"AttributeName": "pk", "KeyType": "HASH"}, {"AttributeName": "sk", "KeyType": "RANGE"}],
    )
    boto3.client("s3", region_name=C.AWS_REGION).create_bucket(
        Bucket=C.PRICES_BUCKET, CreateBucketConfiguration={"LocationConstraint": C.AWS_REGION}
    )


def test_offer_json_round_trip():
    s = Service()
    s.collect(ctx=CollectContext(now=NOW))
    o = s.offers["aws#us-east-2#g4dn.xlarge#spot"]
    assert offer_from_json(offer_to_json(o)) == o


def test_sqlite_store_keeps_latest_and_history(tmp_path):
    store = SqliteCatalogStore(tmp_path / "c.db")
    offers, errors = collect_group("providers", store, CollectContext(now=NOW))
    assert not errors and offers
    latest = store.latest()
    assert {o.key for o in latest} == {o.key for o in offers}
    sources = {k.split("/")[0] for k, _ in store.history()}
    assert {"azure", "oracle", "runpod", "vast", "gcp", "lambda"} <= sources
    key, body = store.history("azure_retail")[0]
    assert key.startswith("azure/2026-10-24/") and body["Items"]


@mock_aws
def test_dynamodb_and_s3_store_same_shapes():
    make_aws_resources()
    store = DynamoCatalogStore(boto3.client)
    offers, errors = collect_group("spot", store, CollectContext(now=NOW))
    assert not errors
    got = store.latest()
    assert {o.key for o in got} == {o.key for o in offers}
    item = boto3.client("dynamodb", region_name=C.AWS_REGION).get_item(
        TableName=C.CATALOG_TABLE, Key={"pk": {"S": "aws#us-east-2#g4dn.xlarge"}, "sk": {"S": "spot"}}
    )["Item"]
    assert item["provider"]["S"] == "aws" and item["asOf"]["S"] == iso(NOW)
    keys = [
        o["Key"]
        for o in boto3.client("s3", region_name=C.AWS_REGION).list_objects_v2(Bucket=C.PRICES_BUCKET)["Contents"]
    ]
    assert any(k.startswith("aws/2026-10-24/") and k.endswith("aws_spot_price.json") for k in keys)


@mock_aws
def test_lambda_collect_handler_writes_catalog(monkeypatch):
    make_aws_resources()
    out = collect_handler({"group": "on_demand"})
    assert out["group"] == "on_demand" and out["offers"] > 0 and out["errors"] == {}
    assert any(o.capacityType == "on-demand" for o in DynamoCatalogStore(boto3.client).latest())


@mock_aws
def test_secrets_manager_wins_over_env_and_values_stay_private(monkeypatch, caplog):
    monkeypatch.setenv("LAMBDA_API_KEY", "env-lambda")
    monkeypatch.setenv("VAST_API_KEY", "env-vast")
    sm = boto3.client("secretsmanager", region_name=C.AWS_REGION)
    sm.create_secret(Name=C.PROVIDER_SECRET_ID, SecretString=json.dumps({"lambdaApiKey": "sm-lambda", "gcpApiKey": ""}))
    got = secrets.provider_secrets(client=boto3.client, refresh=True)
    assert got["lambdaApiKey"] == "sm-lambda" and got["vastApiKey"] == "env-vast" and "gcpApiKey" not in got
    assert "sm-lambda" not in caplog.text and "env-vast" not in caplog.text


def test_secrets_fall_back_to_env_without_aws(monkeypatch):
    monkeypatch.setenv("RUNPOD_API_KEY", "env-runpod")

    def broken(*a, **k):
        raise RuntimeError("no credentials")

    got = secrets.provider_secrets(client=broken, refresh=True)
    assert got.get("runpodApiKey") == "env-runpod"


async def test_initial_load_starts_from_last_good_snapshot(tmp_path):
    store = SqliteCatalogStore(tmp_path / "c.db")
    s = Service()
    await initial_load(s, store)
    assert len(s.offers) >= 30 and len(s.entries) == 6
    # A second service starts from the stored snapshot even before collecting.
    s2 = Service()
    s2.load_catalog(store.latest())
    assert set(s2.offers) == set(s.offers)


def test_staleness_tiers():
    s = Service()
    s.collect(ctx=CollectContext(now=NOW))
    e = s.entry("gpu-a2")
    fresh = s.state.view(e, NOW + timedelta(minutes=10))
    assert fresh.available and fresh.fresh and not fresh.degraded
    last_good = s.state.view(e, NOW + timedelta(hours=1))
    assert last_good.available and not last_good.fresh and last_good.degraded
    stale = s.state.view(e, NOW + timedelta(hours=3))
    assert not stale.available and stale.reason == "STALE_PRICE"


def test_sam_template_validates():
    exe = shutil.which("cfn-lint") or str(Path(sys.executable).parent / "cfn-lint")
    r = subprocess.run([exe, str(INFRA / "template.yaml")], capture_output=True, text=True)
    assert r.returncode == 0, r.stdout + r.stderr


def test_state_machine_inputs_are_pointers_only():
    asl = json.loads((INFRA / "statemachine" / "order.asl.json").read_text())
    dispatch = asl["States"]["Dispatch"]
    assert dispatch["Resource"] == "arn:aws:states:::sqs:sendMessage.waitForTaskToken"
    assert dispatch["HeartbeatSeconds"] == 300
    assert set(dispatch["Parameters"]["MessageBody"]) == {"orderId.$", "taskToken.$"}
