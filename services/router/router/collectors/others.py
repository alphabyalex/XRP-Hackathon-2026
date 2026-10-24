"""Price collectors for Azure, Google Cloud, Oracle, Lambda, RunPod, Vast.ai and static tables.

Each parses exactly the response shape verified in docs/ROUTER_PROVIDERS.md. Providers that need
a key (GCP, Lambda, and Vast.ai per its docs) fall back to their fixture when the key is missing,
and say so with priceSource "fixture".
"""

from __future__ import annotations

import logging
from typing import Any

from router import config as C
from router.catalog import Availability, Offer, gpu_key, make_offer, rate_from_monthly_fraction
from router.collectors.base import CollectContext, fixture, http_json, target

log = logging.getLogger("router.collectors")

AZURE_URL = "https://prices.azure.com/api/retail/prices"
GCP_URL = "https://cloudbilling.googleapis.com/v2beta"
GCP_COMPUTE_SERVICE = "services/6F81-5844-456A"
ORACLE_URL = "https://apexapps.oracle.com/pls/apex/cetools/api/v1/products/"
LAMBDA_URL = "https://cloud.lambda.ai/api/v1/instance-types"
RUNPOD_URL = "https://api.runpod.io/graphql"
VAST_URL = "https://console.vast.ai/api/v0/bundles/"


def _source(ctx: CollectContext, name: str) -> str:
    return "live" if ctx.is_live(name) else "fixture"


# ---- Microsoft Azure (Retail Prices API, no auth) ----------------------------------------


def azure(ctx: CollectContext) -> list[Offer]:
    t = target("azure")
    items: list[dict[str, Any]] = []
    if ctx.is_live("azure_retail"):
        for region in t["regions"]:
            for sku in t["skus"]:
                url: str | None = AZURE_URL
                params: dict[str, str] | None = {
                    "$filter": f"serviceName eq 'Virtual Machines' and armRegionName eq '{region}' "
                    f"and armSkuName eq '{sku}' and priceType eq 'Consumption'"
                }
                while url:  # 1,000 records per page, NextPageLink for the next
                    body = http_json(ctx, "GET", url, params=params)
                    items.extend(body.get("Items", []))
                    url, params = body.get("NextPageLink"), None
    else:
        items = fixture("azure_retail_prices.json")["Items"]
    ctx.record("azure_retail", {"Items": items})
    best: dict[tuple[str, str, str], float] = {}
    for i in items:
        sku = i.get("armSkuName")
        if sku not in t["skus"] or i.get("type") != "Consumption" or "Windows" in i.get("productName", ""):
            continue
        meter = i.get("meterName", "")
        if "Low Priority" in meter:
            continue
        cap = "spot" if meter.endswith("Spot") else "on-demand"
        key = (str(i["armRegionName"]), str(sku), cap)
        best[key] = min(best.get(key, float("inf")), float(i["retailPrice"]))
    out = []
    for (region, sku, cap), price in sorted(best.items()):
        spec = t["skus"][sku]
        out.append(
            make_offer(
                provider="azure",
                region=region,
                instance_type=sku,
                gpu_model=spec["gpuModel"],
                gpu_count=spec["gpuCount"],
                capacity_type=cap,
                price_per_hour_usd=price,
                price_source=_source(ctx, "azure_retail"),
                as_of=ctx.as_of,
                availability=Availability("unknown"),
            )
        )
    return out


# ---- Google Cloud (Cloud Billing Catalog API, API key) -----------------------------------


def gcp(ctx: CollectContext) -> list[Offer]:
    t = target("gcp")
    key = ctx.secrets.get("gcpApiKey", "")
    data = fixture("gcp_billing_catalog.json")
    live = ctx.is_live("gcp_catalog") and bool(key)
    if ctx.is_live("gcp_catalog") and not key:
        log.info("gcp_catalog: no API key in Secrets Manager, using fixture")
    if live:
        skus: list[dict[str, Any]] = []
        token = ""
        while True:
            body = http_json(
                ctx,
                "GET",
                f"{GCP_URL}/skus",
                params={"key": key, "pageSize": 5000, "pageToken": token, "filter": f'service="{GCP_COMPUTE_SERVICE}"'},
            )
            skus.extend(body.get("skus", []))
            token = body.get("nextPageToken", "")
            if not token:
                break
        wanted = [s for s in skus if any(g in s.get("displayName", "") for g in t["gpus"])]
        prices = {
            s["skuId"]: http_json(ctx, "GET", f"{GCP_URL}/skus/{s['skuId']}/prices", params={"key": key})
            for s in wanted
        }
        data = {
            "skus": wanted,
            "prices": {k: (v.get("prices") or [v])[0] for k, v in prices.items()},
            "vmBaseUsdPerHour": data["vmBaseUsdPerHour"],
        }
    ctx.record("gcp_catalog", data)
    out = []
    for sku in data["skus"]:
        name = sku.get("displayName", "")
        gpu = next((v for k, v in t["gpus"].items() if k in name), None)
        region = sku.get("geoTaxonomy", {}).get("regionalMetadata", {}).get("region", {}).get("region")
        if not gpu or region not in t["regions"] or sku["skuId"] not in data["prices"]:
            continue
        tier = data["prices"][sku["skuId"]]["rate"]["tiers"][0]["listPrice"]
        price = float(tier.get("units", 0)) + float(tier.get("nanos", 0)) / 1e9 + float(data["vmBaseUsdPerHour"])
        cats = [c["category"] for c in sku.get("productTaxonomy", {}).get("taxonomyCategories", [])]
        cap = "spot" if any("Preemptible" in c for c in cats) else "on-demand"
        out.append(
            make_offer(
                provider="gcp",
                region=region,
                instance_type=f"n1-standard-4+{gpu.lower()}",
                gpu_model=gpu,
                gpu_count=1,
                capacity_type=cap,
                price_per_hour_usd=price,
                price_source="live" if live else "fixture",
                as_of=ctx.as_of,
            )
        )
    return out


# ---- Oracle Cloud (public price list) -----------------------------------------------------


def oracle(ctx: CollectContext) -> list[Offer]:
    t = target("oracle")
    if ctx.is_live("oracle"):
        body = http_json(ctx, "GET", ORACLE_URL, params={"currencyCode": "USD"})
    else:
        body = fixture("oracle_price_list.json")
    items = [i for i in body.get("items", []) if i.get("partNumber") in t["partNumbers"]]
    ctx.record("oracle", {"items": items})
    out = []
    for i in items:
        price = float(i["currencyCodeLocalizations"][0]["prices"][0]["value"])
        gpu = t["partNumbers"][i["partNumber"]]
        out.append(
            make_offer(
                provider="oracle",
                region=t["region"],
                instance_type=f"VM.GPU.{gpu}.1",
                gpu_model=gpu,
                gpu_count=1,
                capacity_type="on-demand",
                price_per_hour_usd=price,
                price_source=_source(ctx, "oracle"),
                as_of=ctx.as_of,
                extra={"partNumber": i["partNumber"]},
            )
        )
    return out


# ---- Lambda (instance types with regions that have capacity, API key) --------------------


def lambda_cloud(ctx: CollectContext) -> list[Offer]:
    key = ctx.secrets.get("lambdaApiKey", "")
    live = ctx.is_live("lambda") and bool(key)
    body = (
        http_json(ctx, "GET", LAMBDA_URL, headers={"Authorization": f"Bearer {key}"})
        if live
        else fixture("lambda_instance_types.json")
    )
    ctx.record("lambda", body)
    out = []
    for item in body.get("data", {}).values():
        it = item["instance_type"]
        gpu = gpu_key(it.get("gpu_description", ""))
        if not gpu:
            continue
        regions = item.get("regions_with_capacity_available", [])
        for region in [r["name"] for r in regions] or ["any"]:
            out.append(
                make_offer(
                    provider="lambda",
                    region=region,
                    instance_type=it["name"],
                    gpu_model=gpu,
                    gpu_count=int(it["specs"]["gpus"]),
                    capacity_type="on-demand",
                    price_per_hour_usd=it["price_cents_per_hour"] / 100,
                    price_source="live" if live else "fixture",
                    as_of=ctx.as_of,
                    availability=Availability("live" if regions else "none", count=len(regions)),
                )
            )
    return out


# ---- RunPod (GraphQL gpuTypes: price and stock) -------------------------------------------


RUNPOD_QUERY = """query GpuType($id: String) { gpuTypes(input: {id: $id}) { id displayName memoryInGb
  securePrice communityPrice lowestPrice(input: {gpuCount: 1}) { uninterruptablePrice stockStatus } } }"""


def runpod(ctx: CollectContext) -> list[Offer]:
    t = target("runpod")
    types: list[dict[str, Any]] = []
    if ctx.is_live("runpod"):
        headers = {"Authorization": f"Bearer {ctx.secrets['runpodApiKey']}"} if ctx.secrets.get("runpodApiKey") else {}
        for gid in t["gpuTypes"]:
            body = http_json(
                ctx, "POST", RUNPOD_URL, json={"query": RUNPOD_QUERY, "variables": {"id": gid}}, headers=headers
            )
            types.extend(body.get("data", {}).get("gpuTypes", []))
    else:
        types = fixture("runpod_gpu_types.json")["data"]["gpuTypes"]
    ctx.record("runpod", {"gpuTypes": types})
    out = []
    for g in types:
        gpu = gpu_key(g.get("displayName", "")) or gpu_key(g.get("id", ""))
        if not gpu:
            continue
        stock = (g.get("lowestPrice") or {}).get("stockStatus")
        avail = Availability("none" if stock in (None, "None") else "live" if stock == "High" else "likely")
        for cap, price in (("on-demand", g.get("securePrice")), ("marketplace", g.get("communityPrice"))):
            if price:
                out.append(
                    make_offer(
                        provider="runpod",
                        region=t["region"],
                        instance_type=f"1x {g['displayName']}",
                        gpu_model=gpu,
                        gpu_count=1,
                        capacity_type=cap,
                        price_per_hour_usd=float(price),
                        price_source=_source(ctx, "runpod"),
                        as_of=ctx.as_of,
                        availability=avail,
                        extra={"stockStatus": stock},
                    )
                )
    return out


# ---- Vast.ai (marketplace offer search) ---------------------------------------------------


def vast(ctx: CollectContext) -> list[Offer]:
    t = target("vast")
    offers_raw: list[dict[str, Any]] = []
    if ctx.is_live("vast"):
        headers = {"Authorization": f"Bearer {ctx.secrets['vastApiKey']}"} if ctx.secrets.get("vastApiKey") else {}
        for name in t["gpuNames"]:
            q = {
                "gpu_name": {"eq": name},
                "num_gpus": {"eq": 1},
                "rentable": {"eq": True},
                "reliability2": {"gte": t["minReliability"]},
                "order": [["dph_total", "asc"]],
                "limit": 50,
            }
            body = http_json(ctx, "POST", VAST_URL, json=q, headers=headers)
            offers_raw.extend(body.get("offers", []))
    else:
        offers_raw = fixture("vast_offers.json")["offers"]
    ctx.record("vast", {"offers": offers_raw})
    # One catalog entry per (country, GPU): the cheapest rentable offer, with the count as availability.
    groups: dict[tuple[str, str], list[dict[str, Any]]] = {}
    for o in offers_raw:
        if not o.get("rentable") or int(o.get("num_gpus", 0)) != 1:
            continue
        country = (o.get("geolocation") or "").split(",")[-1].strip() or "XX"
        groups.setdefault((country, o["gpu_name"]), []).append(o)
    out = []
    for (country, name), group in sorted(groups.items()):
        o = min(group, key=lambda x: float(x["dph_total"]))
        gpu = gpu_key(name)
        if not gpu:
            continue
        offer = make_offer(
            provider="vast",
            region=country,
            instance_type=f"1x {name}",
            gpu_model=gpu,
            gpu_count=1,
            capacity_type="marketplace",
            price_per_hour_usd=float(o["dph_total"]),
            price_source=_source(ctx, "vast"),
            as_of=ctx.as_of,
            availability=Availability("live", count=len(group)),
            interruption_rate=rate_from_monthly_fraction(1 - float(o.get("reliability2") or 0.95)),
            extra={"offerId": o["id"], "reliability": o.get("reliability2")},
        )
        # Marketplace hosts can be withdrawn without notice: warning window 0, egress from the host.
        out.append(
            offer.with_(warningWindowSeconds=0.0, egressPerGbUsd=float(o.get("inet_up_cost") or offer.egressPerGbUsd))
        )
    return out


# ---- Static price tables (no public API) ---------------------------------------------------


def static(ctx: CollectContext) -> list[Offer]:
    rows = C.load_json("static_prices.json")["offers"]
    return [
        make_offer(
            provider=r["provider"],
            region=r["region"],
            instance_type=r["instanceType"],
            gpu_model=r["gpuModel"],
            gpu_count=r["gpuCount"],
            capacity_type=r["capacityType"],
            price_per_hour_usd=r["pricePerHourUsd"],
            price_source="static",
            as_of=r["asOf"],
            extra={"source": r["source"]},
        )
        for r in rows
    ]
