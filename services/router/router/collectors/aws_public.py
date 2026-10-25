"""Read the same credential-free feeds used by AWS's public EC2 pricing pages.

These are price comparisons, never a claim that Moonshift owns EC2 GPU capacity.
No AWS SDK, signed request, resource creation or fixture fallback is involved.
"""

from __future__ import annotations

import math
from urllib.parse import quote

from router.catalog import Availability, Offer, make_offer
from router.collectors.base import CollectContext, http_json, target

SPOT_URL = "https://website.spot.ec2.aws.a2z.com/spot.json"
ON_DEMAND_BASE = "https://b0.p.awsstatic.com/pricing/2.0/meteredUnitMaps/ec2/USD/current/ec2-ondemand-without-sec-sel"
REGION_NAMES = {"us-east-1": "US East (N. Virginia)", "us-east-2": "US East (Ohio)"}


def positive_price(value: object) -> float | None:
    try:
        price = float(value)
    except (TypeError, ValueError):
        return None
    return price if math.isfinite(price) and price > 0 else None


def collect(ctx: CollectContext) -> list[Offer]:
    if not ctx.is_live("aws_public"):
        return []
    wanted = target("aws")
    offers: list[Offer] = []
    spot = http_json(ctx, "GET", SPOT_URL)
    for region in spot.get("config", {}).get("regions", []):
        region_id = region.get("region")
        if region_id not in wanted["regions"]:
            continue
        for family in region.get("instanceTypes", []):
            for size in family.get("sizes", []):
                instance = size.get("size")
                spec = wanted["instanceTypes"].get(instance)
                if spec is None:
                    continue
                for column in size.get("valueColumns", []):
                    price = positive_price(column.get("prices", {}).get("USD"))
                    if column.get("name") == "linux" and price is not None:
                        offers.append(make_offer(
                            provider="aws", region=region_id, instance_type=instance,
                            gpu_model=spec["gpuModel"], gpu_count=spec["gpuCount"], capacity_type="spot",
                            price_per_hour_usd=price, price_source="live", as_of=ctx.as_of,
                            availability=Availability("unknown"),
                            extra={"source": SPOT_URL, "priceScope": "lowest in region", "updatedAt": ctx.as_of},
                        ))
    for region_id in wanted["regions"]:
        region_name = REGION_NAMES.get(region_id)
        if region_name is None:
            continue
        url = f"{ON_DEMAND_BASE}/{quote(region_name, safe='')}/Linux/index.json"
        data = http_json(ctx, "GET", url)
        for row in data.get("regions", {}).get(region_name, {}).values():
            instance = row.get("Instance Type")
            spec = wanted["instanceTypes"].get(instance)
            price = positive_price(row.get("price"))
            if spec is None or price is None:
                continue
            if row.get("Operating System") != "Linux" or row.get("Pre Installed S/W") != "NA":
                continue
            offers.append(make_offer(
                provider="aws", region=region_id, instance_type=instance,
                gpu_model=spec["gpuModel"], gpu_count=spec["gpuCount"], capacity_type="on-demand",
                price_per_hour_usd=price, price_source="live", as_of=ctx.as_of,
                availability=Availability("unknown"),
                extra={"source": url, "updatedAt": ctx.as_of,
                       "publishedAt": data.get("manifest", {}).get("hawkFilePublicationDate")},
            ))
    ctx.record("aws_public", [offer.to_dict() for offer in offers])
    return offers
