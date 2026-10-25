# Router price and availability sources (verified)

Owner: Lucy (services/router). Checked 2026-10-24 by reading each provider's
current docs and, where no account is needed, calling the endpoint read-only.
Trimmed real responses are kept as mock fixtures in
`services/router/router/collectors/fixtures/`, so mock shapes match reality.

Legend for "Probe": **called** = we hit the endpoint today without credentials
and got real data; **docs** = verified from documentation only (needs an
account or key we do not have).

## Summary

| Provider | Price source | Auth | Spot / on-demand | Live availability | Interruption warning | Probe |
|---|---|---|---|---|---|---|
| AWS | Price List Query API `GetProducts` | IAM (SigV4), endpoint in us-east-1 | on-demand list price | no | n/a | docs |
| AWS | EC2 `DescribeSpotPriceHistory` | IAM | spot, per AZ | no | n/a | docs |
| AWS | EC2 `GetSpotPlacementScores` | IAM | spot | 1 to 10 likelihood score | n/a | docs |
| AWS | EC2 `DescribeInstanceTypeOfferings` | IAM | which types exist per AZ | static offering | n/a | docs |
| AWS | EC2 `DescribeCapacityBlockOfferings` | IAM | reserved GPU blocks | offerings for dates | none (reserved) | docs |
| AWS | Spot Instance Advisor JSON | none | spot interruption band | no | **2 minutes** + earlier rebalance recommendation | called |
| AWS | Public bulk offer files | none | on-demand list price | no | n/a | called (index) |
| Azure | Retail Prices API | **none** | Consumption, Spot and Low Priority meters | no | **30 s minimum** (Scheduled Events `Preempt`) | called |
| Google Cloud | Cloud Billing Catalog API v2beta | **API key** | on-demand and preemptible SKUs | no | **0 s by default, up to 120 s if configured**; shutdown up to 30 s | docs (403 without key) |
| Oracle | Price list API (cetools products) | **none** | on-demand per GPU hour | no | not documented | called |
| Lambda | Cloud API `GET /api/v1/instance-types` | **API key** (Bearer) | on-demand | **yes**: regions with capacity | none (on-demand) | docs (401 without key) |
| RunPod | GraphQL `gpuTypes` | none for this query | on-demand (secure, community) | **yes**: `stockStatus` | spot window **not documented** | called |
| Vast.ai | `bundles` offer search | documented as Bearer key; unauthenticated GET answered | marketplace offers | **yes**: rentable offers | depends on host; not documented | called |
| CoreWeave and others | no public price API | n/a | static table in config | no | n/a | static |
| Moonshift | services/compute `/gpus`, `/gpus/{id}/calendar` | X-MS-Internal-Key | own price | **yes**: state + booked windows | the booking drain window (`DRAIN_LEAD_SECONDS`, default 20 s) | repo |

Where the prompt's assumptions differed from reality:
- **Google Cloud Spot notice is not 30 s by default.** The docs say the default
  preemption notice duration is 0 seconds (best-effort shutdown up to 30 s),
  and it can be set up to 120 seconds at VM creation. Our GCP workers must be
  created with a 120 s notice; the catalog uses 30 s as a conservative default.
- **Azure Spot eviction is 30 s minimum** (confirmed, Scheduled Events table).
- **Vast.ai search answered without a key**, but its docs say all endpoints need
  `Authorization: Bearer`. The adapter sends the key from Secrets Manager when
  present and never depends on anonymous access.
- **RunPod's current docs do not describe a spot warning window.** RunPod is
  priced on-demand only until that is documented.

## AWS

**Price List Query API (on-demand).** `pricing.GetProducts` with
`ServiceCode=AmazonEC2` and `TERM_MATCH` filters (`instanceType`, `regionCode`,
`operatingSystem=Linux`, `tenancy=Shared`, `preInstalledSw=NA`,
`capacitystatus=Used`). Returns `PriceList`, a list of JSON strings, each with
`product.attributes` and `terms.OnDemand.*.priceDimensions.*.pricePerUnit.USD`,
plus `NextToken`. Only `AND` matching. The API endpoint region is unrelated to
the product region; we call us-east-1. IAM: `pricing:GetProducts`.
Docs: https://docs.aws.amazon.com/awsaccountbilling/latest/aboutv2/using-price-list-query-api.html

**Public bulk offer files (no auth).**
`https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonEC2/current/region_index.json`
answered today; us-east-2 currently points at
`/offers/v1.0/aws/AmazonEC2/20261023221355/us-east-2/index.json` (very large).
Used only as a fallback for the daily on-demand refresh when no IAM role exists.

**DescribeSpotPriceHistory (spot).** Returns `SpotPriceHistory[]` with
`AvailabilityZone`, `InstanceType`, `ProductDescription`, `SpotPrice` (string),
`Timestamp`. Filter by instance type, `Linux/UNIX`, and a start time of now.
IAM: `ec2:DescribeSpotPriceHistory`.

**GetSpotPlacementScores.** Score 1 to 10 for how likely a Spot request
succeeds in a Region or AZ; "does not provide any guarantees in terms of
available capacity or risk of interruption". No additional charge. Limits:
target capacity limit based on recent Spot usage, a 24 hour cap on new request
configurations if usage looks unintended, and at least three instance types
unless the types are in the P, G, Trn or Inf families (ours are G). Output
`SpotPlacementScores[]` with `Region`, `AvailabilityZoneId`, `Score`.
IAM: `ec2:GetSpotPlacementScores`.
Docs: https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/spot-placement-score.html

**DescribeInstanceTypeOfferings.** Which instance types exist in which AZ
(`LocationType=availability-zone`). IAM: `ec2:DescribeInstanceTypeOfferings`.

**DescribeCapacityBlockOfferings (reserved GPU time).** Required
`CapacityDurationHours` (1-day increments to 14 days, 7-day increments to 182
days), optional `InstanceType`, `InstanceCount` (up to 64 per block),
`StartDateRange`, `EndDateRange`. Returns `capacityBlockOfferingSet[]`.
Tight throttle: bucket 10, refill 0.15 per second. Called daily at most.
Docs: https://docs.aws.amazon.com/AWSEC2/latest/APIReference/API_DescribeCapacityBlockOfferings.html

**EC2 API rate limits.** Token bucket per account and Region. Non-mutating
`Describe*`/`Get*`: bucket 100, refill 20 per second. `RunInstances`: bucket 5,
refill 2. We back off exponentially with jitter on `RequestLimitExceeded`.
Docs: https://docs.aws.amazon.com/AWSEC2/latest/APIReference/throttling.html

**Spot Instance Advisor (interruption frequency, no auth).**
`https://spot-bid-advisor.s3.amazonaws.com/spot-advisor-data.json`, about 1.2 MB.
`ranges` index 0 to 4 = `<5%`, `5-10%`, `10-15%`, `15-20%`, `>20%` (share of
instances interrupted over the last 30 days); `spot_advisor[region].Linux[type]`
= `{"s": savings_pct, "r": range_index}`. Today g4dn.xlarge in us-east-2 is
`{"s": 67, "r": 1}` (5-10%, 67% below on-demand). The page states the overall
average has historically been under 5%.

**Interruption signals.** Spot interruption notice: **two minutes** before stop
or terminate, delivered as the EventBridge event `EC2 Spot Instance
Interruption Warning` (source `aws.ec2`, `detail.instance-id`,
`detail.instance-action`) and at IMDS `meta-data/spot/instance-action`
(`{"action": "terminate", "time": "..."}`); AWS recommends polling every 5 s.
Rebalance recommendation: `EC2 Instance Rebalance Recommendation`, can arrive
earlier than the two-minute notice, IMDS `events/recommendations/rebalance`
(`{"noticeTime": "..."}`). Both are best effort.
Docs: https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/spot-instance-termination-notices.html,
https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/rebalance-recommendations.html

## Microsoft Azure

**Retail Prices API (no auth).** `GET https://prices.azure.com/api/retail/prices`
with OData `$filter` (`serviceName eq 'Virtual Machines' and armRegionName eq
'eastus' and contains(armSkuName,'NC4as_T4')`). Up to 1,000 records per page,
`NextPageLink` for the next. Spot meters are identified by `meterName` /
`skuName` ending in `Spot`; Linux rows have a `productName` without `Windows`;
`type` is `Consumption` for pay-as-you-go. Filter values are case sensitive in
newer API versions. No documented rate limit.
Today, eastus `Standard_NC4as_T4_v3` (1x T4) Linux: Spot **$0.149174/h**.
Docs: https://learn.microsoft.com/en-us/rest/api/cost-management/retail-prices/azure-retail-prices

**Eviction notice.** Scheduled Events at
`http://169.254.169.254/metadata/scheduledevents?api-version=2020-07-01`
(header `Metadata:true`), `EventType` `Preempt` for Spot evictions, minimum
notice **30 seconds**, best effort; poll once per second.
Docs: https://learn.microsoft.com/en-us/azure/virtual-machines/linux/scheduled-events

**Spot Placement Score** needs an Azure subscription: behind `AZURE_SPS=1`, off.

## Google Cloud

**Cloud Billing Catalog API.** Public SKUs and prices need an **API key**
(`?key=`); an unauthenticated call returns 403 "unregistered callers".
`GET https://cloudbilling.googleapis.com/v2beta/skus?filter=service="services/6F81-5844-456A"`
(Compute Engine), 50 per page by default, up to 5,000. Prices come from
`skus/{SKU_ID}/prices` (`rate.tiers[].listPrice` with `units` and `nanos`).
Preemptible vs on-demand shows up in taxonomy categories ("GPUs Preemptible").
No quota documented on that page.
Docs: https://docs.cloud.google.com/billing/docs/how-to/get-pricing-information-api

**Preemption notice.** Default notice duration 0 s; shutdown is best effort, up
to 30 s; configurable to 120 s at VM creation (recommended for workloads that
checkpoint). The VM's `preempted` metadata value turns `TRUE`.
Docs: https://docs.cloud.google.com/compute/docs/instances/spot

## Oracle Cloud

**Price list API.** `GET https://apexapps.oracle.com/pls/apex/cetools/api/v1/products/?currencyCode=USD`
(optional `partNumber`). The docs show no auth and our call worked without
credentials. 668 items today; GPU items have `metricName` `GPU Per Hour`, e.g.
A10 $2.00, A100 v2 $4.00, L40S $3.50, H100 $10.00 per GPU hour
(`currencyCodeLocalizations[0].prices[0].value`, model `PAY_AS_YOU_GO`).
No documented rate limit or pagination. OCI preemptible capacity is not priced
by this list; treated as on-demand.
Docs: https://docs.oracle.com/en-us/iaas/Content/Billing/Tasks/signingup_topic-Estimating_Costs.htm

## GPU marketplaces and neoclouds

**Lambda.** `GET https://cloud.lambda.ai/api/v1/instance-types`, header
`Authorization: Bearer <key>` (401 without). OpenAPI 1.10.0: each item is
`{instance_type: {name, description, gpu_description, price_cents_per_hour,
specs: {vcpus, memory_gib, storage_gib, gpus}}, regions_with_capacity_available: [...]}`.
Rate limit: about 1 request per second (launch: 1 per 12 s). On-demand only.
Docs: https://docs.lambda.ai/api/cloud

**RunPod.** GraphQL `POST https://api.runpod.io/graphql`, query `gpuTypes`
answered without a key: `securePrice`, `communityPrice`, `secureSpotPrice`,
`communitySpotPrice`, `lowestPrice(input:{gpuCount:1}){uninterruptablePrice,
minimumBidPrice, stockStatus}`. Today RTX 4090: secure $0.89, community $0.34,
stock `High`. Launching pods needs a key. Default spend limit $80/h.
Docs: https://docs.runpod.io/sdks/graphql/configurations.md

**Vast.ai.** Offer search `/api/v0/bundles/` (documented as `POST` with a JSON
body and a Bearer key; a `GET` with `q=` answered without a key today). Fields
we read: `gpu_name`, `num_gpus`, `dph_total` ($/h), `reliability2`,
`geolocation`, `rentable`, `inet_up_cost`, `inet_down_cost` (egress).
No rate limit documented.
Docs: https://docs.vast.ai/api-reference/search/search-offers

**CoreWeave and similar.** No public price API. Static table in
`services/router/config/static_prices.json` with `"priceSource": "static"` and
an `asOf` date.

## Moonshift GPUs

services/compute: `GET /gpus` (state `READY|SERVING|DRAINING|BOOKED|OFFLINE`)
and `GET /gpus/{id}/calendar?from=&to=` (`BOOKED|INFERENCE|HOLD` intervals).
The drain window opens `DRAIN_LEAD_SECONDS` (default 20) before a booking;
that is the "warning window" for a booking-triggered move.

## What runs without an account (MOCK vs live)

| Adapter | Runs live with no account | Needs | Default |
|---|---|---|---|
| aws_spot_advisor | yes | nothing | live when `PRICE_SOURCES` includes it |
| azure_retail | yes | nothing | live |
| oracle | yes | nothing | live |
| runpod | yes (price + stock) | key to launch | live |
| vast | yes today | key per docs | live with key, else mock |
| aws_pricing, aws_spot_price, aws_placement, aws_offerings, aws_capacity_blocks | no | AWS credentials (default chain) | mock |
| gcp_catalog | no | API key in Secrets Manager | mock |
| lambda | no | API key in Secrets Manager | mock |
| moonshift | yes | compute running | live when compute answers |
