"""Launch a worker on EC2 for an order (spot or on-demand). Billable: refuses unless AWS_LAUNCH=1.

Every instance carries moonshift:orderId and moonshift:component tags, so the AWS Cost and Usage
Report (CUR 2.0) can be joined back to the order (docs/ROUTER.md, Cost truth). The instance runs the
compute worker from the ECR image and uses the ms-router-worker instance profile (infra/template.yaml).
"""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

from router import config as C
from router.catalog import Offer

TAG_ORDER = "moonshift:orderId"
TAG_COMPONENT = "moonshift:component"


class LaunchDisabled(Exception):
    pass


def launch_worker(
    offer: Offer, order_id: str, image_ami: str, user_data: str = "", client: Callable[..., Any] | None = None
) -> str:
    if not C.AWS_LAUNCH:
        raise LaunchDisabled("AWS_LAUNCH=1 is required to start billable instances")
    if offer.provider != "aws":
        raise ValueError("only AWS offers can be launched here")
    if client is None:
        import boto3

        client = boto3.client
    ec2 = client("ec2", region_name=offer.region)
    tags = [{"Key": TAG_ORDER, "Value": order_id}, {"Key": TAG_COMPONENT, "Value": "router-worker"}]
    kwargs: dict[str, Any] = {
        "ImageId": image_ami,
        "InstanceType": offer.instanceType,
        "MinCount": 1,
        "MaxCount": 1,
        "IamInstanceProfile": {"Name": "ms-router-worker"},
        "MetadataOptions": {"HttpTokens": "required"},  # IMDSv2, which resume.py polls for spot notices
        "TagSpecifications": [{"ResourceType": "instance", "Tags": tags}, {"ResourceType": "volume", "Tags": tags}],
        "UserData": user_data,
    }
    if offer.capacityType == "spot":
        kwargs["InstanceMarketOptions"] = {
            "MarketType": "spot",
            "SpotOptions": {"SpotInstanceType": "one-time", "InstanceInterruptionBehavior": "terminate"},
        }
    resp = ec2.run_instances(**kwargs)
    return str(resp["Instances"][0]["InstanceId"])
