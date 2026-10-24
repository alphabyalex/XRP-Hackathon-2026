import json
import logging

import boto3
import pytest
from moto import mock_aws

from router import config as C
from router import launch, metrics
from router.collectors.base import CollectContext
from router.service import Service


@pytest.fixture(autouse=True)
def fresh_client():
    metrics.reset()
    yield
    metrics.reset()
    metrics.client_factory = None


def test_metrics_off_only_logs(monkeypatch, caplog):
    monkeypatch.setattr(C, "CLOUDWATCH", False)

    def boom(*a, **k):
        raise AssertionError("CloudWatch called while CLOUDWATCH=0")

    metrics.client_factory = boom
    with caplog.at_level(logging.INFO, logger="router.metrics"):
        metrics.ordered("ord_1", "balanced", 0.1)
    line = json.loads(caplog.records[-1].getMessage())
    assert line == {"event": "order", "Orders": 1, "PredictedCostUsdc": 0.1, "Mode": "balanced", "orderId": "ord_1"}


@mock_aws
def test_metrics_on_publish_to_cloudwatch(monkeypatch):
    monkeypatch.setattr(C, "CLOUDWATCH", True)
    metrics.client_factory = boto3.client
    metrics.moved("ord_1", "RECLAIMED", 2.5, "azure", "aws")
    metrics.settled("ord_1", "cheapest", 0.2, 0.15)
    cw = boto3.client("cloudwatch", region_name=C.AWS_REGION)
    names = {m["MetricName"] for m in cw.list_metrics(Namespace=metrics.NAMESPACE)["Metrics"]}
    assert {"Moves", "ResumeLatency", "ActualCostUsdc", "PredictedCostUsdc", "CostErrorPct"} <= names


def test_launch_refuses_without_flag(monkeypatch):
    monkeypatch.setattr(C, "AWS_LAUNCH", False)
    s = Service()
    s.collect(ctx=CollectContext())
    with pytest.raises(launch.LaunchDisabled):
        launch.launch_worker(s.offers["aws#us-east-2#g4dn.xlarge#spot"], "ord_1", "ami-12345678")


@mock_aws
def test_launch_tags_instances_with_the_order(monkeypatch):
    monkeypatch.setattr(C, "AWS_LAUNCH", True)
    s = Service()
    s.collect(ctx=CollectContext())
    iam = boto3.client("iam", region_name="us-east-2")  # created by infra/template.yaml in a real stack
    iam.create_role(RoleName="ms-router-worker", AssumeRolePolicyDocument="{}")
    iam.create_instance_profile(InstanceProfileName="ms-router-worker")
    iam.add_role_to_instance_profile(InstanceProfileName="ms-router-worker", RoleName="ms-router-worker")
    ec2 = boto3.client("ec2", region_name="us-east-2")
    ami = ec2.describe_images(Owners=["amazon"])["Images"][0]["ImageId"]
    iid = launch.launch_worker(s.offers["aws#us-east-2#g4dn.xlarge#spot"], "ord_42", ami, client=boto3.client)
    inst = ec2.describe_instances(InstanceIds=[iid])["Reservations"][0]["Instances"][0]
    tags = {t["Key"]: t["Value"] for t in inst["Tags"]}
    assert tags[launch.TAG_ORDER] == "ord_42" and inst["InstanceType"] == "g4dn.xlarge"
    assert inst.get("InstanceLifecycle") == "spot"
