import json
from datetime import UTC, datetime

import httpx
import pytest

from router import collectors
from router import config as C
from router.catalog import aws_spot_rate, gpu_key, rate_from_monthly_fraction
from router.collectors import aws, others
from router.collectors.base import CollectContext
from router.service import Service

NOW = datetime(2026, 10, 24, 22, 0, tzinfo=UTC)


@pytest.fixture
def svc():
    s = Service()
    s.collect(ctx=CollectContext(now=NOW))
    return s


def test_mock_catalog_spans_providers_and_fleet_is_executable(svc):
    offers = svc.catalog()
    providers = {o.provider for o in offers}
    assert len(offers) >= 6
    assert {"moonshift", "aws", "azure", "vast"} <= providers
    executable = [o for o in offers if o.executable]
    assert len(executable) >= 4
    assert {o.provider for o in executable} >= {"moonshift", "aws", "azure", "vast"}
    # Only fleet entries are executable; e.g. Oracle and CoreWeave are priced but not runnable.
    assert not any(o.executable for o in offers if o.provider in {"oracle", "coreweave", "gcp", "lambda"})
    assert svc.errors == {}


def test_fleet_maps_onto_both_moonshift_pools(svc):
    pools = {e.moonshiftGpuId for e in svc.entries}
    assert pools == {"gpu-a", "gpu-b"}
    assert all(e.offerFound for e in svc.entries)


def test_usdc_price_adds_margin_for_external_only(svc):
    spot = svc.offers["aws#us-east-2#g4dn.xlarge#spot"]
    assert spot.price_per_hour_usdc() == pytest.approx(spot.pricePerHourUsd * (1 + C.margin()))
    a1 = svc.entry("gpu-a1").offer
    assert a1.provider == "moonshift"
    assert a1.price_per_hour_usdc() == pytest.approx(0.25)


def test_aws_spot_offer_blends_advisor_band_and_placement_score(svc):
    o = svc.offers["aws#us-east-2#g4dn.xlarge#spot"]
    # Advisor band 1 (5-10%) and placement score 7 (multiplier 0.8), from the verified fixtures.
    assert o.extra["advisorBand"] == 1
    assert o.availability.score == 7
    assert o.interruptionRatePerHour == pytest.approx(aws_spot_rate(1, 7))
    assert o.warningWindowSeconds == 120
    # Spot price = list price x (1 - 67% savings) in the cheaper AZ.
    assert o.pricePerHourUsd == pytest.approx(0.526 * 0.33, rel=1e-3)
    assert o.extra["availabilityZone"] == "us-east-2a"
    od = svc.offers["aws#us-east-2#g4dn.xlarge#on-demand"]
    assert od.pricePerHourUsd == pytest.approx(0.526)
    assert od.interruptionRatePerHour == 0 and od.warningWindowSeconds == 0


def test_worse_band_and_lower_score_mean_higher_rate():
    assert aws_spot_rate(4, 3) > aws_spot_rate(1, 7) > aws_spot_rate(0, 10)
    assert rate_from_monthly_fraction(0.3) == pytest.approx(0.000495, rel=0.01)


def test_azure_reads_linux_spot_and_skips_windows_and_low_priority(svc):
    o = svc.offers["azure#eastus#Standard_NC4as_T4_v3#spot"]
    assert o.pricePerHourUsd == pytest.approx(0.149174)  # real Retail Prices value, 2026-10-24
    assert o.warningWindowSeconds == 30  # Scheduled Events Preempt minimum notice


def test_vast_takes_cheapest_offer_per_country(svc):
    o = svc.offers["vast#US#1x RTX 4090#marketplace"]
    assert o.pricePerHourUsd == pytest.approx(0.402222, rel=1e-4)
    assert o.availability.status == "live" and o.availability.count == 1
    assert o.interruptionRatePerHour > 0 and o.warningWindowSeconds == 0


def test_lambda_without_capacity_is_marked_none(svc):
    a100 = [o for o in svc.catalog("lambda") if o.gpuModel == "A100"][0]
    assert a100.availability.status == "none"
    a10 = [o for o in svc.catalog("lambda") if o.gpuModel == "A10"][0]
    assert a10.availability.status == "live" and a10.region == "us-east-1"


def test_static_prices_carry_source_and_as_of(svc):
    cw = svc.catalog("coreweave")
    assert cw and all(o.priceSource == "static" and o.asOf.startswith("2026-10-24") for o in cw)
    h100 = [o for o in cw if o.gpuModel == "H100"][0]
    assert h100.to_dict()["pricePerGpuHourUsd"] == pytest.approx(49.24 / 8)


def test_catalog_filters(svc):
    assert {o.provider for o in svc.catalog(provider="azure")} == {"azure"}
    assert {o.gpuModel for o in svc.catalog(gpu_model="T4")} == {"T4"}


def test_gpu_name_mapping_prefers_longest_match():
    assert gpu_key("A100 (40 GB PCIe)") == "A100"
    assert gpu_key("A10 (24 GB PCIe)") == "A10"
    assert gpu_key("NVIDIA GeForce RTX 4090") == "RTX 4090"
    assert gpu_key("L40S") == "L40S"


def test_one_failing_collector_does_not_block_the_rest(monkeypatch):
    def boom(ctx):
        raise RuntimeError("provider down")

    broken = [
        c if c.name != "azure" else collectors.Collector("azure", "azure", "providers", boom)
        for c in collectors.COLLECTORS
    ]
    monkeypatch.setattr(collectors, "COLLECTORS", broken)
    offers, errors = collectors.run(ctx=CollectContext(now=NOW))
    assert "azure" in errors and "provider down" in errors["azure"]
    assert any(o.provider == "aws" for o in offers)


def test_live_azure_follows_next_page_link():
    pages = {
        "1": {
            "Items": [
                {
                    "armSkuName": "Standard_NC4as_T4_v3",
                    "armRegionName": "eastus",
                    "type": "Consumption",
                    "productName": "Virtual Machines NCasT4 v3 Series",
                    "meterName": "NC4as T4 v3 Spot",
                    "retailPrice": 0.2,
                }
            ],
            "NextPageLink": "https://prices.azure.com/api/retail/prices?p=2",
        },
        "2": {
            "Items": [
                {
                    "armSkuName": "Standard_NC4as_T4_v3",
                    "armRegionName": "eastus",
                    "type": "Consumption",
                    "productName": "Virtual Machines NCasT4 v3 Series",
                    "meterName": "NC4as T4 v3",
                    "retailPrice": 0.526,
                }
            ],
            "NextPageLink": None,
        },
    }

    def handler(req: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json=pages["2" if "p=2" in str(req.url) else "1"])

    ctx = CollectContext(now=NOW, transport=httpx.MockTransport(handler), live={"azure_retail": True})
    offers = others.azure(ctx)
    caps = {o.capacityType: o.pricePerHourUsd for o in offers if o.instanceType == "Standard_NC4as_T4_v3"}
    assert caps == {"spot": 0.2, "on-demand": 0.526}


def test_gcp_live_without_key_falls_back_to_fixture():
    ctx = CollectContext(now=NOW, live={"gcp_catalog": True})
    offers = others.gcp(ctx)
    assert offers and all(o.priceSource == "fixture" for o in offers)


class FakeAws:
    """Records boto3 calls; returns documented response shapes."""

    def __init__(self):
        self.calls = []

    def __call__(self, service, region_name):
        outer = self

        class Paginator:
            def paginate(self, **kw):
                outer.calls.append(("pricing.get_products", kw))
                fx = json.loads((C.FIXTURES_DIR / "aws_pricing_get_products.json").read_text())
                return [{"PriceList": fx["PriceList"]}]

        class Client:
            def get_paginator(self, name):
                return Paginator()

            def describe_spot_price_history(self, **kw):
                outer.calls.append((f"ec2.{region_name}.describe_spot_price_history", kw))
                return {
                    "SpotPriceHistory": [
                        {
                            "AvailabilityZone": f"{region_name}b",
                            "InstanceType": "g4dn.xlarge",
                            "ProductDescription": "Linux/UNIX",
                            "SpotPrice": "0.150000",
                            "Timestamp": NOW,
                        }
                    ]
                }

            def get_spot_placement_scores(self, **kw):
                outer.calls.append(("ec2.get_spot_placement_scores", kw))
                return {"SpotPlacementScores": [{"Region": r, "Score": 9} for r in kw["RegionNames"]]}

            def describe_instance_type_offerings(self, **kw):
                return {
                    "InstanceTypeOfferings": [
                        {"InstanceType": "g4dn.xlarge", "LocationType": "region", "Location": region_name}
                    ]
                }

        return Client()


def test_live_aws_spot_calls_documented_apis_read_only():
    fake = FakeAws()
    live = {k: True for k in ("aws_spot_price", "aws_placement", "aws_offerings")}
    ctx = CollectContext(now=NOW, boto_client=fake, live=live)
    offers = aws.collect_spot(ctx)
    o = [x for x in offers if x.region == "us-east-2"][0]
    assert o.pricePerHourUsd == 0.15 and o.availability.score == 9 and o.priceSource == "live"
    spot_call = [c for c in fake.calls if "describe_spot_price_history" in c[0]][0][1]
    assert spot_call["ProductDescriptions"] == ["Linux/UNIX"]
    placement = [c for c in fake.calls if c[0] == "ec2.get_spot_placement_scores"][0][1]
    assert placement["TargetCapacity"] == 1 and placement["SingleAvailabilityZone"] is False
