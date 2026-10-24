"""AWS: on-demand list prices, spot prices, placement scores, offerings, Capacity Blocks, Spot Advisor.

Live calls use boto3's default credential chain and are read-only (pricing:GetProducts,
ec2:DescribeSpotPriceHistory, ec2:GetSpotPlacementScores, ec2:DescribeInstanceTypeOfferings,
ec2:DescribeCapacityBlockOfferings). The Spot Advisor JSON is public.
"""

from __future__ import annotations

import json
from datetime import timedelta
from typing import Any

from router import config as C
from router.catalog import Availability, Offer, aws_spot_rate, iso, make_offer
from router.collectors.base import CollectContext, fixture, http_json, target

ADVISOR_URL = "https://spot-bid-advisor.s3.amazonaws.com/spot-advisor-data.json"

Key = tuple[str, str]  # (region, instance type)


def spot_advisor(ctx: CollectContext) -> dict[Key, dict[str, int]]:
    """{(region, type): {"s": savings %, "r": band index}} from the public Spot Instance Advisor."""
    if ctx.is_live("aws_spot_advisor"):
        data = http_json(ctx, "GET", ADVISOR_URL)
    else:
        data = fixture("aws_spot_advisor.json")
    ctx.record("aws_spot_advisor", {"ranges": data.get("ranges")})
    t = target("aws")
    out: dict[Key, dict[str, int]] = {}
    for region in t["regions"]:
        linux = data.get("spot_advisor", {}).get(region, {}).get("Linux", {})
        for it in t["instanceTypes"]:
            if it in linux:
                out[(region, it)] = linux[it]
    return out


def on_demand_prices(ctx: CollectContext) -> dict[Key, float]:
    """Linux, shared tenancy, no pre-installed software. Price List endpoint is us-east-1."""
    t = target("aws")
    if ctx.is_live("aws_pricing"):
        client = ctx.client("pricing", C.AWS_PRICING_REGION)
        price_list: list[str] = []
        for region in t["regions"]:
            for it in t["instanceTypes"]:
                filters = [
                    {"Type": "TERM_MATCH", "Field": "instanceType", "Value": it},
                    {"Type": "TERM_MATCH", "Field": "regionCode", "Value": region},
                    {"Type": "TERM_MATCH", "Field": "operatingSystem", "Value": "Linux"},
                    {"Type": "TERM_MATCH", "Field": "tenancy", "Value": "Shared"},
                    {"Type": "TERM_MATCH", "Field": "preInstalledSw", "Value": "NA"},
                    {"Type": "TERM_MATCH", "Field": "capacitystatus", "Value": "Used"},
                ]
                for page in client.get_paginator("get_products").paginate(ServiceCode="AmazonEC2", Filters=filters):
                    price_list.extend(page.get("PriceList", []))
    else:
        price_list = fixture("aws_pricing_get_products.json")["PriceList"]
    ctx.record("aws_pricing", {"PriceList": price_list})
    out: dict[Key, float] = {}
    for raw in price_list:
        item = json.loads(raw) if isinstance(raw, str) else raw
        attrs = item["product"]["attributes"]
        for term in item.get("terms", {}).get("OnDemand", {}).values():
            for dim in term["priceDimensions"].values():
                usd = float(dim["pricePerUnit"]["USD"])
                if usd > 0:
                    out[(attrs["regionCode"], attrs["instanceType"])] = usd
    return out


def spot_prices(ctx: CollectContext) -> dict[Key, tuple[float, str]]:
    """Cheapest current spot price per (region, type) and the AZ it is in."""
    t = target("aws")
    history: list[dict[str, Any]] = []
    if ctx.is_live("aws_spot_price"):
        for region in t["regions"]:
            ec2 = ctx.client("ec2", region)
            resp = ec2.describe_spot_price_history(
                InstanceTypes=list(t["instanceTypes"]),
                ProductDescriptions=["Linux/UNIX"],
                StartTime=ctx.now - timedelta(minutes=5),
            )
            history.extend(resp.get("SpotPriceHistory", []))
    else:
        history = fixture("aws_spot_price_history.json")["SpotPriceHistory"]
    ctx.record("aws_spot_price", {"SpotPriceHistory": [{**h, "Timestamp": str(h["Timestamp"])} for h in history]})
    out: dict[Key, tuple[float, str]] = {}
    for h in history:
        az = h["AvailabilityZone"]
        key = (az[:-1], h["InstanceType"])
        price = float(h["SpotPrice"])
        if key not in out or price < out[key][0]:
            out[key] = (price, az)
    return out


def placement_scores(ctx: CollectContext) -> dict[Key, int]:
    """Spot placement score per (region, type). G family types may be scored one at a time."""
    t = target("aws")
    out: dict[Key, int] = {}
    if ctx.is_live("aws_placement"):
        ec2 = ctx.client("ec2", C.AWS_REGION)
        for it in t["instanceTypes"]:
            resp = ec2.get_spot_placement_scores(
                InstanceTypes=[it], TargetCapacity=1, RegionNames=t["regions"], SingleAvailabilityZone=False
            )
            for s in resp.get("SpotPlacementScores", []):
                out[(s["Region"], it)] = int(s["Score"])
    else:
        for region, scores in fixture("aws_spot_placement_scores.json")["scores"].items():
            for it, score in scores.items():
                out[(region, it)] = int(score)
    ctx.record("aws_placement", {f"{r}#{i}": s for (r, i), s in out.items()})
    return out


def offerings(ctx: CollectContext) -> set[Key]:
    t = target("aws")
    rows: list[dict[str, Any]] = []
    if ctx.is_live("aws_offerings"):
        for region in t["regions"]:
            ec2 = ctx.client("ec2", region)
            resp = ec2.describe_instance_type_offerings(
                LocationType="region", Filters=[{"Name": "instance-type", "Values": list(t["instanceTypes"])}]
            )
            rows.extend(resp.get("InstanceTypeOfferings", []))
    else:
        rows = fixture("aws_instance_type_offerings.json")["InstanceTypeOfferings"]
    return {(r["Location"], r["InstanceType"]) for r in rows}


def capacity_blocks(ctx: CollectContext) -> list[dict[str, Any]]:
    """Reserved GPU time for sale. Tight API throttle (bucket 10, refill 0.15/s): daily only."""
    if ctx.is_live("aws_capacity_blocks"):
        ec2 = ctx.client("ec2", C.AWS_REGION)
        resp = ec2.describe_capacity_block_offerings(CapacityDurationHours=24, InstanceCount=1)
        rows: list[dict[str, Any]] = resp.get("CapacityBlockOfferings", [])
    else:
        rows = fixture("aws_capacity_block_offerings.json")["CapacityBlockOfferings"]
    return rows


def _targets(ctx: CollectContext) -> list[tuple[str, str, dict[str, Any]]]:
    t = target("aws")
    offered = offerings(ctx)
    return [(r, it, spec) for r in t["regions"] for it, spec in t["instanceTypes"].items() if (r, it) in offered]


def collect_on_demand(ctx: CollectContext) -> list[Offer]:
    """Daily: on-demand list prices and Capacity Blocks."""
    od = on_demand_prices(ctx)
    offers: list[Offer] = []
    for region, it, spec in _targets(ctx):
        if (region, it) in od:
            offers.append(
                make_offer(
                    provider="aws",
                    region=region,
                    instance_type=it,
                    gpu_model=spec["gpuModel"],
                    gpu_count=spec["gpuCount"],
                    capacity_type="on-demand",
                    price_per_hour_usd=od[(region, it)],
                    price_source="live" if ctx.is_live("aws_pricing") else "fixture",
                    as_of=ctx.as_of,
                    availability=Availability("likely"),
                )
            )
    offers.extend(_capacity_block_offers(ctx))
    return offers


def collect_spot(ctx: CollectContext) -> list[Offer]:
    """Every 5 minutes: spot prices, blended with placement scores and the Spot Advisor band."""
    advisor = spot_advisor(ctx)
    spot = spot_prices(ctx)
    scores = placement_scores(ctx)
    offers: list[Offer] = []
    for region, it, spec in _targets(ctx):
        if (region, it) not in spot:
            continue
        price, az = spot[(region, it)]
        score = scores.get((region, it))
        band = advisor.get((region, it), {}).get("r")
        offers.append(
            make_offer(
                provider="aws",
                region=region,
                instance_type=it,
                gpu_model=spec["gpuModel"],
                gpu_count=spec["gpuCount"],
                capacity_type="spot",
                price_per_hour_usd=price,
                price_source="live" if ctx.is_live("aws_spot_price") else "fixture",
                as_of=ctx.as_of,
                availability=Availability("likely" if (score or 0) >= 5 else "unknown", score=score),
                interruption_rate=aws_spot_rate(band, score),
                extra={
                    "availabilityZone": az,
                    "advisorBand": band,
                    "savingsPct": advisor.get((region, it), {}).get("s"),
                },
            )
        )
    return offers


def _capacity_block_offers(ctx: CollectContext) -> list[Offer]:
    t = target("aws")
    offers: list[Offer] = []
    for block in capacity_blocks(ctx):
        it = block.get("InstanceType", "")
        spec = t["instanceTypes"].get(it)
        if not spec:
            continue
        hours = float(block.get("CapacityBlockDurationHours") or 24)
        offers.append(
            make_offer(
                provider="aws",
                region=block.get("AvailabilityZone", C.AWS_REGION)[:-1] or C.AWS_REGION,
                instance_type=it,
                gpu_model=spec["gpuModel"],
                gpu_count=spec["gpuCount"],
                capacity_type="reserved",
                price_per_hour_usd=float(block.get("UpfrontFee", 0)) / hours,
                price_source="live",
                as_of=ctx.as_of,
                availability=Availability("live", count=int(block.get("InstanceCount", 1))),
                extra={
                    "startDate": iso(block["StartDate"])
                    if hasattr(block.get("StartDate"), "tzinfo")
                    else block.get("StartDate")
                },
            )
        )
    return offers
